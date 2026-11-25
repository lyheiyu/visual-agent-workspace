import * as path from 'node:path';
import { PromptAttachment, attachmentText } from '../attachments';
import { AdapterCapabilities, AgentTaskContext, OperationSink, StreamingAgentAdapter, StreamingRunResult } from '../../adapters/AgentAdapter';
import { NormalizedEventApplier } from '../../adapters/normalizedEvents';
import { DESTRUCTIVE_COMMAND, insideWorkspace, isSensitive, mapToolCall, readTextSafe, relPath, str } from '../toolMapping';
import { SOURCE_EDIT_POLICY } from '../editPolicy';

/**
 * Minimal structural types for the parts of @anthropic-ai/claude-agent-sdk we
 * use (the SDK is ESM-only and loaded lazily; see claudeSdk.ts).
 */
export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | any[] };
  parent_tool_use_id: null;
}
export type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
export interface SdkQuery extends AsyncIterable<any> {
  interrupt(): Promise<unknown>;
  supportedModels?(): Promise<Array<{ value: string; displayName: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: string[]; resolvedModel?: string }>>;
  accountInfo?(): Promise<{ apiKeySource?: string; apiProvider?: string; tokenSource?: string; subscriptionType?: string }>;
  close?(): void;
}
export type SdkQueryFn = (p: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => SdkQuery;

export interface ClaudeAdapterOptions {
  authentication?: ClaudeAuthentication;
  loadQuery: () => Promise<SdkQueryFn>;
  model: string;
  effort?: string;
  profile: 'read-only' | 'approved-write';
  env: NodeJS.ProcessEnv;
  pathToClaudeCodeExecutable?: string;
  readText?: (p: string) => string | undefined;
  /** Claude Code session of this conversation to resume; a new session is started if it cannot be resumed. */
  resumeSessionId?: string;
  /** Compact summary used only when the session cannot be resumed (marked as reconstructed). */
  reconstructedContext?: (reason?: string) => string;
  /** Set when this session starts from a reconstructed summary (the prompt already contains it): recorded as reconstructed. */
  reconstructedReason?: string;
}

/** Resuming the conversation's session failed before it started (nothing was sent to the model). */
class ResumeFailed extends Error {}

export interface ClaudeAuthentication { ok: boolean; kind?: 'subscription' | 'api-key' | 'cloud'; method?: string; reason?: string }
export interface ClaudeLoginStatus { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiProvider?: string }

/** Subscription credentials stay inside the official Claude Code runtime. */
export function claudeAuthFromEnv(env: NodeJS.ProcessEnv, login?: ClaudeLoginStatus): ClaudeAuthentication {
  if (env.ANTHROPIC_API_KEY) {
    return { ok: true, kind: 'api-key', method: 'ANTHROPIC_API_KEY (API billing)' };
  }
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
    return { ok: true, kind: 'cloud', method: 'Amazon Bedrock' };
  }
  if (env.CLAUDE_CODE_USE_VERTEX === '1') {
    return { ok: true, kind: 'cloud', method: 'Google Vertex AI' };
  }
  if (env.CLAUDE_CODE_USE_FOUNDRY === '1') {
    return { ok: true, kind: 'cloud', method: 'Microsoft Foundry' };
  }
  if (login?.loggedIn && login.authMethod === 'claude.ai' && login.subscriptionType) {
    return { ok: true, kind: 'subscription', method: `Claude subscription (${login.subscriptionType}) · official Claude Code login` };
  }
  return {
    ok: false,
    reason:
      'Sign in through official Claude Code (claude auth login), or configure ANTHROPIC_API_KEY / Bedrock / Vertex / Foundry. No usable authentication was detected.',
  };
}

const ACCEPTED_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper']);

class InputQueue implements AsyncIterable<SdkUserMessage> {
  private items: SdkUserMessage[] = [];
  private waiter: ((v: IteratorResult<SdkUserMessage>) => void) | undefined;
  private closed = false;
  push(text: string, attachments: PromptAttachment[] = []): void {
    const msg: SdkUserMessage = { type: 'user', message: { role: 'user', content: attachments.length ? [{ type: 'text', text: attachmentText(text, attachments) }, ...attachments.filter((a) => a.mime.startsWith('image/')).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }))] : text }, parent_tool_use_id: null };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }
  close(): void {
    this.closed = true;
    this.waiter?.({ value: undefined as never, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((r) => (this.waiter = r));
      },
    };
  }
}

/**
 * Claude Code via the Claude Agent SDK (EXPERIMENTAL: contract-tested with
 * fixtures; not live-tested in this environment).
 *
 * - Claude Code runs the agent loop and tools; its permission system calls
 *   `canUseTool` before any tool that needs permission — that callback is
 *   where Visual Agent intercepts (real blocking).
 * - Isolated: `settingSources: []` (no user/project settings, hooks or
 *   CLAUDE.md permission rules are loaded or modified).
 * - Multi-turn: streaming input; follow-ups continue the same session. The
 *   session is persisted by Claude Code, so a later session resumes it
 *   (`resume`) instead of replaying the conversation.
 */
export class ClaudeCodeAdapter implements StreamingAgentAdapter {
  readonly kind = 'streaming' as const;
  readonly id = 'claude-code';
  readonly simulated = false;
  readonly capabilities: AdapterCapabilities = { pause: false, interrupt: true, steer: true, followUp: true };
  readonly displayName: string;
  readonly boundary: string;

  private q: SdkQuery | undefined;
  private input: InputQueue | undefined;
  private abort = new AbortController();
  private applier: NormalizedEventApplier | undefined;
  private sink: OperationSink | undefined;
  private root = '';
  private ended: 'completed' | 'interrupted' | undefined;
  private authentication?: ClaudeAuthentication;
  private readonly announced = new Set<string>();
  private resuming: string | undefined;
  private recoveryReason: string | undefined;
  private initSeen = false;

  constructor(private readonly options: ClaudeAdapterOptions) {
    this.displayName = `Claude Code · ${options.model} (${options.profile === 'read-only' ? 'read-only' : 'approve edits & commands'})`;
    this.boundary =
      options.profile === 'read-only'
        ? 'Claude Code permission mode "default" with Edit/Write/Bash/Web/Task disallowed; reads of secrets (.env, keys, .git) denied by Visual Agent.'
        : 'Claude Code permission mode "default": every edit and shell command goes through canUseTool and waits for you; web and sub-agents disallowed; outside-workspace and secret files denied.';
  }

  async run(ctx: AgentTaskContext, sink: OperationSink): Promise<StreamingRunResult> {
    if (!ctx.workspaceRoot) {
      throw new Error('Claude Code needs an open workspace folder.');
    }
    const auth = this.options.authentication ?? claudeAuthFromEnv(this.options.env);
    this.authentication = auth;
    if (!auth.ok) {
      throw new Error(auth.reason);
    }
    this.root = ctx.workspaceRoot;
    this.sink = sink;
    this.applier = new NormalizedEventApplier(sink);
    try {
      return await this.attempt(ctx, sink, auth, this.options.resumeSessionId);
    } catch (err) {
      if (!(err instanceof ResumeFailed)) throw err;
      // The native session is gone or belongs elsewhere: a new session with a short, labelled summary.
      this.recoveryReason = err.message;
      sink.log(`[claude] session ${this.options.resumeSessionId} could not be resumed: ${err.message}`);
      this.ended = undefined;
      this.abort = new AbortController();
      return this.attempt(ctx, sink, auth, undefined);
    }
  }

  private async attempt(ctx: AgentTaskContext, sink: OperationSink, auth: ClaudeAuthentication, resume: string | undefined): Promise<StreamingRunResult> {
    this.resuming = resume;
    this.initSeen = false;
    const queryFn = await this.options.loadQuery();
    this.input = new InputQueue();
    const readOnly = this.options.profile === 'read-only';
    this.q = queryFn({
      prompt: this.input,
      options: {
        cwd: ctx.workspaceRoot,
        model: this.options.model,
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        permissionMode: 'default',
        settingSources: [],
        // Appended to Claude Code's own prompt: source changes via Edit/Write (reviewed as diffs), not Bash.
        ...(readOnly ? {} : { systemPrompt: { type: 'preset', preset: 'claude_code', append: SOURCE_EDIT_POLICY } }),
        disallowedTools: readOnly
          ? ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent']
          : ['WebFetch', 'WebSearch', 'Task', 'Agent'],
        canUseTool: (toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }) => this.canUseTool(toolName, input, o.toolUseID),
        abortController: this.abort,
        env: this.options.env,
        // Stored by Claude Code (its own session store) so the conversation can be resumed natively later.
        persistSession: true,
        ...(resume ? { resume } : {}),
        ...(this.options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable } : {}),
      },
    });
    try {
      // Control-plane metadata is available without sending a model prompt.
      // Fail closed before a billable turn if the runtime chose another auth mode.
      if (!this.q.accountInfo) throw new Error('Claude Code cannot confirm its authentication mode. No task prompt was sent.');
      const info = await this.q.accountInfo();
      const firstParty = (info.apiProvider ?? 'firstParty') === 'firstParty';
      if (auth.kind === 'subscription' && (!firstParty || !info.subscriptionType || ACCEPTED_KEY_SOURCES.has(info.apiKeySource ?? ''))) {
        throw new Error('Claude subscription authentication was not confirmed. No task prompt was sent and API billing was not used as a fallback.');
      }
      if (auth.kind === 'api-key' && (!firstParty || !ACCEPTED_KEY_SOURCES.has(info.apiKeySource ?? ''))) {
        throw new Error('Claude API-key authentication was not confirmed. No task prompt was sent.');
      }
      const cloudProvider = auth.method === 'Amazon Bedrock' ? 'bedrock' : auth.method === 'Google Vertex AI' ? 'vertex' : 'foundry';
      if (auth.kind === 'cloud' && info.apiProvider !== cloudProvider) throw new Error('The selected Claude cloud authentication was not confirmed. No task prompt was sent.');
      const authOp = sink.announce({ operationType: 'Analyze', description: `Claude authentication confirmed: ${auth.method}` });
      sink.complete(authOp, { outcome: 'Completed', resultSummary: `Authentication: ${auth.kind}. Provider: ${info.apiProvider ?? 'firstParty'}${info.subscriptionType ? `; plan: ${info.subscriptionType}` : ''}.` });
      const first = !resume && this.recoveryReason && this.options.reconstructedContext ? this.options.reconstructedContext(this.recoveryReason) + ctx.description : ctx.description;
      this.input.push(first, ctx.attachments);
      for await (const msg of this.q) {
        if (resume && msg.type === 'system' && msg.subtype === 'init' && msg.cwd && path.resolve(String(msg.cwd)).toLowerCase() !== path.resolve(ctx.workspaceRoot).toLowerCase()) {
          throw new ResumeFailed(`the session belongs to another project (${msg.cwd})`);
        }
        this.onMessage(msg);
      }
      if (resume && !this.initSeen && !this.ended) throw new ResumeFailed('Claude Code ended without starting the session');
    } catch (err) {
      if (this.ended) {
        return { outcome: this.ended };
      }
      if (resume && !this.initSeen && !(err instanceof ResumeFailed)) throw new ResumeFailed((err as Error).message ?? String(err));
      throw err;
    } finally {
      this.input.close();
      this.q.close?.();
    }
    return { outcome: this.ended ?? 'completed' };
  }

  async steer(text: string, attachments?: PromptAttachment[]): Promise<void> {
    if (!this.input) {
      throw new Error('Claude Code session is not running.');
    }
    this.sink?.setAwaitingInput?.(false);
    this.input.push(text, attachments);
  }

  async interrupt(): Promise<void> {
    this.ended = 'interrupted';
    try {
      await this.q?.interrupt();
    } catch {
      /* already stopped */
    }
    this.input?.close();
    this.abort.abort();
  }

  async endSession(): Promise<void> {
    this.ended = 'completed';
    this.input?.close();
  }

  // ------------------------------------------------------------ internals

  private onMessage(msg: any): void {
    const sink = this.sink!;
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.initSeen = true;
      const reason = this.recoveryReason ?? this.options.reconstructedReason;
      const continuity = this.resuming ? 'resumed' : reason ? 'reconstructed' : 'new';
      if (msg.session_id) sink.setSession?.({ provider: 'claude-code', id: String(msg.session_id), continuity, ...(reason && !this.resuming ? { recoveryReason: reason } : {}) });
      const how = continuity === 'resumed' ? 'Claude Code session resumed (native context kept)' : continuity === 'reconstructed' ? 'New Claude Code session with reconstructed context (the previous session could not be resumed)' : 'Claude Code session started';
      const op = sink.announce({
        operationType: 'Analyze',
        description: `${how}: ${msg.model ?? this.options.model} (Claude Code ${msg.claude_code_version ?? '?'})`,
        rationale: this.boundary,
        externalId: msg.session_id,
      });
      const mismatch = msg.model && !String(msg.model).includes(this.options.model) && this.options.model !== 'default';
      sink.complete(op, {
        outcome: 'Completed',
        resultSummary: `Requested model ${this.options.model}; session reports ${msg.model}${mismatch ? ' (alias resolved by Claude Code)' : ''}. Tools: ${(msg.tools ?? []).join(', ')}.`,
      });
      return;
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          const first = block.text.split(/\r?\n/).find((l: string) => l.trim()) ?? '';
          const op = sink.announce({ operationType: 'Analyze', description: `Claude: ${first.slice(0, 140)}` });
          sink.complete(op, { outcome: 'Completed', resultSummary: block.text, assistantMessage: true });
        } else if (block.type === 'tool_use') {
          this.announceTool(block.name, block.input ?? {}, block.id);
        }
      }
      return;
    }
    if (msg.type === 'user') {
      const content = msg.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== 'tool_result') {
          continue;
        }
        const text = Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? '').join('\n') : String(block.content ?? '');
        const op = this.applier!.operationId(block.tool_use_id);
        const isShell = op ? this.shellOps.has(block.tool_use_id) : false;
        this.applier!.apply({
          type: 'operation.completed',
          key: block.tool_use_id,
          completion: {
            outcome: block.is_error ? 'Failed' : 'Completed',
            resultSummary: text.slice(0, 2000),
            command: isShell ? { stdout: text, outputCombined: true, finishedAt: new Date().toISOString() } : undefined,
          },
        });
      }
      return;
    }
    if (msg.type === 'result') {
      const op = sink.announce({ operationType: 'Analyze', description: `Turn finished (${msg.subtype})` });
      sink.complete(op, {
        outcome: msg.is_error ? 'Failed' : 'Completed',
        resultSummary: `${msg.num_turns ?? '?'} model turns, ${msg.duration_ms ?? '?'} ms${typeof msg.total_cost_usd === 'number' ? `, SDK usage estimate $${msg.total_cost_usd.toFixed(4)} (${this.authentication?.kind === 'subscription' ? 'subscription quota; not an API invoice' : 'API billing'})` : ''}.`,
      });
      const u = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
      if (u) sink.reportUsage?.({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedInputTokens: u.cache_read_input_tokens });
      sink.setAwaitingInput?.(true);
    }
  }

  private readonly shellOps = new Set<string>();

  private announceTool(name: string, input: Record<string, unknown>, id: string): void {
    if (this.announced.has(id)) {
      return;
    }
    this.announced.add(id);
    if (/^bash$/i.test(name)) {
      this.shellOps.add(id);
    }
    this.applier!.apply({
      type: 'operation.announced',
      key: id,
      op: mapToolCall({ tool: name, input, workspaceRoot: this.root, externalId: id, readText: this.options.readText ?? readTextSafe }),
    });
  }

  /** Claude Code's permission callback: the tool is blocked until this resolves. */
  private async canUseTool(toolName: string, input: Record<string, unknown>, toolUseID: string): Promise<SdkPermissionResult> {
    const sink = this.sink!;
    this.announceTool(toolName, input, toolUseID);
    const opId = this.applier!.operationId(toolUseID)!;
    const file = str(input, 'file_path', 'filePath', 'path', 'notebook_path');
    if (file && (!insideWorkspace(this.root, file) || isSensitive(this.root, file))) {
      const why = !insideWorkspace(this.root, file) ? `outside the workspace: ${file}` : `protected file: ${relPath(this.root, file)}`;
      sink.autoDecide(opId, 'rejected', why);
      return { behavior: 'deny', message: `Not allowed: ${why}` };
    }
    const writes = /^(write|edit|multiedit|notebookedit|bash)$/i.test(toolName);
    if (this.options.profile === 'read-only' && writes) {
      sink.autoDecide(opId, 'rejected', 'read-only profile');
      return { behavior: 'deny', message: 'Read-only session.' };
    }
    if (!writes && /^(read|glob|grep|ls|todowrite)$/i.test(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (!writes) {
      sink.autoDecide(opId, 'rejected', `tool ${toolName} is not granted`);
      return { behavior: 'deny', message: `${toolName} is not allowed in this session.` };
    }
    const command = str(input, 'command') ?? '';
    const warn = /^bash$/i.test(toolName) && DESTRUCTIVE_COMMAND.test(command) ? '⚠ potentially destructive command' : undefined;
    const { decision, reason } = await sink.requestDecision(opId, warn);
    if (decision === 'approved') {
      sink.markRunning(opId, 'Approved by user; Claude Code runs it');
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: reason ?? (decision === 'cancelled' ? 'Task stopped.' : 'Rejected by the user.'), interrupt: decision === 'cancelled' };
  }
}
