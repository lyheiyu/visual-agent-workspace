import * as vscode from 'vscode';
import { MockAgentAdapter } from './adapters/MockAgentAdapter';
import { DEMO_TASK_TITLE } from './adapters/demoScenario';
import { AgentController, defaultApprovalPolicy, strictApprovalPolicy } from './controller/AgentController';
import { EventRecorder, HistoryStorage, PersistedHistory, mergeHistory } from './recorder/EventRecorder';
import { CodeNavigator } from './navigation/CodeNavigator';
import { ChangeReviewManager } from './review/ChangeReviewManager';
import { HumanControlManager } from './control/HumanControlManager';
import { ActivityViewProvider } from './ui/ActivityViewProvider';
import { CommandTreeProvider } from './ui/CommandTreeProvider';
import { RecordDocumentProvider } from './ui/RecordDocumentProvider';
import { CodexAppServerAdapter, stdioConnector } from './adapters/codex/CodexAppServerAdapter';
import { locateCodex } from './adapters/codex/codexLocator';
import { CodexProfileId, getProfile } from './adapters/codex/profiles';
import { ReviewService } from './reviewer/ReviewService';
import { ReviewerController } from './reviewer/ReviewerController';
import { ReviewerViewProvider } from './reviewer/ReviewerViewProvider';
import { ExportController } from './export/ExportController';
import { AgentLauncher } from './agents/AgentLauncher';
import { OpenCodeServerStatus } from './agents/opencode/OpenCodeServerStatus';
import { SessionContextTracker } from './agents/sessionContext';
import { NewTaskPanel } from './agents/NewTaskPanel';
import { ProviderId } from './agents/providers';
import { continuationContext } from './recorder/conversation';
import { ConversationPanel } from './ui/ConversationPanel';
import * as path from 'node:path';
import { isInside } from './navigation/pathSafety';
import { selectProjectRoot, PROJECT_TRANSFER_KEY, ProjectTransfer } from './navigation/ProjectWorkspace';
import { ReferenceNavigator } from './references/ReferenceNavigator';
import { ExplainController } from './reviewer/ExplainController';
import { ManualChanges } from './review/ManualChanges';

const HISTORY_KEY = 'visualAgent.history.v1';

/**
 * Extension entry point: wires the modules together.
 *
 *   MockAgentAdapter ──► AgentController ──► EventRecorder ──► UI
 *                             ▲                                  │
 *                             └──── HumanControlManager ◄────────┘
 *
 * To integrate a real agent, construct a different AgentAdapter here; no UI
 * code needs to change.
 */
/** Returned from activate() for integration tests and future companion extensions. */
export interface VisualAgentApi {
  controller: AgentController;
  recorder: EventRecorder;
  /** Start a Codex task without UI prompts (used by integration tests). */
  startCodex(instructions: string, profile: CodexProfileId): string;
  reviewer: ReviewService;
  reviewerController: ReviewerController;
  exporter: ExportController;
  controls: HumanControlManager;
  launcher: AgentLauncher;
  explainer: ExplainController;
  manual: ManualChanges;
  sessions: SessionContextTracker;
}

export function activate(context: vscode.ExtensionContext): VisualAgentApi {
  const log = vscode.window.createOutputChannel('Visual Agent Workspace');
  context.subscriptions.push(log);

  // History persists in workspaceState (VS Code storage), never in workspace files.
  const candidate = context.globalState.get<ProjectTransfer>(PROJECT_TRANSFER_KEY);
  const transfer = candidate && vscode.workspace.workspaceFile?.scheme === 'file' && path.relative(candidate.workspaceFile, vscode.workspace.workspaceFile.fsPath) === '' ? candidate : undefined;
  const storage: HistoryStorage = {
    load: () => {
      const saved = context.workspaceState.get<PersistedHistory>(HISTORY_KEY);
      return transfer ? mergeHistory(saved, transfer.history) : saved;
    },
    save: (h) => context.workspaceState.update(HISTORY_KEY, h),
  };
  const recorder = new EventRecorder(storage, { persistDebounceMs: 750 });
  if (transfer) void Promise.resolve(storage.save(recorder.exportHistory())).then(() => context.globalState.update(PROJECT_TRANSFER_KEY, undefined));
  const config = () => vscode.workspace.getConfiguration('visualAgent');

  const mock = new MockAgentAdapter();
  const controller = new AgentController(mock, recorder, {
    stepDelayMs: () => config().get<number>('stepDelayMs', 1500),
    approvalPolicy: () =>
      config().get<boolean>('requireApprovalForCommands', false) ? strictApprovalPolicy : defaultApprovalPolicy,
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    log: (m) => log.appendLine(m),
  });

  const navigator = new CodeNavigator(log);
  // Clickable file references in conversations/explanations (opens editors only; never runs anything).
  const references = new ReferenceNavigator(
    navigator,
    (taskId) => {
      const task = taskId ? recorder.getTask(taskId) : undefined;
      return task?.workspaceRoot ?? task?.launch?.workspaceRoot;
    },
    log,
  );
  references.registerCommands();
  const review = new ChangeReviewManager(navigator, log);
  const records = new RecordDocumentProvider(recorder);
  // A fresh adapter (and app-server process) per Codex task.
  const startCodex = (instructions: string, profileId: CodexProfileId): string => {
      const configured = config().get<string>('codex.executablePath', '').trim();
      const location = locateCodex(configured || undefined);
      if (!location) {
        throw new Error(
          configured
            ? `visualAgent.codex.executablePath does not point to a native Codex binary: ${configured}`
            : 'Codex CLI not found. Install it with "npm install -g @openai/codex" or set visualAgent.codex.executablePath.',
        );
      }
      log.appendLine(`[codex] using ${location.executable} (${location.source})`);
      const adapter = new CodexAppServerAdapter({
        connector: stdioConnector(location),
        profile: getProfile(profileId),
        model: config().get<string>('codex.model', '').trim() || undefined,
        maxTurnMs: Math.max(1, config().get<number>('codex.maxTurnMinutes', 30)) * 60_000,
        clientVersion: String(context.extension.packageJSON.version ?? '0.2.0'),
      });
      return controller.start(instructions, adapter);
  };
  const controls = new HumanControlManager(context, controller, recorder, navigator, review, log, {
    demo: () => controller.start(DEMO_TASK_TITLE, mock),
    codex: startCodex,
  });
  controls.registerCommands();
  if (transfer?.taskId) controls.selectTask(transfer.taskId);

  // ---- Layer B: optional Local AI Reviewer (Ollama). Independent of agent tracking:
  // it never runs unless the user asks, and Layer A works identically without it.
  const reviewerCfg = () => vscode.workspace.getConfiguration('visualAgent.reviewer');
  const reviewer = new ReviewService({
    enabled: () => reviewerCfg().get<boolean>('enabled', true),
    endpoint: () => reviewerCfg().get<string>('endpoint', 'http://127.0.0.1:11434'),
    allowRemote: () => reviewerCfg().get<boolean>('allowRemoteEndpoint', false),
    preferredModel: () => reviewerCfg().get<string>('model', ''),
    thinking: () => reviewerCfg().get<'off' | 'low' | 'on'>('thinking', 'off'),
    contextWindow: () => reviewerCfg().get<number>('contextWindow', 8192),
  });
  const reviewerController = new ReviewerController(reviewer, recorder, review, log, () => controls.getSelection().operationId);
  reviewerController.registerCommands();
  // Explain Code in Detail: same local reviewer service; runs only on explicit user action.
  const explainer = new ExplainController(context, reviewerController, references, navigator, log, () => controls.language());
  explainer.registerCommands();
  const selectionLabel = () => {
    const id = controls.getSelection().operationId;
    const op = id ? recorder.getOperation(id) : undefined;
    return op ? `#${op.sequenceNumber} ${op.operationType}: ${op.description}` : undefined;
  };
  const reviewerView = new ReviewerViewProvider(
    context.extensionUri,
    reviewer,
    reviewerController,
    () => reviewerCfg().get<boolean>('enabled', true),
    selectionLabel,
    () => controls.language(),
    (lang) => controls.setLanguage(lang),
  );
  const exporter = new ExportController(recorder, review, reviewerController, () => controls.getSelection());
  exporter.registerCommands();
  const setReviewerContext = () =>
    void vscode.commands.executeCommand('setContext', 'visualAgent.reviewerEnabled', reviewerCfg().get<boolean>('enabled', true));
  setReviewerContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('visualAgent.language')) {
        controls.refreshView();
        reviewerView.refresh();
      }
      if (e.affectsConfiguration('visualAgent.reviewer')) {
        setReviewerContext();
        if (!reviewerCfg().get<boolean>('enabled', true)) {
          reviewer.cancel();
        }
        reviewerView.resetDiscovery();
        controls.refreshView();
      }
    }),
    controls.onDidChangeView(() => reviewerView.refresh()),
  );

  // ---- v0.4: unified provider/model selection (Codex, Claude Code, local agent)
  const launcher = new AgentLauncher(context, controller, navigator, log, recorder, () => reviewer.getState().busy);
  // Per-conversation context record: files the agent saw (fingerprints only), continuity and usage counters.
  const sessions = new SessionContextTracker(recorder, { storeFile: path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'session-context.json'), log: (l) => log.appendLine(l) });
  launcher.sessions = sessions;
  const sessionSub = controller.onDidSessionEvent((e) => {
    if (e.kind === 'session') sessions.noteSession(e.taskId, e.session);
    else if (e.kind === 'usage') sessions.noteUsage(e.taskId, e.usage);
    else sessions.noteNativeTurn(e.taskId);
  });
  context.subscriptions.push({ dispose: () => { sessionSub.dispose(); sessions.dispose(); } });
  // Local OpenCode server: status bar, Restart/Stop/Show log; stopped on deactivation only if this window started it.
  const serverStatus = new OpenCodeServerStatus(launcher.opencode, log, () => launcher.startLocalServer(), () => !!launcher.lastSelection().byProvider.local);
  context.subscriptions.push(serverStatus, { dispose: () => launcher.opencode.dispose() });
  if (vscode.workspace.getConfiguration('visualAgent').get<string>('local.server.autoStart', 'onDemand') === 'onActivation') {
    void launcher.startLocalServer().then(
      (why) => why && log.appendLine(`[opencode] not started on activation: ${why}`),
      (err) => log.appendLine(`[opencode] start on activation failed: ${(err as Error).message}`),
    );
  }
  // "Check my changes" / "Continue from my changes": same conversation, same coding model.
  const manual = new ManualChanges(
    recorder,
    controller,
    (taskId, text) => launcher.send(taskId, text),
    log,
    controls.proposals.onDidApplyUserVersion,
    vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'review-baselines.json'),
  );
  controls.proposals.setManualEditGuard(manual);
  context.subscriptions.push(manual);
  const manualCommand = (kind: 'check' | 'continue') => async (taskId?: unknown) => {
    const id = typeof taskId === 'string' && recorder.getTask(taskId) ? taskId : controls.getSelection().taskId;
    if (!id) return void vscode.window.showInformationMessage('Select a conversation first.');
    try {
      const r = kind === 'check' ? await manual.check(id) : await manual.continueFrom(id);
      if (!r.sent && r.reason) void vscode.window.showInformationMessage(r.reason);
      if (r.sent) await vscode.commands.executeCommand('visualAgent.openConversations', id);
      return r;
    } catch (err) {
      void vscode.window.showWarningMessage((err as Error).message);
      return { sent: false, reason: (err as Error).message };
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('visualAgent.checkMyChanges', manualCommand('check')),
    vscode.commands.registerCommand('visualAgent.continueFromMyChanges', manualCommand('continue')),
  );
  if (transfer) {
    const restore = setTimeout(() => {
      if (transfer.selection) NewTaskPanel.show(context.extensionUri, launcher, () => controls.language(), () => reviewer.getState().selectedModel, transfer.selection.provider, transfer.selection);
      else void vscode.commands.executeCommand('visualAgent.openConversations', transfer.taskId);
      if (transfer.revealObserver) {
        void vscode.commands.executeCommand('workbench.view.explorer')
          .then(() => vscode.commands.executeCommand('visualAgent.showActivityBeside'))
          .then(undefined, (err) => log.appendLine(`[activity] restore failed: ${err}`));
      }
    }, 150);
    context.subscriptions.push({ dispose: () => clearTimeout(restore) });
  }
  let sourceEditor = vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor : vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        sourceEditor = editor;
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (folder) selectProjectRoot(folder.uri.fsPath);
      }
    }),
    vscode.commands.registerCommand('visualAgent.openConversations', (taskId?: string) => {
      return ConversationPanel.show(context.extensionUri, recorder, controller, launcher, controls, references, manual, taskId ?? controls.getSelection().taskId);
    }),
    vscode.commands.registerCommand('visualAgent.explainInConversation', async (taskId?: string, impact = false) => {
      const task = taskId ? recorder.getTask(taskId) : undefined;
      const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot;
      const editor = [sourceEditor, ...vscode.window.visibleTextEditors].find((candidate) =>
        candidate && root && candidate.document.uri.scheme === 'file' && !candidate.document.isClosed && isInside(root, candidate.document.uri.fsPath));
      if (!task || !editor) {
        throw new Error('请先打开此会话项目中的源文件。 / Open a source file from this conversation project first.');
      }
      return impact ? reviewerController.impactAnalysis(editor, task.taskId) : reviewerController.explainFunction(editor, task.taskId);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!controller.isActive) {
        navigator.setRoot(undefined);
        navigator.clearHighlight();
      }
      controls.refreshView();
    }),
    vscode.commands.registerCommand('visualAgent.continueHistory', (id?: string) => {
      const task = id ? recorder.getTask(id) : undefined;
      if (!task || controller.isActive) return;
      const provider: ProviderId | undefined = task.launch?.provider ?? (task.source === 'local' || task.source === 'claude-code' || task.source === 'codex' ? task.source as ProviderId : undefined);
      NewTaskPanel.show(context.extensionUri, launcher, () => controls.language(), () => reviewer.getState().selectedModel, provider,
        { ...task.launch, provider, instructions: continuationContext(task, recorder.getOperations(task.taskId)) });
    }),
    vscode.commands.registerCommand('visualAgent.newAgentTask', (provider?: unknown) =>
      NewTaskPanel.show(
        context.extensionUri,
        launcher,
        () => controls.language(),
        () => reviewer.getState().selectedModel,
        provider === 'codex' || provider === 'claude-code' || provider === 'local' ? (provider as ProviderId) : undefined,
      ),
    ),
  );
  // Coding model and reviewer model are independent; only warn when the reviewer
  // would load a SECOND local model while the local agent's model is in use.
  reviewerController.setInferenceGuard(async (reviewModel) => {
    const s = controller.getSnapshot();
    const agentModel = s.taskStatus === 'Running' && s.adapterId === 'local' ? /Ollama ([^\s(]+)/.exec(s.adapterName)?.[1] : undefined;
    if (agentModel && !s.awaitingInput) throw new Error('本地编程代理正在处理或等待审批。请等本轮结束，或在同一会话中要求它解释代码。 / Wait for the local coding turn to finish before running the reviewer.');
    if (!agentModel || agentModel === reviewModel) {
      return true;
    }
    const ok = await vscode.window.showWarningMessage(
      `The local agent is using ${agentModel}. Reviewing with ${reviewModel} loads a second model into Ollama (more GPU/RAM). Continue?`,
      { modal: true },
      'Continue',
    );
    return ok === 'Continue';
  });

  const activityView = new ActivityViewProvider(context.extensionUri, controls);
  const commandTree = new CommandTreeProvider(recorder);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ActivityViewProvider.viewId, activityView),
    vscode.commands.registerCommand('visualAgent.showActivityBeside', () => activityView.showBeside()),
    vscode.window.createTreeView('visualAgent.commands', { treeDataProvider: commandTree }),
    activityView,
    vscode.window.registerWebviewViewProvider(ReviewerViewProvider.viewId, reviewerView),
    reviewerView,
    reviewerController,
    explainer,
    exporter,
    { dispose: () => reviewer.dispose() },
    commandTree,
    controls,
    records,
    review,
    navigator,
    references,
    { dispose: () => controller.dispose() },
    { dispose: () => recorder.dispose() },
  );

  log.appendLine('Visual Agent Workspace activated (adapters: mock demo, Codex App Server)');
  return { controller, recorder, startCodex, reviewer, reviewerController, exporter, controls, launcher, explainer, manual, sessions };
}

export function deactivate(): void {}
