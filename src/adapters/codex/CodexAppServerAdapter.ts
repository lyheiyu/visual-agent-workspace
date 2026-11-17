import * as fs from 'node:fs';
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
import {
  ApprovalDecision,
  CommandApprovalParams,
  FileChangeApprovalParams,
  RpcNotification,
  SERVER_REQUEST,
  textInput,
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
 * - Starts its OWN `codex app-server` process and an ephemeral thread. It
 *   cannot see or control any other Codex session (e.g. the Codex VS Code
 *   extension); those run in separate processes.
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
  readonly capabilities: AdapterCapabilities = { pause: false, interrupt: true, steer: true };
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

  constructor(private readonly options: CodexAdapterOptions) {
    this.displayName = `Codex (${options.profile.label})`;
    this.boundary = options.profile.boundary;
  }

  async run(ctx: AgentTaskContext, sink: OperationSink, signal: AbortSignal): Promise<StreamingRunResult> {
    if (!ctx.workspaceRoot) {
      throw new Error('Codex mode needs an open workspace folder.');
    }
    const profile = this.options.profile;
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
      const started = await client.request<ThreadStartResponse>('thread/start', {
        cwd: ctx.workspaceRoot,
        model,
        approvalPolicy: profile.approvalPolicy,
        sandbox: profile.sandbox,
        ephemeral: true,
        serviceName: 'visual-agent-workspace',
      });
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
      const sessionOp = sink.announce({
        operationType: 'Analyze',
        description: `Codex session started: ${started.model}${this.options.effort ? ` (effort ${this.options.effort})` : ''}, read-only sandbox, approval "${profile.approvalPolicy}"`,
        rationale: profile.boundary,
        externalId: started.thread.id,
      });
      sink.complete(sessionOp, {
        outcome: 'Completed',
        resultSummary: `Thread ${started.thread.id} (ephemeral) in ${started.cwd}. Boundary confirmed by Codex: sandbox=readOnly, approvalPolicy=${profile.approvalPolicy}.`,
      });
      if (signal.aborted) {
        return { outcome: 'interrupted' };
      }

      const res = await client.request<{ turn: Turn }>('turn/start', {
        threadId: this.threadId,
        input: [textInput(ctx.description)],
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
      return { outcome: 'completed' };
    } finally {
      this.turnActive = false;
      await client.close();
      this.client = undefined;
    }
  }

  async interrupt(): Promise<void> {
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

  async steer(text: string): Promise<void> {
    if (!this.client || !this.threadId || !this.turnId || !this.turnActive) {
      throw new Error('Codex has no active turn to send the instruction to.');
    }
    // expectedTurnId: Codex rejects the instruction if a different turn is active,
    // so it can never be applied to work the user did not see.
    await this.client.request('turn/steer', {
      threadId: this.threadId,
      input: [textInput(text)],
      expectedTurnId: this.turnId,
    }, 15_000);
  }

  dispose(): void {
    void this.client?.close();
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
        const { decision } = await sink.requestDecision(opId, p.reason ?? undefined);
        if (decision === 'approved') {
          sink.markRunning(opId, 'Approved by user; Codex runs it inside the read-only sandbox');
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
        const { decision } = await sink.requestDecision(opId, p.reason ?? undefined);
        if (decision === 'approved') {
          sink.markRunning(opId, 'Approved by user; Codex applies this entire patch');
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
