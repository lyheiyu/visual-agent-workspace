import { PromptAttachment, validateAttachments } from './attachments';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentController } from '../controller/AgentController';
import { CodexAppServerAdapter, stdioConnector } from '../adapters/codex/CodexAppServerAdapter';
import { locateCodex } from '../adapters/codex/codexLocator';
import { CodexProfileId, getProfile } from '../adapters/codex/profiles';
import { StreamingAgentAdapter } from '../adapters/AgentAdapter';
import { OpenCodeAdapter } from './opencode/OpenCodeAdapter';
import { locateOpenCode, OpenCodeLaunch } from './opencode/OpenCodeServer';
import { OpenCodeServerManager } from './opencode/OpenCodeServerManager';
import { ClaudeCodeAdapter } from './claude/ClaudeCodeAdapter';
import { claudeSdkEntry, loadClaudeQuery } from './claude/claudeSdk';
import {
  claudeProviderInfo,
  codexProfiles,
  discoverClaudeModels,
  discoverCodexModels,
  discoverOllamaCodingModels,
  loadedOllamaModels,
  LOCAL_PROFILES,
  ModelOption,
  ProviderId,
  ProviderInfo,
  unloadOllamaModel,
} from './providers';
import { CodeNavigator } from '../navigation/CodeNavigator';
import { EventRecorder } from '../recorder/EventRecorder';
import { continuationContext } from '../recorder/conversation';
import { showProjectFolder, PROJECT_TRANSFER_KEY, ProjectTransfer } from '../navigation/ProjectWorkspace';
import { ClaudeRuntime, resolveClaudeRuntime, ClaudeAuthMode } from './claude/claudeRuntime';

export interface TaskSelection {
  provider: ProviderId;
  model: string;
  effort?: string;
  profile: string;
  workspaceRoot: string;
  instructions: string;
  claudeAuthKind?: 'subscription' | 'api-key' | 'cloud';
}

const LAST_KEY = 'visualAgent.lastAgentSelection.v1';

/**
 * Provider/model discovery and task start for the unified New Agent Task UI.
 * Discovery uses provider APIs only (no inference). Model lists are fetched
 * when a provider is selected, never at activation.
 */
export class AgentLauncher {
  private readonly modelCache = new Map<string, ModelOption[]>();
  private readonly pendingSave = new Map<string, TaskSelection>();
  private claudeRuntime?: ClaudeRuntime;
  /** The local OpenCode server: started when needed, reused, monitored, stopped only if this window owns it. */
  readonly opencode: OpenCodeServerManager;

  private async resolveClaude(): Promise<ClaudeRuntime> {
    return this.claudeRuntime = await resolveClaudeRuntime(process.env, this.cfg().get<string>('claude.executablePath', '').trim() || undefined, this.cfg().get<ClaudeAuthMode>('claude.authMode', 'auto'));
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly navigator: CodeNavigator,
    private readonly log: vscode.OutputChannel,
    private readonly recorder: EventRecorder,
    private readonly localInferenceBusy: () => boolean = () => false,
  ) {
    this.opencode = new OpenCodeServerManager({
      stateFile: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'opencode-server.json'),
      log: (line) => log.appendLine(line),
      idleStopMs: Math.max(0, this.cfg().get<number>('local.server.idleStopMinutes', 15)) * 60_000,
    });
    controller.onDidChangeState((s) => {
      // Remember a selection only once its task completed successfully.
      if (s.taskId && s.taskStatus !== 'Running') {
        const sel = this.pendingSave.get(s.taskId);
        this.pendingSave.delete(s.taskId);
        if (sel && s.taskStatus === 'Completed') {
          void this.remember(sel);
        }
      }
    });
  }

  private cfg() {
    return vscode.workspace.getConfiguration('visualAgent');
  }

  showProject(root: string, reveal = true, selection?: Partial<TaskSelection>): Promise<boolean> {
    return showProjectFolder(root, reveal, {
      file: vscode.Uri.joinPath(this.context.globalStorageUri, 'projects.code-workspace'),
      beforeReload: async (workspaceFile) => {
        if (this.controller.isActive) {
          if (!this.controller.getSnapshot().awaitingInput) throw new Error('请先等本轮完成或停止，再打开新的项目工作区。 / Finish or stop the active turn before opening a different workspace.');
          await this.controller.endSession(); await this.controller.whenIdle();
        }
        const transfer: ProjectTransfer = { workspaceFile, history: this.recorder.exportHistory(), taskId: this.context.workspaceState.get<string>('visualAgent.selectedConversation'), selection };
        transfer.revealObserver = reveal;
        await this.context.globalState.update(PROJECT_TRANSFER_KEY, transfer);
      },
    });
  }

  private ollamaEndpoint(): string {
    return this.cfg().get<string>('local.ollamaEndpoint', '') || this.cfg().get<string>('reviewer.endpoint', 'http://127.0.0.1:11434');
  }

  async providers(): Promise<ProviderInfo[]> {
    const claude = await this.resolveClaude();
    const codex = locateCodex(this.cfg().get<string>('codex.executablePath', '').trim() || undefined);
    const opencode = locateOpenCode(this.cfg().get<string>('local.opencodePath', '').trim() || undefined, this.context.extensionUri.fsPath);
    let ollamaOk = false;
    let ollamaError = '';
    try {
      const r = await fetch(`${this.ollamaEndpoint().replace(/\/+$/, '')}/api/version`, { signal: AbortSignal.timeout(3000) });
      ollamaOk = r.ok;
    } catch (err) {
      ollamaError = (err as Error).message;
    }
    return [
      {
        id: 'codex',
        displayName: 'Codex (App Server)',
        experimental: false,
        available: !!codex,
        reason: codex ? undefined : 'Codex CLI not found (npm install -g @openai/codex, then codex login).',
        auth: codex ? 'Codex login (~/.codex)' : undefined,
        profiles: codexProfiles(),
      },
      claudeProviderInfo(claude.env, !!claudeSdkEntry(this.context.extensionUri.fsPath), claude.authentication),
      {
        id: 'local',
        displayName: 'Local agent (OpenCode + Ollama)',
        experimental: false,
        available: !!opencode && ollamaOk,
        reason: !opencode
          ? 'OpenCode runtime not found (npm install -g opencode-ai, or set visualAgent.local.opencodePath).'
          : !ollamaOk
            ? `Ollama is not reachable at ${this.ollamaEndpoint()}${ollamaError ? ` (${ollamaError})` : ''}.`
            : undefined,
        auth: 'none (local inference only)',
        profiles: LOCAL_PROFILES,
      },
    ];
  }

  async models(provider: ProviderId, workspaceRoot: string, refresh = false): Promise<ModelOption[]> {
    const key = `${provider}:${workspaceRoot}`;
    if (!refresh && this.modelCache.has(key)) {
      return this.modelCache.get(key)!;
    }
    let models: ModelOption[] = [];
    if (provider === 'codex') {
      const loc = locateCodex(this.cfg().get<string>('codex.executablePath', '').trim() || undefined);
      if (!loc) {
        throw new Error('Codex CLI not found.');
      }
      models = await discoverCodexModels(loc, workspaceRoot);
    } else if (provider === 'local') {
      models = await discoverOllamaCodingModels(this.ollamaEndpoint());
    } else {
      const runtime = await this.resolveClaude();
      if (!runtime.authentication.ok) throw new Error(runtime.authentication.reason);
      models = await discoverClaudeModels(await loadClaudeQuery(this.context.extensionUri.fsPath), workspaceRoot, runtime.env, runtime.executable);
    }
    this.modelCache.set(key, models);
    return models;
  }

  lastSelection(): { provider?: ProviderId; byProvider: Partial<Record<ProviderId, { model: string; effort?: string; profile: string }>> } {
    return this.context.globalState.get(LAST_KEY, { byProvider: {} });
  }

  private async remember(sel: TaskSelection): Promise<void> {
    const prev = this.lastSelection();
    await this.context.globalState.update(LAST_KEY, {
      provider: sel.provider,
      byProvider: { ...prev.byProvider, [sel.provider]: { model: sel.model, effort: sel.effort, profile: sel.profile } },
    });
  }

  /** Validate, guard local resources, build the adapter and start the task. */
  async start(sel: TaskSelection): Promise<string | undefined> {
    if (sel.provider === 'local' && this.localInferenceBusy()) throw new Error('The local reviewer is working. Wait for it to finish before starting the coding agent.');
    if (this.controller.isActive && !this.controller.getSnapshot().awaitingInput) {
      throw new Error('A task is already running. Stop it first.');
    }
    if (!sel.instructions.trim()) {
      throw new Error('Enter task instructions.');
    }
    let claude: ClaudeRuntime | undefined;
    if (sel.provider === 'claude-code') {
      claude = await this.resolveClaude();
      if (!claude.authentication.ok) throw new Error(claude.authentication.reason);
    }
    const models = await this.models(sel.provider, sel.workspaceRoot);
    const m = models.find((x) => x.id === sel.model);
    if (!m) {
      throw new Error(`Model "${sel.model}" was not reported by the provider; it will not be substituted.`);
    }
    if (!m.compatible) {
      throw new Error(`Model "${sel.model}" cannot run the coding agent: ${m.reason}.`);
    }
    if (sel.effort && m.efforts?.length && !m.efforts.includes(sel.effort)) {
      throw new Error(`Effort "${sel.effort}" is not supported by ${sel.model}.`);
    }
    if (sel.provider === 'local' && !(await this.confirmLocalResources(sel.model, m))) {
      return undefined;
    }
    if (this.controller.isActive) {
      if (!this.controller.getSnapshot().awaitingInput) throw new Error('Another conversation started working. Wait for it to finish.');
      await this.controller.endSession();
      await this.controller.whenIdle();
    }
    if (!(await this.showProject(sel.workspaceRoot, true, sel))) return undefined;
    const adapter = this.createAdapter(sel, m, undefined, claude);
    this.navigator.setRoot(sel.workspaceRoot);
    const taskId = this.controller.start(sel.instructions.trim(), adapter, sel.workspaceRoot);
    this.recorder.setLaunch(taskId, { provider: sel.provider, model: sel.model, effort: sel.effort, profile: sel.profile, workspaceRoot: sel.workspaceRoot, ...(sel.provider === 'claude-code' ? { claudeAuthKind: claude?.authentication.kind } : {}) });
    this.pendingSave.set(taskId, sel);
    this.log.appendLine(`[launcher] ${sel.provider} task ${taskId}: model=${sel.model}${sel.effort ? ` effort=${sel.effort}` : ''} profile=${sel.profile} root=${sel.workspaceRoot}`);
    return taskId;
  }

  /** Continue the selected conversation, preserving its visible identity and recorded turns. */
  async send(taskId: string, text: string, useSavedContext = false, files?: PromptAttachment[]): Promise<boolean> {
    const attachments = validateAttachments(files);
    const instruction = (text.trim() || (attachments.length ? "Please review the attachments." : "")) + (attachments.length ? "\n\nAttachments: " + attachments.map((a) => a.name).join(", ") : "");
    if (!instruction || instruction.length > 4000) throw new Error('Enter a message of 1–4000 characters.');
    const task = this.recorder.getTask(taskId);
    if (!task) throw new Error('Conversation not found.');
    if (task.source === 'local' && attachments.some((a) => a.mime.startsWith('image/'))) {
      const response = await fetch(`${this.ollamaEndpoint().replace(/\/+$/, '')}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: task.launch?.model }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('无法确认本地模型是否支持图片，请稍后重试。');
      const info = await response.json() as { capabilities?: string[] };
      if (!info.capabilities?.includes('vision')) throw new Error('当前本地模型不支持图片。请使用支持视觉的模型，或移除图片。 / This local model does not support images.');
    }
    const project = task.workspaceRoot ?? task.launch?.workspaceRoot;
    if (project && !(await this.showProject(project, false))) return false;
    if (task.source === 'local' && this.localInferenceBusy()) throw new Error('The local reviewer is working. Wait for it to finish, then continue with this same coding model.');
    const snapshot = this.controller.getSnapshot();
    if (this.controller.isActive) {
      if (!snapshot.awaitingInput || snapshot.pendingApprovals.length) throw new Error('Wait for the active turn or its approval before sending another message.');
      if (snapshot.taskId === taskId) {
        // Same live native session: a new turn, plus a note only if files the agent saw have changed.
        await this.controller.steer(instruction, attachments, this.sessions?.changeNote(taskId) ?? '');
        return true;
      }
      await this.controller.endSession();
      await this.controller.whenIdle();
    }
    await this.controller.whenIdle();
    if (!task.launch) throw new Error('This older task has no saved model/project settings. Use “Continue from history” to configure a new task.');
    const selection: TaskSelection = { ...task.launch, instructions: instruction };
    const models = await this.models(selection.provider, selection.workspaceRoot);
    let claude: ClaudeRuntime | undefined;
    if (selection.provider === 'claude-code') {
      const mode = selection.claudeAuthKind === 'subscription' ? 'subscription' : selection.claudeAuthKind ? 'api' : this.cfg().get<ClaudeAuthMode>('claude.authMode', 'auto');
      claude = await resolveClaudeRuntime(process.env, this.cfg().get<string>('claude.executablePath', '').trim() || undefined, mode);
      if (!claude.authentication.ok || selection.claudeAuthKind && claude.authentication.kind !== selection.claudeAuthKind) throw new Error('The saved Claude authentication mode is unavailable. No billing mode was substituted.');
    }
    const model = models.find((m) => m.id === selection.model && m.compatible);
    if (!model) throw new Error(`Saved model ${selection.model} is unavailable; no model was substituted. Start a new conversation to choose another model.`);
    if (selection.provider === 'local' && !(await this.confirmLocalResources(selection.model, model))) return false;
    // Only this conversation's own native session, and only for the same provider (never another agent's thread).
    const own = task.session && task.session.provider === selection.provider ? task.session : undefined;
    const nativeSession = !useSavedContext ? own?.id : undefined;
    const reason = nativeSession ? undefined : useSavedContext ? 'continuing with saved context was chosen' : task.session ? `the recorded session belongs to ${task.session.provider}` : 'no native session was recorded for this conversation';
    // Compact, labelled summary for a new session (used directly, or by the adapter if resuming fails).
    const reconstruct = (why?: string) => (this.sessions ? this.sessions.reconstructedContext(task, this.recorder.getOperations(taskId), why) : continuationContext(task, this.recorder.getOperations(taskId)));
    const prompt = nativeSession ? (this.sessions?.changeNote(taskId) ?? '') + instruction : reconstruct(reason) + instruction;
    this.navigator.setRoot(selection.workspaceRoot);
    this.controller.start(prompt, this.createAdapter(selection, model, nativeSession, claude, { reconstructedContext: reconstruct, reason, originalRequirements: task.description }), selection.workspaceRoot, { taskId, userMessage: instruction, attachments });
    this.pendingSave.set(taskId, selection);
    this.log.appendLine(`[launcher] continuing ${taskId}: ${nativeSession ? `resuming native ${selection.provider} session ${nativeSession}` : `new ${selection.provider} session with reconstructed context (${reason})`}; model=${selection.model}`);
    return true;
  }

  /** Lightweight per-conversation context (change notes, reconstructed summaries, continuity metrics). */
  sessions: import('./sessionContext').SessionContextTracker | undefined;

  createAdapter(
    sel: TaskSelection,
    m: ModelOption,
    resumeSessionId?: string,
    claude = this.claudeRuntime,
    continuation?: { reconstructedContext: (reason?: string) => string; reason?: string; originalRequirements?: string },
  ): StreamingAgentAdapter {
    if (sel.provider === 'codex') {
      const loc = locateCodex(this.cfg().get<string>('codex.executablePath', '').trim() || undefined)!;
      return new CodexAppServerAdapter({
        connector: stdioConnector(loc),
        profile: getProfile(sel.profile as CodexProfileId),
        model: sel.model,
        effort: sel.effort,
        resumeThreadId: resumeSessionId,
        reconstructedContext: continuation?.reconstructedContext,
        reconstructedReason: resumeSessionId ? undefined : continuation?.reason,
        maxTurnMs: Math.max(1, this.cfg().get<number>('codex.maxTurnMinutes', 30)) * 60_000,
        clientVersion: String(this.context.extension.packageJSON.version ?? '0.4.0'),
      });
    }
    if (sel.provider === 'local') {
      return new OpenCodeAdapter({
        resumeSessionId,
        workflow: this.cfg().get<'plan-files' | 'direct'>('local.workflow', 'plan-files'),
        originalRequirements: continuation?.originalRequirements,
        diagnostics: (absolutePath) => vscode.languages.getDiagnostics(vscode.Uri.file(absolutePath))
          .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
          .map((diagnostic) => diagnostic.message),
        connector: this.opencode.connector,
        launch: this.localLaunch(sel, m),
        reconstructedReason: resumeSessionId ? undefined : continuation?.reason,
      });
    }
    return new ClaudeCodeAdapter({
      loadQuery: () => loadClaudeQuery(this.context.extensionUri.fsPath),
      model: sel.model,
      effort: sel.effort,
      profile: sel.profile === 'approved-write' ? 'approved-write' : 'read-only',
      env: claude?.env ?? process.env,
      authentication: claude?.authentication,
      pathToClaudeCodeExecutable: claude?.executable,
      resumeSessionId,
      reconstructedContext: continuation?.reconstructedContext,
      reconstructedReason: resumeSessionId ? undefined : continuation?.reason,
    });
  }

  /** OpenCode server settings for a local-agent selection (identical settings → the same, reused server). */
  localLaunch(sel: Pick<TaskSelection, 'model' | 'profile' | 'workspaceRoot'>, m: ModelOption): OpenCodeLaunch {
    const exe = locateOpenCode(this.cfg().get<string>('local.opencodePath', '').trim() || undefined, this.context.extensionUri.fsPath);
    if (!exe) throw new Error('OpenCode runtime not found (npm install -g opencode-ai, or set visualAgent.local.opencodePath).');
    const configured = Math.max(4096, this.cfg().get<number>('local.contextLimit', 32768));
    const contextLimit = m.contextLength ? Math.min(configured, m.contextLength) : configured;
    return {
      executable: exe,
      homeDir: path.join(this.context.globalStorageUri.fsPath, 'opencode-home'),
      workspaceRoot: sel.workspaceRoot,
      ollamaBaseUrl: this.ollamaEndpoint(),
      model: sel.model,
      contextLimit,
      outputLimit: Math.min(Math.max(1024, this.cfg().get<number>('local.outputLimit', 8192)), Math.max(1, Math.floor(contextLimit / 4))),
      profile: sel.profile === 'approved-write' ? 'approved-write' : 'read-only',
    };
  }

  /**
   * Start the OpenCode server now with the last local-agent settings (status
   * menu, or `visualAgent.local.server.autoStart = onActivation`). Uses the
   * Ollama model list only (no inference). Returns why it did not start.
   */
  async startLocalServer(): Promise<string | undefined> {
    const last = this.lastSelection().byProvider.local;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!last) return 'No local-agent task has been started yet, so there are no model/profile settings to start the server with. It starts automatically with the first local-agent task.';
    if (!root) return 'Open a folder first.';
    const m = (await this.models('local', root)).find((x) => x.id === last.model);
    if (!m) return `The last local model "${last.model}" is not available in Ollama; it will not be substituted.`;
    await this.opencode.ensure(this.localLaunch({ model: last.model, profile: last.profile, workspaceRoot: root }, m));
    return undefined;
  }

  /** Never load a second large local model without the user's say-so. */
  private async confirmLocalResources(model: string, m: ModelOption): Promise<boolean> {
    let loaded: Awaited<ReturnType<typeof loadedOllamaModels>> = [];
    try {
      loaded = await loadedOllamaModels(this.ollamaEndpoint());
    } catch {
      return true; // ps unavailable: Ollama will report errors itself
    }
    const others = loaded.filter((x) => x.name !== model);
    if (!others.length) {
      return true;
    }
    const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
    const list = others.map((o) => `${o.name} (${gb(o.size)})`).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `Ollama already has ${list} loaded. Starting the local agent loads ${model}${m.sizeBytes ? ` (~${gb(m.sizeBytes)} on disk, more with context)` : ''} as well.`,
      { modal: true },
      'Unload Others and Start',
      'Start Anyway',
    );
    if (choice === 'Unload Others and Start') {
      for (const o of others) {
        await unloadOllamaModel(this.ollamaEndpoint(), o.name).catch(() => undefined);
      }
      return true;
    }
    return choice === 'Start Anyway';
  }
}
