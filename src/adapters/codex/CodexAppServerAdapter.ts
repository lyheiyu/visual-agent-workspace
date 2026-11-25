import { PromptAttachment, codexAttachmentInput } from '../../agents/attachments';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AdapterCapabilities,
  AgentTaskContext,
  OperationSink,
  StreamingAgentAdapter,
  StreamingRunResult,
} from '../AgentAdapter';
import { CodexRpcClient, RpcError, StdioTransport } from './CodexRpcClient';
import { CodexItemMapper } from './CodexItemMapper';
import { CodexEventTranslator } from './CodexEventTranslator';
import { NormalizedEventApplier } from '../normalizedEvents';
import { CodexLocation, codexEnvironment } from './codexLocator';
import { CodexProfile } from './profiles';
import { ISOLATION_ARGS } from './CodexSession';
import { SOURCE_EDIT_POLICY } from '../../agents/editPolicy';
import {
  ApprovalDecision,
  CommandApprovalParams,
  FileChangeApprovalParams,
  RpcNotification,
  SERVER_REQUEST,
  ThreadStartResponse,
  Turn,
  TurnNotification,
} from './protocol';

export type CodexConnector = (cwd: string) => CodexRpcClient;

/** Production connector: a dedicated `codex app-server` child process per task. */
export function stdioConnector(location: CodexLocation): CodexConnector {
  return (cwd) =>
    new CodexRpcClient(
      new StdioTransport(location.executable, [...ISOLATION_ARGS, 'app-server'], { cwd, env: codexEnvironment(location) }),
    );
}

export interface CodexAdapterOptions {
  connector: CodexConnector;
  profile: CodexProfile;
  /** Model id; empty = the server's default model from model/list. */
  model?: string;
  /** Reasoning effort for the turn (one of the model's supportedReasoningEfforts). */
  effort?: string;
  /** Native thread of this conversation to continue (`thread/resume`); a new thread is started if it cannot be resumed. */
  resumeThreadId?: string;
  /** Compact summary used only when the native thread cannot be resumed (marked as reconstructed). */
  reconstructedContext?: (reason?: string) => string;
  /** Set when this session starts from a reconstructed summary (the prompt already contains it): recorded as reconstructed. */
  reconstructedReason?: string;
  /** Hard limit for one turn; the turn is interrupted when exceeded. */
  maxTurnMs?: number;
  clientVersion?: string;
  readText?: (absolutePath: string) => string | undefined;
}

interface TurnWaiter {
  resolve: (turn: Turn) => void;
}

/**
 * Codex App Server adapter (streaming).
 *
 * - Starts its OWN `codex app-server` process. One thread per conversation:
 *   follow-ups are new turns in that thread (native context, no replay);
 *   a later session resumes it with `thread/resume`. It cannot see or
 *   control any other Codex session (e.g. the Codex VS Code extension).
 * - Every item Codex reports becomes an operation. Items Codex runs without
 *   asking are recorded as observed-only; items Codex asks about block until
 *   the user decides (real interception, enforced by Codex).
 * - Stop → `turn/interrupt`; pending approvals are answered "cancel".
 * - Instructions during a turn → `turn/steer` with `expectedTurnId`.
 */
export class CodexAppServerAdapter implements StreamingAgentAdapter {
  readonly kind = 'streaming' as const;
  readonly id = 'codex';
  readonly simulated = false;
  readonly capabilities: AdapterCapabilities = { pause: false, interrupt: true, steer: true, followUp: true, steerWhileRunning: true };
  readonly displayName: string;
  readonly boundary: string;

  private client: CodexRpcClient | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private turnActive = false;
  private readonly completedTurns = new Map<string, Turn>();
  private turnWaiters = new Map<string, TurnWaiter>();
  /** Codex item id → our operation id. */
  private applier: NormalizedEventApplier | undefined;
  private translator: CodexEventTranslator | undefined;
  /** Item ids whose approval was already decided (sub-approvals get new ops). */
  private readonly decidedItems = new Set<string>();
  private mapper: CodexItemMapper | undefined;
  private interrupting = false;
  private sink: OperationSink | undefined;
  /** Set while the thread waits for the next message (between turns). */
  private awaiting: ((m: { text: string; attachments?: PromptAttachment[] } | undefined) => void) | undefined;
  private endedBy: 'completed' | 'interrupted' | undefined;

  constructor(private readonly options: CodexAdapterOptions) {
    this.displayName = `Codex (${options.profile.label})`;
    this.boundary = options.profile.boundary;
  }

  async run(ctx: AgentTaskContext, sink: OperationSink, signal: AbortSignal): Promise<StreamingRunResult> {
    if (!ctx.workspaceRoot) {
      throw new Error('Codex mode needs an open workspace folder.');
    }
    const profile = this.options.profile;
    this.sink = sink;
    this.mapper = new CodexItemMapper(ctx.workspaceRoot, this.options.readText ?? readTextSafe);
    this.translator = new CodexEventTranslator(this.mapper);
    this.applier = new NormalizedEventApplier(sink);
    const client = this.options.connector(ctx.workspaceRoot);
    this.client = client;
    const closed = new Promise<{ detail: string }>((resolve) => client.onClose(resolve));
    client.onProtocolNote((n) => sink.log(`[codex] ${n}`));
    client.onNotification((n) => this.onNotification(n));
    client.setRequestHandler((method, params) => this.onServerRequest(method, params, sink));

    try {
      await client.request('initialize', {
        clientInfo: { name: 'visual-agent-workspace', title: 'Visual Agent Workspace', version: this.options.clientVersion ?? '0.2.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      client.notify('initialized', {});
      if (signal.aborted) {
        return { outcome: 'interrupted' };
      }

      const model = this.options.model || (await this.defaultModel(client));
      const threadParams = {
        cwd: ctx.workspaceRoot,
        model,
        approvalPolicy: profile.approvalPolicy,
        sandbox: profile.sandbox,
        // Only profiles that can apply patches get the edit rule; read-only ones decline edits anyway.
        ...(profile.fileChanges === 'ask-user' ? { developerInstructions: SOURCE_EDIT_POLICY } : {}),
      };
      // 1. Continue the conversation's own native thread when there is one.
      let started: ThreadStartResponse | undefined;
      let continuity: 'new' | 'resumed' | 'reconstructed' = this.options.reconstructedReason ? 'reconstructed' : 'new';
      let recoveryReason: string | undefined = this.options.reconstructedReason;
      let resumeFailed = false;
      if (this.options.resumeThreadId) {
        try {
          const resumed = await client.request<ThreadStartResponse>('thread/resume', { ...threadParams, threadId: this.options.resumeThreadId, excludeTurns: true }, 60_000);
          const problem = this.incompatible(resumed, ctx.workspaceRoot);
          if (problem) throw new Error(problem);
          started = resumed;
          continuity = 'resumed';
        } catch (err) {
          recoveryReason = err instanceof RpcError || err instanceof Error ? err.message : String(err);
          continuity = 'reconstructed';
          resumeFailed = true;
          sink.log(`[codex] thread ${this.options.resumeThreadId} could not be resumed: ${recoveryReason}`);
        }
      }
      // 2. Otherwise (first turn, or the native thread is gone): a new thread. Stored by Codex so it can be resumed later.
      if (!started) {
        started = await client.request<ThreadStartResponse>('thread/start', { ...threadParams, ephemeral: false, serviceName: 'visual-agent-workspace' });
      }
      this.threadId = started.thread.id;
      // No silent substitution: an explicitly selected model must be the one Codex runs.
      if (this.options.model && started.model !== this.options.model) {
        throw new Error(`Codex started model "${started.model}" instead of the selected "${this.options.model}". Aborting before any turn starts.`);
      }
      // Safety check: refuse to proceed unless Codex confirms the requested boundary.
      const sandboxType = (started.sandbox as { type?: string } | undefined)?.type;
      if (sandboxType !== 'readOnly' || started.approvalPolicy !== profile.approvalPolicy) {
        throw new Error(
          `Codex did not confirm the requested boundary (sandbox=${sandboxType ?? 'unknown'}, approvalPolicy=${JSON.stringify(started.approvalPolicy)}). Aborting before any turn starts.`,
        );
      }
      sink.setSession?.({ provider: 'codex', id: started.thread.id, continuity, ...(recoveryReason ? { recoveryReason } : {}) });
      const how =
        continuity === 'resumed'
          ? 'Codex thread resumed (native context kept)'
          : continuity === 'reconstructed'
            ? 'New Codex thread with reconstructed context (the previous thread could not be resumed)'
            : 'Codex session started';
      const sessionOp = sink.announce({
        operationType: 'Analyze',
        description: `${how}: ${started.model}${this.options.effort ? ` (effort ${this.options.effort})` : ''}, read-only sandbox, approval "${profile.approvalPolicy}"`,
        rationale: profile.boundary,
        externalId: started.thread.id,
      });
      sink.complete(sessionOp, {
        outcome: 'Completed',
        resultSummary: `Thread ${started.thread.id} in ${started.cwd}. Boundary confirmed by Codex: sandbox=readOnly, approvalPolicy=${profile.approvalPolicy}.${resumeFailed ? ` Native thread ${this.options.resumeThreadId} not resumed: ${recoveryReason}.` : recoveryReason ? ` Reconstructed context: ${recoveryReason}.` : ''}`,
      });
      if (signal.aborted) {
        return { outcome: 'interrupted' };
      }

      // 3. Turns: the first message, then each follow-up as a new turn in the same thread.
      // Only a failed resume adds the summary here; otherwise the launcher already put it into the prompt.
      let text = resumeFailed && this.options.reconstructedContext ? this.options.reconstructedContext(recoveryReason) + ctx.description : ctx.description;
      let attachments = ctx.attachments;
      for (;;) {
        const res = await client.request<{ turn: Turn }>('turn/start', {
          threadId: this.threadId,
          input: codexAttachmentInput(text, attachments),
          ...(this.options.effort ? { effort: this.options.effort } : {}),
        });
        this.turnId = res.turn.id;
        this.turnActive = true;
        if (signal.aborted) {
          void this.interrupt();
        }
        const finished = await this.waitForTurn(res.turn.id, closed);
        this.turnActive = false;
        if (finished.status === 'interrupted' || signal.aborted) {
          return { outcome: 'interrupted' };
        }
        if (finished.status === 'failed') {
          return { outcome: 'failed', message: finished.error?.message ?? 'Codex reported a failed turn.' };
        }
        // Turn complete: the thread and its context stay open for the next message.
        const next = await this.nextMessage(closed, sink);
        if (!next) {
          return { outcome: this.endedBy ?? 'completed' };
        }
        ({ text, attachments } = next);
      }
    } finally {
      this.turnActive = false;
      this.awaiting = undefined;
      await client.close();
      this.client = undefined;
    }
  }

  /** Resumed thread must be the same project and boundary; otherwise it is not reused. */
  private incompatible(r: ThreadStartResponse, root: string): string | undefined {
    const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!r?.thread?.id || r.thread.id !== this.options.resumeThreadId) return `Codex returned thread ${r?.thread?.id ?? 'none'} instead of ${this.options.resumeThreadId}`;
    if (!r.cwd || !same(path.resolve(r.cwd), path.resolve(root))) return `the thread belongs to another project (${r.cwd})`;
    if (this.options.model && r.model !== this.options.model) return `the thread runs model ${r.model}, not ${this.options.model}`;
    return undefined;
  }

  /** Wait (without a turn) for the next follow-up from steer(), or the end of the session. */
  private nextMessage(closed: Promise<{ detail: string }>, sink: OperationSink): Promise<{ text: string; attachments?: PromptAttachment[] } | undefined> {
    sink.setAwaitingInput?.(true);
    return new Promise((resolve) => {
      this.awaiting = (m) => {
        this.awaiting = undefined;
        resolve(m);
      };
      void closed.then(() => this.awaiting?.(undefined));
    });
  }

  async interrupt(): Promise<void> {
    if (this.awaiting) {
      this.endedBy = 'interrupted';
      this.awaiting(undefined);
      return;
    }
    const client = this.client;
    if (!client || this.interrupting) {
      return;
    }
    this.interrupting = true;
    try {
      if (this.threadId && this.turnId && this.turnActive) {
        await client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10_000);
        // Bounded wait for Codex to confirm; then force the connection closed.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 10_000);
          const check = setInterval(() => {
            if (!this.turnActive) {
              clearTimeout(t);
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
      }
    } catch {
      /* fall through to closing the connection */
    } finally {
      if (this.turnActive || !this.turnId) {
        await client.close();
      }
      this.interrupting = false;
    }
  }

  async steer(text: string, attachments?: PromptAttachment[]): Promise<void> {
    if (this.awaiting && !this.turnActive) {
      // A follow-up: the next turn of the same thread.
      this.awaiting({ text, attachments });
      return;
    }
    if (!this.client || !this.threadId || !this.turnId || !this.turnActive) {
      throw new Error('Codex has no active turn to send the instruction to.');
    }
    // expectedTurnId: Codex rejects the instruction if a different turn is active,
    // so it can never be applied to work the user did not see.
    await this.client.request('turn/steer', {
      threadId: this.threadId,
      input: codexAttachmentInput(text, attachments),
      expectedTurnId: this.turnId,
    }, 15_000);
  }

  /** End the conversation's session gracefully (the thread stays stored and can be resumed later). */
  async endSession(): Promise<void> {
    this.endedBy = 'completed';
    this.awaiting?.(undefined);
  }

  dispose(): void {
    void this.client?.close();
  }

  /**
   * Codex's approval reply carries only accept/decline, so the user's reason
   * (rejection reason, regenerate feedback, "I applied my own version") is
   * sent right after the decline as a steer of the same turn. The outcome is
   * recorded: if the turn already ended, the timeline says it was NOT delivered.
   */
  private deliverReason(sink: OperationSink, what: 'command' | 'file change', subject: string, reason: string, blocked = false): void {
    // A policy block is already addressed to the agent; a user decision is relayed as such.
    const text = blocked ? reason.slice(0, 2800) : `The user declined your proposed ${what}${subject ? ` (${subject.slice(0, 300)})` : ''}. Their reason / feedback: ${reason.slice(0, 2500)}`;
    setTimeout(() => {
      const op = sink.announce({ operationType: 'Instruct', description: blocked ? 'Send block reason to Codex: resubmit as an editable patch' : `Send decline reason to Codex: ${reason.slice(0, 100)}`, rationale: text });
      this.steer(text).then(
        () => sink.complete(op, { outcome: 'Completed', resultSummary: 'Delivered to the active Codex turn (turn/steer).' }),
        (err) => sink.complete(op, { outcome: 'Failed', resultSummary: `NOT delivered: ${(err as Error).message}. Codex only received "decline".` }),
      );
    }, 0);
  }

  // ------------------------------------------------------------ internals

  private async defaultModel(client: CodexRpcClient): Promise<string | undefined> {
    try {
      const res = await client.request<{ data: Array<{ model: string; hidden: boolean; isDefault: boolean }> }>('model/list', {}, 20_000);
      const visible = res.data.filter((m) => !m.hidden);
      return (visible.find((m) => m.isDefault) ?? visible[0])?.model;
    } catch {
      return undefined; // let Codex use its configured default
    }
  }

  private waitForTurn(turnId: string, closed: Promise<{ detail: string }>): Promise<Turn> {
    const done = this.completedTurns.get(turnId);
    if (done) {
      return Promise.resolve(done);
    }
    const max = this.options.maxTurnMs ?? 30 * 60_000;
    return new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.interrupt();
      }, max);
      this.turnWaiters.set(turnId, {
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
      });
      void closed.then((c) => {
        clearTimeout(timer);
        if (this.turnWaiters.has(turnId)) {
          this.turnWaiters.delete(turnId);
          if (this.interrupting) {
            resolve({ id: turnId, status: 'interrupted', error: null });
          } else {
            reject(new Error(`Codex app-server exited unexpectedly (${c.detail}).`));
          }
        }
      });
    });
  }

  private onNotification(n: RpcNotification): void {
    // Turn lifecycle is provider-specific control flow; everything else is
    // translated (Codex → normalized) and applied by the shared applier.
    switch (n.method) {
      case 'turn/started': {
        const { turn } = n.params as TurnNotification;
        if (!this.turnId) {
          this.turnId = turn.id;
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        // Provider-reported usage of the latest turn (diagnostics only).
        const last = (n.params as { tokenUsage?: { last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number } } }).tokenUsage?.last;
        if (last) this.sink?.reportUsage?.({ inputTokens: last.inputTokens, cachedInputTokens: last.cachedInputTokens, outputTokens: last.outputTokens, totalTokens: last.totalTokens });
        return;
      }
      case 'turn/completed': {
        const { turn } = n.params as TurnNotification;
        this.completedTurns.set(turn.id, turn);
        if (turn.id === this.turnId) {
          this.turnActive = false;
        }
        const waiter = this.turnWaiters.get(turn.id);
        if (waiter) {
          this.turnWaiters.delete(turn.id);
          waiter.resolve(turn);
        }
        return;
      }
      default:
        for (const e of this.translator!.translate(n, (itemId) => this.decidedItems.has(itemId))) {
          this.applier!.apply(e);
        }
    }
  }

  private async onServerRequest(method: string, params: unknown, sink: OperationSink): Promise<unknown> {
    const profile = this.options.profile;
    switch (method) {
      case SERVER_REQUEST.commandApproval: {
        const p = params as CommandApprovalParams;
        const opId = this.operationForApproval(p.itemId, p.approvalId, sink, () => ({
          operationType: 'Execute',
          description: `Run: ${p.command ?? '(command not provided)'}`,
          command: p.command ? { command: p.command, workingDirectory: p.cwd ?? '' } : undefined,
          externalId: p.itemId,
        }));
        if (profile.commandApprovals === 'auto-decline') {
          sink.autoDecide(opId, 'rejected', `the "${profile.label}" profile never grants command approvals`);
          return { decision: 'decline' satisfies ApprovalDecision };
        }
        const { decision, reason, blocked } = await sink.requestDecision(opId, p.reason ?? undefined);
        if (decision === 'approved') {
          // Observed 2026-11: an approved command can run outside the read-only sandbox and write files.
          sink.markRunning(opId, 'Approved by user; Codex runs it (an approved command may run outside the read-only sandbox)');
        } else if (decision === 'rejected' && reason) {
          this.deliverReason(sink, 'command', p.command ?? '', reason, blocked);
        }
        return { decision: toCodexDecision(decision) };
      }

      case SERVER_REQUEST.fileChangeApproval: {
        const p = params as FileChangeApprovalParams;
        const opId = this.operationForApproval(p.itemId, undefined, sink, () => ({
          operationType: 'Edit',
          description: 'Codex patch (content not reported)',
          externalId: p.itemId,
        }));
        const paths = this.translator!.patchPaths.get(p.itemId);
        if (profile.fileChanges === 'auto-decline') {
          sink.autoDecide(opId, 'rejected', `the "${profile.label}" profile does not allow file changes`);
          return { decision: 'decline' };
        }
        if (!paths || paths.length === 0) {
          sink.autoDecide(opId, 'rejected', 'Codex did not report the patch content, so it cannot be reviewed');
          return { decision: 'decline' };
        }
        const outside = paths.find((f) => !this.mapper!.isInsideWorkspace(f) || /(^|[\\/])\.git([\\/]|$)/.test(f));
        if (outside) {
          sink.autoDecide(opId, 'rejected', `patch touches a path outside the workspace or inside .git: ${outside}`);
          return { decision: 'decline' };
        }
        if (p.grantRoot) {
          sink.autoDecide(opId, 'rejected', `Codex asked for session-wide write access to ${p.grantRoot}; only single patches can be approved`);
          return { decision: 'decline' };
        }
        const { decision, reason } = await sink.requestDecision(opId, p.reason ?? undefined);
        if (decision === 'approved') {
          sink.markRunning(opId, 'Approved by user; Codex applies this entire patch');
        } else if (decision === 'rejected' && reason) {
          this.deliverReason(sink, 'file change', paths.join(', '), reason);
        }
        return { decision: toCodexDecision(decision) };
      }

      case SERVER_REQUEST.permissionsApproval: {
        const p = params as { itemId?: string; reason?: string | null; permissions?: unknown };
        const opId = sink.announce({
          operationType: 'Execute',
          description: 'Codex requested additional sandbox permissions',
          rationale: `${p.reason ?? ''} ${JSON.stringify(p.permissions ?? {}).slice(0, 300)}`.trim(),
          externalId: p.itemId,
        });
        sink.autoDecide(opId, 'rejected', 'Visual Agent Workspace never widens the sandbox');
        return { permissions: {}, scope: 'turn' };
      }

      case SERVER_REQUEST.userInput: {
        const opId = sink.announce({ operationType: 'Analyze', description: 'Codex asked a question (interactive input is not supported)' });
        sink.autoDecide(opId, 'rejected', 'answered with no input; use "Send instruction" to reply');
        return { answers: {} };
      }
      case SERVER_REQUEST.elicitation:
        sink.log('[codex] MCP elicitation declined');
        return { action: 'decline', content: null, _meta: null };
      case SERVER_REQUEST.dynamicToolCall:
        return { contentItems: [], success: false };
      case SERVER_REQUEST.legacyExecApproval:
      case SERVER_REQUEST.legacyPatchApproval:
        return { decision: { denied: { rejection: 'Not supported by Visual Agent Workspace' } } };
      default:
        sink.log(`[codex] unsupported server request ${method}`);
        throw new RpcError(`Visual Agent Workspace does not support ${method}`, -32601);
    }
  }

  /**
   * The approval normally refers to an item already announced via
   * item/started. If that item was already decided (multiple approval
   * callbacks for one item), a separate operation is recorded.
   */
  private operationForApproval(
    itemId: string,
    approvalId: string | null | undefined,
    sink: OperationSink,
    fallback: () => Parameters<OperationSink['announce']>[0],
  ): string {
    const existing = this.applier!.operationId(itemId);
    if (existing && !this.decidedItems.has(itemId)) {
      this.decidedItems.add(itemId);
      return existing;
    }
    const opId = sink.announce({ ...fallback(), externalId: approvalId ? `${itemId}#${approvalId}` : itemId });
    if (!existing) {
      this.applier!.bind(itemId, opId);
      this.translator!.markAnnounced(itemId);
    }
    this.decidedItems.add(itemId);
    return opId;
  }
}

function toCodexDecision(d: 'approved' | 'rejected' | 'cancelled'): ApprovalDecision {
  // Single-use decisions only: never "acceptForSession" or policy amendments.
  return d === 'approved' ? 'accept' : d === 'rejected' ? 'decline' : 'cancel';
}

function readTextSafe(p: string): string | undefined {
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && stat.size < 2_000_000 ? fs.readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}
