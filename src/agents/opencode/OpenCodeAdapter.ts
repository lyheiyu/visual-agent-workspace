import { PromptAttachment, attachmentText } from '../attachments';
import { AdapterCapabilities, AgentTaskContext, OperationSink, StreamingAgentAdapter, StreamingRunResult } from '../../adapters/AgentAdapter';
import { NormalizedEventApplier } from '../../adapters/normalizedEvents';
import { DESTRUCTIVE_COMMAND, insideWorkspace, isSensitive, mapToolCall, readTextSafe, relPath } from '../toolMapping';
import { OpenCodeConnection, OpenCodeConnector, OpenCodeLaunch } from './OpenCodeServer';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { localWorkflowPrompt, LocalWorkflow } from './localWorkflow';
import { estimateTokens } from '../../analysis/estimateTokens';
import { scriptChangeRisks, localDependencyIssues } from '../../analysis/codingValidation';
import { applyUnifiedDiff } from '../../review/unifiedDiff';

export interface OpenCodeAdapterOptions {
  originalRequirements?: string;
  /** Set when this session starts from a reconstructed summary (the prompt already contains it): recorded as reconstructed. */
  reconstructedReason?: string;
  resumeSessionId?: string;
  connector: OpenCodeConnector;
  launch: Omit<OpenCodeLaunch, 'workspaceRoot'>;
  readText?: (p: string) => string | undefined;
  workflow?: LocalWorkflow;
  diagnostics?: (absolutePath: string) => string[];
}

/**
 * Local coding agent: OpenCode runtime + a local Ollama model.
 *
 * - OpenCode runs the agent loop and its own permission system; this adapter
 *   only observes its event stream and answers its permission requests.
 * - Inference is local: OpenCode is configured with the Ollama provider only,
 *   and every assistant message is checked to come from that provider/model.
 * - Multi-turn: the session stays open after each turn; follow-up
 *   instructions continue the same OpenCode session until "End session".
 */
export class OpenCodeAdapter implements StreamingAgentAdapter {
  readonly kind = 'streaming' as const;
  readonly id = 'local';
  readonly simulated = false;
  readonly capabilities: AdapterCapabilities = { pause: false, interrupt: true, steer: true, followUp: true };
  readonly displayName: string;
  readonly boundary: string;

  private conn: OpenCodeConnection | undefined;
  private sessionId: string | undefined;
  private busy = false;
  private finish: ((r: StreamingRunResult) => void) | undefined;
  private applier: NormalizedEventApplier | undefined;
  private sink: OperationSink | undefined;
  private root = '';
  private readonly announced = new Set<string>();
  private readonly assistantMessages = new Set<string>();
  private readonly userMessages = new Set<string>();
  private readonly texts = new Map<string, string>();
  private readonly flushedTexts = new Set<string>();
  private readonly handledPermissions = new Set<string>();
  private modelViolation = false;
  private readonly limitedMessages = new Set<string>();
  private readonly usageReported = new Set<string>();
  private readonly partProgress = new Map<string, { phase: 'thinking' | 'answering'; characters: number }>();
  private turnStartedAt = 0;
  private readonly pendingTodos = new Map<string, string>();
  private readonly toolOutcomes = new Map<string, { status: string; tool: string; target?: string }>();
  private readonly finishedToolCalls = new Set<string>();
  private readonly failedAttempts = new Map<string, number>();
  private originalTask = '';
  private readonly approvedScripts = new Map<string, { file: string; before: string }>();
  private readonly validationErrors = new Map<string, string[]>();
  private correctionRequested = false;
  private correctionPending = false;
  private userRejected = false;
  private readonly failedTests = new Set<string>();
  private sawPassingTest = false;
  private allowCorrection = true;
  private exportChangeRequested = false;
  private readonly diagnosticBaselines = new Map<string, string[]>();
  private readonly scriptBaselines = new Map<string, string>();

  private finishLocalTurn(): void {
    if (!this.busy || this.stoppingForLimit || this.correctionPending) return;
    this.flushTexts();
    for (const [file, before] of this.scriptBaselines) {
      const baseline = this.diagnosticBaselines.get(file) ?? [];
      const current = this.options.diagnostics?.(path.resolve(this.root, file)) ?? [];
      const fresh = current.filter((message) => !baseline.includes(message));
      const actual = (this.options.readText ?? readTextSafe)(path.resolve(this.root, file));
      const syntax = actual === undefined ? [] : scriptChangeRisks(file, before, actual).filter((risk) => risk.startsWith('New syntax error:'));
      const dependencies = actual === undefined ? [] : localDependencyIssues(this.root, file, actual, before);
      const problems = [...fresh, ...syntax, ...dependencies];
      if (problems.length) this.validationErrors.set(file, problems);
      else this.validationErrors.delete(file);
    }
    if ((this.validationErrors.size || this.failedTests.size) && !this.correctionRequested && !this.userRejected && this.allowCorrection) {
      this.correctionRequested = true;
      this.correctionPending = true;
      const evidence = [...this.validationErrors].map(([file, errors]) => file + ': ' + errors.join('; ')).concat([...this.failedTests].map((command) => 'Recorded failing test: ' + command)).join('\n');
      void this.prompt('Validation has unresolved failures. Read the actual error output already in this session and current target fragments. Correct the implementation, preserve public exports and tests, then run the relevant test again. All edits still require approval. If a genuine blocker prevents correction, explain it.\n' + evidence)
        .catch((error) => this.finish?.({ outcome: 'failed', message: String(error) }));
      return;
    }
    const unresolved = [...this.toolOutcomes.values()].filter((entry) => entry.status === 'error');
    const pending = [...this.pendingTodos.values()];
    if (pending.length || unresolved.length || this.validationErrors.size || this.failedTests.size) {
      const id = this.sink!.announce({ operationType: 'Analyze', description: 'Local task has unresolved work' });
      this.sink!.complete(id, { outcome: 'Failed', resultSummary: [
        'Task completion is unverified. Tool errors and pending checklist items need review.',
        ...pending.map((text) => '- Pending: ' + text),
        ...unresolved.map((entry) => '- Unresolved tool failure: ' + entry.tool),
        ...[...this.validationErrors].flatMap(([file, errors]) => errors.map((error) => '- Validation: ' + file + ': ' + error)),
        ...[...this.failedTests].map((command) => '- Failing test: ' + command),
      ].join('\n') });
    }
    this.busy = false;
    this.sink!.setAwaitingInput?.(true);
  }
  private readonly steps = new Set<string>();
  private stoppingForLimit = false;

  constructor(private readonly options: OpenCodeAdapterOptions) {
    const p = options.launch.profile;
    this.displayName = `Local agent · OpenCode + Ollama ${options.launch.model} (${p === 'read-only' ? 'read-only' : 'approve edits & commands'})`;
    this.boundary =
      p === 'read-only'
        ? 'OpenCode permissions: edit/bash/web/sub-agents DENIED, reads outside the workspace and of secrets (.env, keys, .git) DENIED. Local Ollama only.'
        : 'OpenCode permissions: every edit and every shell command ASKS (blocked until you decide); web, sub-agents, outside-workspace and secret files DENIED. Local Ollama only.';
  }

  async run(ctx: AgentTaskContext, sink: OperationSink, signal: AbortSignal): Promise<StreamingRunResult> {
    if (!ctx.workspaceRoot) {
      throw new Error('The local agent needs an open workspace folder.');
    }
    this.root = ctx.workspaceRoot;
    this.originalTask = this.options.originalRequirements ?? ctx.description;
    this.sink = sink;
    this.applier = new NormalizedEventApplier(sink);
    const done = new Promise<StreamingRunResult>((resolve) => (this.finish = resolve));
    const conn = await this.options.connector({ ...this.options.launch, workspaceRoot: ctx.workspaceRoot });
    this.conn = conn;
    const sse = new AbortController();
    // An unexpected server exit fails the task (after a normal end, the result is already settled).
    conn.onExit((detail) => this.finish?.({ outcome: 'failed', message: detail }));
    const streaming = conn.subscribe((ev) => this.onEvent(ev), sse.signal).then(() => {
      if (!sse.signal.aborted) this.finish?.({ outcome: 'failed', message: 'OpenCode event stream closed unexpectedly.' });
    }).catch((err) => {
      if (!sse.signal.aborted) this.finish?.({ outcome: 'failed', message: `OpenCode event stream failed: ${(err as Error).message}` });
    });
    try {
      const resume = this.options.resumeSessionId;
      const session = resume
        ? await conn.request<{ id: string; directory?: string }>('GET', `/session/${encodeURIComponent(resume)}`)
        : await conn.request<{ id: string; directory?: string }>('POST', '/session', { title: ctx.description.slice(0, 100) });
      if (resume && (session?.id !== resume || !session.directory || path.relative(path.resolve(this.root), path.resolve(session.directory)) !== '')) {
        throw new Error('Cannot restore this OpenCode session: its identity or project directory does not match. Use saved-context continuation explicitly instead.');
      }
      this.sessionId = session.id;
      if (resume) {
        const todos = await conn.request<unknown>('GET', `/session/${encodeURIComponent(resume)}/todo`);
        this.updateTodos(todos);
      }
      sink.setSession?.({ provider: 'local', id: session.id, continuity: resume ? 'resumed' : this.options.reconstructedReason ? 'reconstructed' : 'new', ...(!resume && this.options.reconstructedReason ? { recoveryReason: this.options.reconstructedReason } : {}) });
      const op = sink.announce({
        operationType: 'Analyze',
        description: `Local agent session ${resume ? 'restored' : 'started'}: OpenCode${conn.version ? ` ${conn.version}` : ''} + Ollama ${this.options.launch.model}`,
        rationale: this.boundary,
        externalId: session.id,
      });
      sink.complete(op, {
        outcome: 'Completed',
        resultSummary: `Session ${session.id}. Provider restricted to ollama; model ${this.options.launch.model}; context limit ${this.options.launch.contextLimit} tokens.`,
      });
      if (signal.aborted) {
        return { outcome: 'interrupted' };
      }
      await this.prompt(ctx.description, ctx.attachments);
      return await done;
    } finally {
      this.busy = false;
      sse.abort();
      await conn.close();
      await streaming;
      this.conn = undefined;
    }
  }

  async steer(text: string, attachments?: PromptAttachment[]): Promise<void> {
    if (!this.conn || !this.sessionId) {
      throw new Error('The local agent session is not running.');
    }
    this.correctionRequested = false;
    this.userRejected = false;
    this.allowCorrection = !/\b(?:do not (?:change|edit)|read.only|only explain|explain only)\b|不要修改|仅解释|只读/i.test(text);
    this.exportChangeRequested = /\b(?:rename|remove|replace|change)\s+(?:the\s+)?(?:public\s+)?(?:exports?|interface)\b|(?:删除|重命名|变更|修改)(?:公开)?(?:导出|接口)/i.test(text);
    await this.prompt(text, attachments);
  }

  async interrupt(): Promise<void> {
    await this.abortTurn();
    this.finish?.({ outcome: 'interrupted' });
  }

  async endSession(): Promise<void> {
    await this.abortTurn();
    this.finish?.({ outcome: 'completed' });
  }

  dispose(): void {
    void this.conn?.close();
  }

  // ------------------------------------------------------------ internals

  private async prompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    const { contextLimit, outputLimit } = this.options.launch;
    const system = localWorkflowPrompt(this.options.launch.profile, this.options.workflow, this.root) +
      (contextLimit <= 16384 ? '\n当前上下文较小。每次搜索限定相关目录，每次读取优先不超过120行，每次编辑集中一个定义，保留简短待办。' : '') +
      '\nOriginal task (reference, retain across compaction):\n' + this.originalTask.slice(0, 4000) +
      (this.pendingTodos.size ? '\nPending checklist:\n' + [...this.pendingTodos.values()].join('\n').slice(0, 2000) : '');
    const mentionedFiles = [...new Set((this.originalTask + '\n' + text).match(/[\w./\\-]+\.(?:[cm]?[jt]sx?|py|md|json)\b/g) ?? [])].slice(0, 12);
    const hints = mentionedFiles.filter((file) => insideWorkspace(this.root, file) && !isSensitive(this.root, file)).map((file) => {
      const absolute = path.resolve(this.root, file);
      return file + (fs.existsSync(absolute) ? ' (exists at this exact workspace-relative path)' : ' (not present at this workspace-relative path)');
    });
    const content = attachmentText(text, attachments) + (hints.length ? '\n\nWorkspace path facts:\n' + hints.join('\n') : '');
    if (estimateTokens(content) + estimateTokens(system) + outputLimit > contextLimit) {
      throw new Error('This message and its attachments exceed the local model context budget. Split the input or refer to workspace files by path.');
    }
    this.steps.clear();
    this.failedAttempts.clear();
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.partProgress.clear();
    this.sink?.setAwaitingInput?.(false);
    await this.conn!.request('POST', `/session/${this.sessionId}/prompt_async`, {
      model: { providerID: 'ollama', modelID: this.options.launch.model },
      system,
      parts: [{ type: 'text', text: content }, ...attachments.filter((a) => a.mime.startsWith('image/')).map((a) => ({ type: 'file', mime: a.mime, filename: a.name, url: `data:${a.mime};base64,${a.data}` }))],
    });
  }

  private async abortTurn(): Promise<void> {
    if (this.conn && this.sessionId && this.busy) {
      try {
        await this.conn.request('POST', `/session/${this.sessionId}/abort`);
      } catch {
        /* server may already be gone */
      }
    }
  }

  private onEvent(ev: { type: string; properties: any }): void {
    const sink = this.sink!;
    const p = ev.properties ?? {};
    const eventSession = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    if (eventSession && this.sessionId && eventSession !== this.sessionId) {
      return;
    }
    switch (ev.type) {
      case 'todo.updated':
        this.updateTodos(p.todos);
        return;
      case 'message.updated': {
        const info = p.info ?? {};
        if (info.role === 'user') {
          this.userMessages.add(info.id);
        } else if (info.role === 'assistant') {
          if (!this.assistantMessages.has(info.id)) this.correctionPending = false;
          this.assistantMessages.add(info.id);
          // Provider-reported tokens of a finished reply, once per message (diagnostics only).
          if (info.time?.completed && info.tokens && !this.usageReported.has(info.id)) {
            this.usageReported.add(info.id);
            sink.reportUsage?.({
              inputTokens: (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0),
              outputTokens: (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0),
              cachedInputTokens: info.tokens.cache?.read,
            });
          }
          if (info.finish === 'length' && !this.limitedMessages.has(info.id) && (!info.time?.created || info.time.created >= this.turnStartedAt)) {
            this.limitedMessages.add(info.id);
            const op = sink.announce({ operationType: 'Analyze', description: 'Local model output limit reached / 本地模型输出达到上限' });
            sink.complete(op, { outcome: 'Failed', resultSummary: `The model stopped at its output limit (${this.options.launch.outputLimit} tokens). This is not evidence that files were created or the task completed. Check the recorded Edit operations. Break the task into a small first file, or choose a model/context size that fits this machine. / 模型输出被截断，不代表文件已创建；请查看实际编辑记录，并将任务拆成较小步骤。` });
          }
          // No silent model substitution: every reply must come from the selected local model.
          if (info.providerID && (info.providerID !== 'ollama' || info.modelID !== this.options.launch.model) && !this.modelViolation) {
            this.modelViolation = true;
            const op = sink.announce({ operationType: 'Analyze', description: `Model mismatch: reply came from ${info.providerID}/${info.modelID}` });
            sink.complete(op, { outcome: 'Failed', resultSummary: 'Stopped: the agent did not use the selected local model.' });
            void this.abortTurn().then(() => this.finish?.({ outcome: 'failed', message: `OpenCode used ${info.providerID}/${info.modelID} instead of ollama/${this.options.launch.model}.` }));
          }
        }
        return;
      }
      case 'message.part.updated':
        return this.onPart(p.part);
      case 'message.part.delta': {
        const part = this.partProgress.get(p.partID);
        if (part && p.field === 'text' && typeof p.delta === 'string') {
          part.characters += p.delta.length;
          sink.setProgress?.(part.phase, part.characters);
        }
        return;
      }
      case 'permission.asked':
        void this.onPermission(p).catch((error) => {
          const message = `OpenCode approval failed: ${(error as Error).message}`;
          const op = sink.announce({ operationType: 'Analyze', description: 'Could not complete tool approval / 工具审批失败' });
          sink.complete(op, { outcome: 'Failed', resultSummary: message });
          this.finish?.({ outcome: 'failed', message });
        });
        return;
      case 'session.idle':
        this.finishLocalTurn();
        return;
      case 'session.status':
        if (p.status?.type === 'busy') {
          this.busy = true;
        } else if (p.status?.type === 'idle' && this.busy && !this.stoppingForLimit) {
          this.finishLocalTurn();
        } else if (p.status?.type === 'retry') {
          sink.log(`[opencode] retrying: ${p.status.message ?? ''}`);
        }
        return;
      case 'session.error': {
        const err = p.error ?? {};
        if (err.name === 'MessageAbortedError') {
          return;
        }
        const msg = err.data?.message ?? err.message ?? err.name ?? 'unknown error';
        const op = sink.announce({ operationType: 'Analyze', description: `Agent error: ${String(msg).slice(0, 140)}` });
        sink.complete(op, { outcome: 'Failed', resultSummary: String(msg) });
        this.finish?.({ outcome: 'failed', message: String(msg) });
        return;
      }
      default:
        return;
    }
  }

  private onPart(part: any): void {
    if (!part) {
      return;
    }
    if (part.type === 'step-start' && this.busy && typeof part.id === 'string') {
      this.steps.add(part.id);
      if (this.steps.size > 48 && !this.stoppingForLimit) {
        this.stoppingForLimit = true;
        const message = 'Local turn stopped after 48 model steps. Inspect the recorded results before continuing this session.';
        const op = this.sink!.announce({ operationType: 'Analyze', description: 'Local agent step limit reached' });
        this.sink!.complete(op, { outcome: 'Failed', resultSummary: message });
        void this.abortTurn().finally(() => this.finish?.({ outcome: 'failed', message }));
      }
    }
    if ((part.type === 'reasoning' || part.type === 'text') && !this.userMessages.has(part.messageID)) {
      const progress = { phase: part.type === 'reasoning' ? 'thinking' as const : 'answering' as const, characters: typeof part.text === 'string' ? part.text.length : 0 };
      this.partProgress.set(part.id, progress);
      this.sink?.setProgress?.(progress.phase, progress.characters);
    }
    if (part.type === 'text') {
      if (!this.userMessages.has(part.messageID) && typeof part.text === 'string') {
        this.texts.set(part.id, part.text);
      }
      return;
    }
    if (part.type !== 'tool') {
      return;
    }
    this.sink?.setProgress?.('tool', 0);
    const key = part.callID ?? part.id;
    const state = part.state ?? {};
    const input = state.input ?? {};
    if ((state.status === 'completed' || state.status === 'error') && !this.finishedToolCalls.has(key)) {
      this.finishedToolCalls.add(key);
      const signature = /^(bash|shell|powershell)$/i.test(part.tool) && typeof input.command === 'string'
        ? String(part.tool) + JSON.stringify({ command: input.command.trim(), cwd: input.workdir ?? input.cwd ?? this.root })
        : String(part.tool) + JSON.stringify(input);
      const file = input.filePath ?? input.file_path;
      const target = typeof file === 'string' ? path.resolve(this.root, file) : undefined;
      const successful = state.status === 'completed' && !(typeof state.metadata?.exit === 'number' && state.metadata.exit !== 0);
      if (successful && target && /^(edit|write|multiedit|patch)$/i.test(part.tool)) {
        for (const [oldKey, outcome] of this.toolOutcomes) {
          if (outcome.status === 'error' && outcome.target === target && /^(edit|write|multiedit|patch)$/i.test(outcome.tool)) this.toolOutcomes.delete(oldKey);
        }
      }
      this.toolOutcomes.set(signature, { status: successful ? 'completed' : 'error', tool: String(part.tool), target });
      if (state.status === 'error') {
        const count = (this.failedAttempts.get(signature) ?? 0) + 1;
        this.failedAttempts.set(signature, count);
        if (count >= 3 && !this.stoppingForLimit) {
          this.stoppingForLimit = true;
          const message = 'The same tool action failed three times. Inspect its arguments and results before continuing the saved session.';
          const id = this.sink!.announce({ operationType: 'Analyze', description: 'Repeated unsuccessful local action' });
          this.sink!.complete(id, { outcome: 'Failed', resultSummary: message });
          void this.abortTurn().finally(() => this.finish?.({ outcome: 'failed', message }));
        }
      } else {
        this.failedAttempts.delete(signature);
      }
      if (state.status === 'completed' && part.tool === 'todowrite' && Array.isArray(input.todos)) {
        this.updateTodos(input.todos);
      }
    }
    // Live preview while the model is still writing an edit's arguments (display only).
    if (state.status === 'pending' && /^(edit|multiedit|write|patch)$/i.test(String(part.tool)) && !this.announced.has(key)) {
      const text = typeof input.content === 'string' ? input.content : typeof input.newString === 'string' ? input.newString : typeof state.raw === 'string' ? state.raw : '';
      // Empty text = this runtime does not stream edit arguments: the UI shows "generating; review when complete".
      this.sink?.setPreview?.({ tool: String(part.tool), filePath: typeof input.filePath === 'string' ? relPath(this.root, input.filePath) : undefined, text });
      return;
    }
    if (!this.announced.has(key) && (state.status === 'running' || state.status === 'completed' || state.status === 'error') && (Object.keys(input).length || state.status === 'error')) {
      this.flushTexts();
      this.announced.add(key);
      this.sink?.setPreview?.(undefined);
      this.applier!.apply({
        type: 'operation.announced',
        key,
        op: mapToolCall({ tool: typeof part.tool === 'string' ? part.tool : 'unknown', input, workspaceRoot: this.root, externalId: key, readText: this.options.readText ?? readTextSafe }),
      });
    }
    if (state.status === 'completed') {
      if (/^(bash|shell)$/i.test(part.tool) && typeof input.command === 'string' && /\b(test|pytest|jest|vitest)\b/i.test(input.command) && typeof state.metadata?.exit === 'number') {
        if (state.metadata.exit === 0) {
          this.failedTests.delete(input.command.trim());
          this.sawPassingTest = true;
        }
        else this.failedTests.add(input.command.trim());
      }
      const baseline = this.approvedScripts.get(key);
      if (baseline) {
        const actual = (this.options.readText ?? readTextSafe)(path.resolve(this.root, baseline.file));
        if (actual !== undefined) {
          const problems = scriptChangeRisks(baseline.file, baseline.before, actual).filter((risk) => risk.startsWith('New syntax error:'));
          if (problems.length) {
            this.validationErrors.set(baseline.file, problems);
            const check = this.sink!.announce({ operationType: 'Analyze', description: 'Post-edit syntax validation failed: ' + baseline.file });
            this.sink!.complete(check, { outcome: 'Failed', resultSummary: problems.join('\n') });
          } else this.validationErrors.delete(baseline.file);
        }
        this.approvedScripts.delete(key);
      }
      const md = state.metadata ?? {};
      const isShell = /^(bash|shell)$/i.test(part.tool);
      const exit = typeof md.exit === 'number' ? md.exit : undefined;
      this.applier!.apply({
        type: 'operation.completed',
        key,
        completion: {
          outcome: isShell && exit !== undefined && exit !== 0 ? 'Failed' : 'Completed',
          resultSummary: isShell ? `Exit code ${exit ?? 'unknown'}.` : String(state.title ?? 'Completed'),
          command: isShell ? { exitCode: exit, stdout: String(md.output ?? state.output ?? ''), outputCombined: true, finishedAt: new Date().toISOString() } : undefined,
        },
      });
    } else if (state.status === 'error') {
      this.applier!.apply({ type: 'operation.completed', key, completion: { outcome: 'Failed', resultSummary: String(state.error ?? 'Tool failed') } });
    }
  }

  private updateTodos(todos: unknown): void {
    if (!Array.isArray(todos)) return;
    this.pendingTodos.clear();
    for (const [index, todo] of todos.slice(0, 30).entries()) {
      if (typeof todo?.content === 'string' && !['completed', 'cancelled'].includes(todo.status)) {
        this.pendingTodos.set(String(index), todo.content.slice(0, 300));
      }
    }
  }

  /** OpenCode blocks the tool until we reply: this is real interception. */
  private async onPermission(req: any): Promise<void> {
    if (!req?.id || this.handledPermissions.has(req.id)) {
      return;
    }
    this.handledPermissions.add(req.id);
    if (this.stoppingForLimit) {
      await this.conn?.request('POST', `/permission/${req.id}/reply`, { reply: 'reject', message: 'This turn reached its model step limit.' });
      return;
    }
    const sink = this.sink!;
    const key: string = req.tool?.callID ?? `perm:${req.id}`;
    let opId = this.applier!.operationId(key);
    const md = req.metadata ?? {};
    if (!opId) {
      const tool = req.permission === 'edit' ? 'edit' : req.permission === 'bash' ? 'bash' : req.permission;
      const op = mapToolCall({
        tool,
        input: req.permission === 'bash' ? { command: md.command ?? (req.patterns ?? []).join(' ') } : { filePath: md.filepath },
        workspaceRoot: this.root,
        externalId: key,
        unifiedDiff: typeof md.diff === 'string' ? md.diff : undefined,
      });
      this.announced.add(key);
      this.applier!.apply({ type: 'operation.announced', key, op });
      opId = this.applier!.operationId(key)!;
    }
    const reply = async (r: 'once' | 'reject', message?: string) => {
      try {
        await this.conn?.request('POST', `/permission/${req.id}/reply`, message ? { reply: r, message } : { reply: r });
      } catch (err) {
        throw new Error(`Permission reply could not be confirmed; check actual files before retrying: ${(err as Error).message}`);
      }
    };
    // Policy checks before involving the user.
    if (this.options.launch.profile === 'read-only') {
      sink.autoDecide(opId, 'rejected', 'read-only profile');
      return reply('reject', 'Read-only session: changes and commands are not allowed.');
    }
    if (req.permission === 'edit') {
      const file = String(md.filepath ?? (req.patterns ?? [])[0] ?? '');
      if (!file || !insideWorkspace(this.root, file)) {
        sink.autoDecide(opId, 'rejected', `edit outside the workspace: ${file}`);
        return reply('reject', `Edits outside the workspace are not allowed. Use an absolute path inside ${JSON.stringify(this.root)}. Do not retry in a temporary directory.`);
      }
      if (isSensitive(this.root, file)) {
        sink.autoDecide(opId, 'rejected', `protected file: ${relPath(this.root, file)}`);
        return reply('reject', 'This file is protected (.git, secrets, keys).');
      }
    } else if (req.permission !== 'bash') {
      sink.autoDecide(opId, 'rejected', `permission "${req.permission}" is not granted to the local agent`);
      return reply('reject', `"${req.permission}" is not allowed in this session.`);
    }
    const command = String(md.command ?? '');
    const warn = req.permission === 'bash' && DESTRUCTIVE_COMMAND.test(command) ? '⚠ potentially destructive command' : undefined;
    const file = String(md.filepath ?? (req.patterns ?? [])[0] ?? '');
    const before = req.permission === 'edit' ? (this.options.readText ?? readTextSafe)(path.resolve(this.root, file)) : undefined;
    const after = typeof md.diff === 'string' ? applyUnifiedDiff(before ?? '', md.diff) : undefined;
    const risks = after !== undefined ? scriptChangeRisks(file, before ?? '', after) : [];
    if (risks.some((risk) => risk.startsWith('New syntax error:'))) {
      sink.autoDecide(opId, 'rejected', risks.join('\n'));
      return reply('reject', 'Correct these new syntax errors before proposing again:\n' + risks.join('\n'));
    }
    if (!this.exportChangeRequested && /preserv[\s\S]{0,120}(?:exports|public interface)/i.test(this.originalTask) && risks.some((risk) => risk.startsWith('Removed public export:'))) {
      sink.autoDecide(opId, 'rejected', risks.join('\n'));
      return reply('reject', 'The original task explicitly requires preserving public exports. Keep the exported names and module conventions while making the targeted fix.\n' + risks.join('\n'));
    }
    if (req.permission === 'edit' && /(^|[\\/])(__tests__|tests?)([\\/]|$)|[._](test|spec)\.[^\\/]+$/i.test(file)) {
      risks.push('Test file change: verify it implements an explicitly requested test update. Never weaken assertions to hide a source defect.');
    }
    const { decision, reason } = await sink.requestDecision(opId, [warn, ...risks].filter(Boolean).join('\n') || undefined);
    if (decision === 'approved' && !this.stoppingForLimit) {
      if (req.permission === 'edit' && (before !== undefined || after !== undefined) && !this.scriptBaselines.has(file)) this.scriptBaselines.set(file, before ?? '');
      if (req.permission === 'edit' && this.options.diagnostics && !this.diagnosticBaselines.has(file)) {
        this.diagnosticBaselines.set(file, this.options.diagnostics(path.resolve(this.root, file)));
      }
      if (req.permission === 'edit' && (before !== undefined || after !== undefined)) this.approvedScripts.set(key, { file, before: before ?? '' });
      sink.markRunning(opId, req.permission === 'edit' ? 'Approved by user; OpenCode applies this edit' : 'Approved by user; OpenCode runs this command');
      return reply('once');
    }
    this.userRejected = true;
    return reply('reject', reason ?? (decision === 'cancelled' ? 'Task stopped.' : 'Rejected by the user.'));
  }

  private flushTexts(): void {
    const sink = this.sink!;
    for (const [id, text] of this.texts) {
      if (this.flushedTexts.has(id) || !text.trim()) {
        continue;
      }
      this.flushedTexts.add(id);
      const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
      const op = sink.announce({ operationType: 'Analyze', description: `Local agent: ${first.length > 140 ? first.slice(0, 139) + '…' : first}`, externalId: id });
      sink.complete(op, { outcome: 'Completed', resultSummary: text, assistantMessage: true });
      if ((this.failedTests.size || !this.sawPassingTest) && /all tests pass|all assertions pass|tests? (?:have )?passed|tests? (?:ran|completed) successfully|测试(?:全部)?通过/i.test(text)) {
        const evidence = sink.announce({ operationType: 'Analyze', description: 'Completion claim contradicts recorded test results' });
        sink.complete(evidence, { outcome: 'Failed', resultSummary: this.failedTests.size
          ? 'The model claimed passing tests, but the latest recorded runs still failed: ' + [...this.failedTests].join(', ') + '. Completion remains unverified.'
          : 'The model mentioned passing tests without a recorded successful test run in this session. Completion remains unverified.' });
      }
    }
    this.texts.clear();
  }
}
