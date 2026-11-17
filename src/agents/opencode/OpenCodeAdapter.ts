import { AdapterCapabilities, AgentTaskContext, OperationSink, StreamingAgentAdapter, StreamingRunResult } from '../../adapters/AgentAdapter';
import { NormalizedEventApplier } from '../../adapters/normalizedEvents';
import { DESTRUCTIVE_COMMAND, insideWorkspace, isSensitive, mapToolCall, readTextSafe, relPath } from '../toolMapping';
import { OpenCodeConnection, OpenCodeConnector, OpenCodeLaunch } from './OpenCodeServer';
import * as path from 'node:path';

export interface OpenCodeAdapterOptions {
  resumeSessionId?: string;
  connector: OpenCodeConnector;
  launch: Omit<OpenCodeLaunch, 'workspaceRoot'>;
  readText?: (p: string) => string | undefined;
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
      sink.setSession?.({ provider: 'local', id: session.id });
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
      await this.prompt(ctx.description);
      return await done;
    } finally {
      this.busy = false;
      sse.abort();
      await conn.close();
      await streaming;
      this.conn = undefined;
    }
  }

  async steer(text: string): Promise<void> {
    if (!this.conn || !this.sessionId) {
      throw new Error('The local agent session is not running.');
    }
    await this.prompt(text);
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

  private async prompt(text: string): Promise<void> {
    this.busy = true;
    this.sink?.setAwaitingInput?.(false);
    await this.conn!.request('POST', `/session/${this.sessionId}/prompt_async`, {
      model: { providerID: 'ollama', modelID: this.options.launch.model },
      parts: [{ type: 'text', text }],
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
      case 'message.updated': {
        const info = p.info ?? {};
        if (info.role === 'user') {
          this.userMessages.add(info.id);
        } else if (info.role === 'assistant') {
          this.assistantMessages.add(info.id);
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
      case 'permission.asked':
        void this.onPermission(p);
        return;
      case 'session.idle':
        if (!this.busy) return;
        this.flushTexts();
        this.busy = false;
        sink.setAwaitingInput?.(true);
        return;
      case 'session.status':
        if (p.status?.type === 'busy') {
          this.busy = true;
        } else if (p.status?.type === 'idle' && this.busy) {
          this.flushTexts();
          this.busy = false;
          sink.setAwaitingInput?.(true);
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
    if (part.type === 'text') {
      if (!this.userMessages.has(part.messageID) && typeof part.text === 'string') {
        this.texts.set(part.id, part.text);
      }
      return;
    }
    if (part.type !== 'tool') {
      return;
    }
    const key = part.callID ?? part.id;
    const state = part.state ?? {};
    const input = state.input ?? {};
    if (!this.announced.has(key) && (state.status === 'running' || state.status === 'completed' || state.status === 'error') && Object.keys(input).length) {
      this.flushTexts();
      this.announced.add(key);
      this.applier!.apply({
        type: 'operation.announced',
        key,
        op: mapToolCall({ tool: part.tool, input, workspaceRoot: this.root, externalId: key, readText: this.options.readText ?? readTextSafe }),
      });
    }
    if (state.status === 'completed') {
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

  /** OpenCode blocks the tool until we reply: this is real interception. */
  private async onPermission(req: any): Promise<void> {
    if (!req?.id || this.handledPermissions.has(req.id)) {
      return;
    }
    this.handledPermissions.add(req.id);
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
        sink.log(`[opencode] permission reply failed: ${(err as Error).message}`);
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
        return reply('reject', 'Edits outside the workspace are not allowed.');
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
    const { decision, reason } = await sink.requestDecision(opId, warn);
    if (decision === 'approved') {
      sink.markRunning(opId, req.permission === 'edit' ? 'Approved by user; OpenCode applies this edit' : 'Approved by user; OpenCode runs this command');
      return reply('once');
    }
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
    }
    this.texts.clear();
  }
}
