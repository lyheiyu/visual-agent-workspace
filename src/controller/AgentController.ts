import { randomUUID } from 'node:crypto';
import {
  AdapterCapabilities,
  AgentAdapter,
  AgentTaskContext,
  AnnouncedOperation,
  AnyAgentAdapter,
  isStreamingAdapter,
  OperationCompletion,
  OperationDecision,
  OperationRequest,
  OperationSink,
  StreamingAgentAdapter,
  StreamingRunResult,
} from '../adapters/AgentAdapter';
import { EventRecorder } from '../recorder/EventRecorder';
import { buildTaskSummary } from '../recorder/summary';
import { AgentOperation, ProposedChangeContent, TaskStatus, TERMINAL_STATUSES } from '../types/events';
import { Emitter } from '../util/emitter';

/** Decides whether an operation must be approved by the user before it runs. */
export type ApprovalPolicy = (request: OperationRequest) => boolean;

/** Default: any operation that changes code requires approval. */
export const defaultApprovalPolicy: ApprovalPolicy = (r) => r.operationType === 'Edit' || !!r.change;

/** Edits and command execution require approval. */
export const strictApprovalPolicy: ApprovalPolicy = (r) =>
  defaultApprovalPolicy(r) || !!r.command || r.operationType === 'Execute' || r.operationType === 'Test';

export interface ControllerOptions {
  /** Delay between operations (read on every step so settings apply live). */
  stepDelayMs: () => number;
  approvalPolicy?: () => ApprovalPolicy;
  workspaceRoot: () => string;
  log?: (message: string) => void;
}

export interface ControllerSnapshot {
  taskId?: string;
  /** 'Idle' before the first task; otherwise the current/last task status. */
  taskStatus: TaskStatus | 'Idle';
  paused: boolean;
  /** First operation awaiting an approve/reject decision. */
  awaitingApprovalFor?: string;
  /** All operations awaiting a decision, oldest first. */
  pendingApprovals: string[];
  currentOperationId?: string;
  adapterName: string;
  adapterId: string;
  simulated: boolean;
  capabilities: AdapterCapabilities;
  /** Enforced boundary of the current adapter (streaming adapters only). */
  boundary?: string;
  /** Multi-turn session idle and waiting for the next instruction. */
  awaitingInput: boolean;
}

type DispatchOutcome = 'completed' | 'failed' | 'rejected' | 'cancelled';

const MOCK_CAPABILITIES: AdapterCapabilities = { pause: true, interrupt: true, steer: false };
const MAX_INSTRUCTION_CHARS = 4000;

/**
 * Agent Controller: the execution state machine.
 *
 * Pull adapters (mock): every operation follows Propose → Inspect →
 * Approve/Reject → Execute → Record → Review, and the controller is the only
 * component that calls `execute()`.
 *
 * Streaming adapters (Codex): the agent decides what to run. The controller
 * records what it reports and, when the agent asks for approval, holds the
 * agent until the user decides. Operations the agent did not ask about are
 * recorded as observed-only (enforcement: 'none').
 *
 * Invariants:
 * - At most one task runs at a time.
 * - Pause only stops new dispatch, and only where the adapter supports it.
 * - Stop cancels every pending decision, interrupts/aborts the running work,
 *   prevents further dispatch, and always ends the task as 'Stopped'.
 * - approve()/reject() only succeed for operations actually pending.
 */
export class AgentController {
  private readonly stateEmitter = new Emitter<ControllerSnapshot>();
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly changeEmitter = new Emitter<ProposedChangeContent>();
  /** Fired with full change content (for the review UI). Never persisted. */
  readonly onDidProposeChange = this.changeEmitter.event;

  private adapter: AnyAgentAdapter;
  private taskId: string | undefined;
  private taskStatus: TaskStatus | 'Idle' = 'Idle';
  private paused = false;
  private stopRequested = false;
  private currentOperationId: string | undefined;
  private readonly pendingDecisions = new Map<string, (d: OperationDecision, reason?: string) => void>();
  private resumeWaiters: Array<() => void> = [];
  private sleepers = new Set<() => void>();
  private abort: AbortController | undefined;
  private runPromise: Promise<void> | undefined;
  private awaitingInput = false;

  constructor(
    defaultAdapter: AgentAdapter,
    private readonly recorder: EventRecorder,
    private readonly options: ControllerOptions,
  ) {
    this.adapter = defaultAdapter;
  }

  // -------------------------------------------------------------- queries

  get isActive(): boolean {
    return this.taskStatus === 'Running';
  }

  getSnapshot(): ControllerSnapshot {
    const pending = [...this.pendingDecisions.keys()];
    const streaming = isStreamingAdapter(this.adapter);
    return {
      taskId: this.taskId,
      taskStatus: this.taskStatus,
      paused: this.paused,
      awaitingApprovalFor: pending[0],
      pendingApprovals: pending,
      currentOperationId: this.currentOperationId,
      adapterName: this.adapter.displayName,
      adapterId: this.adapter.id,
      simulated: this.adapter.simulated,
      capabilities: streaming ? (this.adapter as StreamingAgentAdapter).capabilities : MOCK_CAPABILITIES,
      boundary: streaming ? (this.adapter as StreamingAgentAdapter).boundary : undefined,
      awaitingInput: this.isActive && this.awaitingInput,
    };
  }

  /** Resolves when the current task loop has fully finished. */
  whenIdle(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  // ------------------------------------------------------------- commands

  /** Start a task (with the default adapter unless one is given). Returns its ID. */
  start(description: string, adapter?: AnyAgentAdapter, workspaceRoot?: string, continuation?: { taskId: string; userMessage: string }): string {
    if (this.isActive) {
      throw new Error('A task is already running. Stop it before starting another.');
    }
    if (adapter) {
      this.adapter = adapter;
    }
    const existing = continuation ? this.recorder.getTask(continuation.taskId) : undefined;
    if (continuation && (!existing || existing.source !== this.adapter.id || existing.workspaceRoot && existing.workspaceRoot !== (workspaceRoot ?? this.options.workspaceRoot()))) {
      throw new Error('The saved conversation provider or project does not match this task.');
    }
    const task = continuation ? this.recorder.reopenTask(continuation.taskId) : this.recorder.startTask({
      description,
      source: this.adapter.id,
      adapterName: this.adapter.displayName,
      simulated: this.adapter.simulated,
      workspaceRoot: workspaceRoot ?? this.options.workspaceRoot(),
    });
    this.taskId = task.taskId;
    this.recorder.recordMessage(task.taskId, 'user', continuation?.userMessage ?? description);
    this.recorder.startTurn(task.taskId);
    this.taskStatus = 'Running';
    this.paused = false;
    this.stopRequested = false;
    this.currentOperationId = undefined;
    this.awaitingInput = false;
    this.abort = new AbortController();
    const ctx: AgentTaskContext = {
      taskId: task.taskId,
      description,
      workspaceRoot: workspaceRoot ?? this.options.workspaceRoot(),
    };
    this.emitState();
    this.runPromise = isStreamingAdapter(this.adapter) ? this.runStreaming(ctx, this.adapter) : this.run(ctx, this.adapter);
    return task.taskId;
  }

  pause(): boolean {
    if (!this.isActive || this.paused || this.stopRequested || !this.getSnapshot().capabilities.pause) {
      return false;
    }
    this.paused = true;
    this.emitState();
    return true;
  }

  resume(): boolean {
    if (!this.isActive || !this.paused) {
      return false;
    }
    this.paused = false;
    this.flushResumeWaiters();
    this.emitState();
    return true;
  }

  stop(): boolean {
    if (!this.isActive || this.stopRequested) {
      return false;
    }
    this.stopRequested = true;
    this.paused = false;
    this.abort?.abort();
    for (const resolve of [...this.pendingDecisions.values()]) {
      resolve('cancelled');
    }
    this.flushResumeWaiters();
    for (const wake of [...this.sleepers]) {
      wake();
    }
    if (isStreamingAdapter(this.adapter)) {
      const adapter = this.adapter;
      adapter.interrupt().catch((err) => this.log(`interrupt failed: ${errorMessage(err)}`));
    }
    this.emitState();
    return true;
  }

  approve(operationId: string): boolean {
    return this.decide(operationId, 'approved');
  }

  reject(operationId: string, reason?: string): boolean {
    return this.decide(operationId, 'rejected', reason);
  }

  /**
   * Intervention: add an instruction to the active turn (streaming adapters
   * that support it). Recorded in the audit trail as an 'Instruct' operation.
   * Instructions cannot change sandbox or approval policy.
   */
  async steer(text: string): Promise<AgentOperation> {
    const adapter = this.adapter;
    const trimmed = text.trim();
    if (!this.isActive || this.stopRequested || !this.taskId) {
      throw new Error('No running task to send an instruction to.');
    }
    if (!isStreamingAdapter(adapter) || !adapter.capabilities.steer || !adapter.steer) {
      throw new Error(`${adapter.displayName} does not accept instructions during a task.`);
    }
    if (adapter.capabilities.followUp && (!this.awaitingInput || this.pendingDecisions.size)) {
      throw new Error('Wait for the current turn and any pending approvals to finish before sending a follow-up.');
    }
    if (!trimmed) {
      throw new Error('The instruction is empty.');
    }
    if (trimmed.length > MAX_INSTRUCTION_CHARS) {
      throw new Error(`Instructions are limited to ${MAX_INSTRUCTION_CHARS} characters.`);
    }
    const wasWaiting = this.awaitingInput;
    if (wasWaiting) {
      this.recorder.startTurn(this.taskId);
      this.awaitingInput = false;
      this.emitState();
    }
    this.recorder.recordMessage(this.taskId, 'user', trimmed);
    const op = this.recorder.recordOperation(this.taskId, {
      source: 'user',
      simulated: adapter.simulated,
      operationType: 'Instruct',
      description: `Instruction: ${trimmed.length > 160 ? trimmed.slice(0, 157) + '…' : trimmed}`,
      rationale: trimmed,
      requiresApproval: false,
      enforcement: 'none',
    });
    try {
      await adapter.steer(trimmed);
      return this.recorder.updateOperation(
        op.operationId,
        { status: 'Completed', resultSummary: 'Delivered to the active turn.' },
        { actor: 'user', note: 'Instruction sent' },
      );
    } catch (err) {
      this.recorder.updateOperation(
        op.operationId,
        { status: 'Failed', resultSummary: `Not delivered: ${errorMessage(err)}` },
        { actor: 'controller' },
      );
      if (wasWaiting) {
        this.recorder.finishTurn(this.taskId!, 'Failed', errorMessage(err));
        this.awaitingInput = true;
        this.emitState();
      }
      throw err;
    }
  }

  /** Multi-turn adapters: end the session gracefully (the task completes). */
  async endSession(): Promise<boolean> {
    const adapter = this.adapter;
    if (!this.isActive || this.stopRequested || !isStreamingAdapter(adapter) || !adapter.endSession) {
      return false;
    }
    if (!this.awaitingInput || this.pendingDecisions.size) throw new Error('The agent is still working. Use Stop to interrupt, or wait for the turn to finish.');
    for (const resolve of [...this.pendingDecisions.values()]) {
      resolve('cancelled');
    }
    await adapter.endSession();
    return true;
  }

  dispose(): void {
    this.stop();
    this.stateEmitter.dispose();
    this.changeEmitter.dispose();
  }

  // ------------------------------------------------- pull adapters (mock)

  private async run(ctx: AgentTaskContext, adapter: AgentAdapter): Promise<void> {
    let fatal: unknown;
    const signal = this.abort!.signal;
    try {
      await adapter.beginTask(ctx);
      while (!this.stopRequested) {
        await this.waitWhilePaused();
        if (this.stopRequested) {
          break;
        }
        const request = await adapter.nextOperation(ctx, signal);
        if (!request || this.stopRequested) {
          break;
        }
        await this.dispatch(ctx, adapter, request, signal);
        if (this.stopRequested) {
          break;
        }
        await this.sleep(Math.max(0, this.options.stepDelayMs()));
      }
    } catch (err) {
      if (!this.stopRequested) {
        fatal = err;
      }
    }
    try {
      await adapter.endTask?.(ctx, this.stopRequested ? 'Stopped' : fatal ? 'Failed' : 'Completed');
    } catch {
      /* adapter cleanup errors must not affect controller state */
    }
    this.finish(ctx, fatal);
  }

  private async dispatch(
    ctx: AgentTaskContext,
    adapter: AgentAdapter,
    request: OperationRequest,
    signal: AbortSignal,
  ): Promise<DispatchOutcome> {
    const policy = this.options.approvalPolicy?.() ?? defaultApprovalPolicy;
    const requiresApproval = !!request.requiresApproval || policy(request);
    const changeId = request.change ? `chg-${randomUUID()}` : undefined;

    // ---- Propose
    let op = this.recorder.recordOperation(ctx.taskId, {
      source: adapter.id,
      simulated: adapter.simulated,
      operationType: request.operationType,
      description: request.description,
      rationale: request.rationale,
      filePath: request.filePath ?? request.change?.filePath,
      functionName: request.functionName ?? request.change?.functionName,
      lineNumber: request.lineNumber,
      command: request.command && {
        command: request.command.command,
        workingDirectory: request.command.workingDirectory,
        simulated: adapter.simulated,
        status: 'Pending',
      },
      workingDirectory: request.command?.workingDirectory,
      associatedChangeId: changeId,
      requiresApproval,
      enforcement: 'controller',
    });
    this.currentOperationId = op.operationId;

    if (request.change && changeId) {
      this.recorder.recordChange({
        changeId,
        taskId: ctx.taskId,
        operationId: op.operationId,
        filePath: request.change.filePath,
        functionName: request.change.functionName,
        rationale: request.rationale,
      });
      this.changeEmitter.fire({
        changeId,
        taskId: ctx.taskId,
        operationId: op.operationId,
        filePath: request.change.filePath,
        functionName: request.change.functionName,
        replacementText: request.change.replacementText,
        rationale: request.rationale,
      });
    }
    this.emitState();

    // ---- Inspect / Approve / Reject
    if (requiresApproval) {
      const { decision, reason } = await this.awaitDecision(op.operationId);
      adapter.onDecision?.(op, decision, reason);
      this.recordChangeDecision(op, decision, reason);
      if (decision === 'cancelled') {
        return this.cancel(op, 'Task stopped before a decision was made');
      }
      if (decision === 'rejected') {
        this.recorder.updateOperation(
          op.operationId,
          { status: 'Rejected', command: op.command ? { status: 'NotRun' } : undefined },
          { actor: 'user', note: reason ? `Rejected by user: ${reason}` : 'Rejected by user' },
        );
        this.currentOperationId = undefined;
        this.emitState();
        return 'rejected';
      }
      op = this.recorder.addNote(op.operationId, 'user', 'Approved by user');
      // The user may have paused while the decision was pending.
      await this.waitWhilePaused();
      if (this.stopRequested) {
        return this.cancel(op, 'Task stopped after approval, before execution');
      }
    }

    // ---- Execute
    op = this.recorder.updateOperation(
      op.operationId,
      {
        status: 'Running',
        command: op.command ? { status: 'Running', startedAt: new Date().toISOString() } : undefined,
      },
      { actor: 'controller' },
    );
    this.emitState();

    let result;
    try {
      result = await adapter.execute(op, signal);
    } catch (err) {
      if (this.stopRequested) {
        return this.cancel(op, 'Task stopped while operation was running');
      }
      result = { outcome: 'Failed' as const, resultSummary: `Adapter error: ${errorMessage(err)}` };
    }
    if (this.stopRequested) {
      return this.cancel(op, 'Task stopped while operation was running');
    }

    // ---- Record
    const ok = result.outcome === 'Completed';
    this.recorder.updateOperation(
      op.operationId,
      {
        status: result.outcome,
        resultSummary: result.resultSummary,
        command:
          op.command &&
          (result.command
            ? {
                status: result.command.exitCode === 0 ? 'Succeeded' : 'Failed',
                startedAt: result.command.startedAt,
                finishedAt: result.command.finishedAt,
                exitCode: result.command.exitCode,
                stdout: result.command.stdout,
                stderr: result.command.stderr,
              }
            : { status: ok ? 'Succeeded' : 'Failed', finishedAt: new Date().toISOString() }),
      },
      { actor: 'agent' },
    );
    this.currentOperationId = undefined;
    this.emitState();
    return ok ? 'completed' : 'failed';
  }

  // -------------------------------------------- streaming adapters (Codex)

  private async runStreaming(ctx: AgentTaskContext, adapter: StreamingAgentAdapter): Promise<void> {
    let fatal: unknown;
    let result: StreamingRunResult | undefined;
    try {
      result = await adapter.run(ctx, this.createSink(ctx, adapter), this.abort!.signal);
      if (result.outcome === 'failed' && !this.stopRequested) {
        fatal = new Error(result.message ?? 'The agent reported a failed turn.');
      }
    } catch (err) {
      if (!this.stopRequested) {
        fatal = err;
      }
    }
    // Anything still open when the agent finished can no longer change.
    for (const op of this.recorder.getOperations(ctx.taskId)) {
      if (!TERMINAL_STATUSES.has(op.status)) {
        this.recorder.updateOperation(
          op.operationId,
          { status: 'Cancelled', command: op.command ? { status: op.command.status === 'Running' ? 'Cancelled' : 'NotRun' } : undefined },
          { actor: 'controller', note: this.stopRequested ? 'Task stopped' : 'Agent turn ended before this operation finished' },
        );
      }
    }
    this.finish(ctx, fatal);
  }

  private createSink(ctx: AgentTaskContext, adapter: StreamingAgentAdapter): OperationSink {
    const isOpen = (id: string) => {
      const op = this.recorder.getOperation(id);
      return !!op && !TERMINAL_STATUSES.has(op.status);
    };
    return {
      announce: (a: AnnouncedOperation) => {
        const changeIds = (a.changes ?? []).map(() => `chg-${randomUUID()}`);
        const op = this.recorder.recordOperation(ctx.taskId, {
          source: adapter.id,
          simulated: adapter.simulated,
          operationType: a.operationType,
          description: a.description,
          rationale: a.rationale,
          filePath: a.filePath,
          functionName: a.functionName,
          lineNumber: a.lineNumber,
          command: a.command && {
            command: a.command.command,
            workingDirectory: a.command.workingDirectory,
            simulated: adapter.simulated,
            status: 'Pending',
            startedAt: a.command.startedAt,
          },
          workingDirectory: a.command?.workingDirectory,
          associatedChangeId: changeIds[0],
          associatedChangeIds: changeIds.length ? changeIds : undefined,
          requiresApproval: false,
          enforcement: 'none',
          externalId: a.externalId,
          changedRanges: a.changedRanges,
          affectedFunctions: a.affectedFunctions,
        });
        (a.changes ?? []).forEach((c, i) => {
          this.recorder.recordChange({
            changeId: changeIds[i],
            taskId: ctx.taskId,
            operationId: op.operationId,
            filePath: c.filePath,
            functionName: c.functionName,
            rationale: a.rationale,
          });
          this.changeEmitter.fire({
            changeId: changeIds[i],
            taskId: ctx.taskId,
            operationId: op.operationId,
            filePath: c.filePath,
            functionName: c.functionName,
            unifiedDiff: c.unifiedDiff,
            changeKind: c.changeKind,
            rationale: a.rationale,
          });
        });
        this.currentOperationId = op.operationId;
        this.emitState();
        return op.operationId;
      },

      markRunning: (id, note) => {
        const op = this.recorder.getOperation(id);
        if (!op || op.status !== 'Proposed') {
          return;
        }
        this.recorder.updateOperation(
          id,
          { status: 'Running', command: op.command ? { status: 'Running', startedAt: op.command.startedAt ?? new Date().toISOString() } : undefined },
          { actor: 'agent', note },
        );
        this.currentOperationId = id;
        this.emitState();
      },

      complete: (id, c: OperationCompletion) => {
        const op = this.recorder.getOperation(id);
        if (!op) {
          return;
        }
        if (TERMINAL_STATUSES.has(op.status)) {
          if (op.status !== c.outcome) {
            this.log(`ignored late ${c.outcome} for ${id} (already ${op.status})`);
          }
          return;
        }
        if (c.assistantMessage && c.resultSummary) {
          this.recorder.recordMessage(ctx.taskId, 'assistant', c.resultSummary);
        }
        if (op.status === 'Proposed' && (c.outcome === 'Completed' || c.outcome === 'Failed')) {
          // It finished without us ever seeing it start: it ran unobserved by any gate.
          this.recorder.updateOperation(id, { status: 'Running' }, { actor: 'agent', note: 'Executed by the agent without requesting approval (observed only)' });
        }
        const commandStatus =
          c.outcome === 'Rejected' ? 'NotRun' : c.outcome === 'Cancelled' ? 'Cancelled' : c.command?.exitCode === 0 || (c.command?.exitCode === undefined && c.outcome === 'Completed') ? 'Succeeded' : 'Failed';
        this.recorder.updateOperation(
          id,
          {
            status: c.outcome,
            resultSummary: c.resultSummary,
            command: op.command
              ? {
                  status: commandStatus,
                  finishedAt: c.command?.finishedAt ?? new Date().toISOString(),
                  exitCode: c.command?.exitCode,
                  stdout: c.command?.stdout,
                  outputCombined: c.command?.outputCombined,
                }
              : undefined,
          },
          { actor: 'agent', note: c.note },
        );
        if (this.currentOperationId === id) {
          this.currentOperationId = undefined;
        }
        this.emitState();
      },

      requestDecision: async (id, reason) => {
        if (!isOpen(id)) {
          return { decision: 'cancelled' as const };
        }
        this.recorder.updateOperation(
          id,
          { requiresApproval: true, enforcement: 'agent-approval' },
          { actor: 'agent' },
        );
        this.recorder.addNote(id, 'agent', `Agent is waiting for approval${reason ? `: ${reason}` : ''}`);
        const result = await this.awaitDecision(id);
        const op = this.recorder.getOperation(id)!;
        this.recordChangeDecision(op, result.decision, result.reason);
        if (result.decision === 'approved') {
          this.recorder.addNote(id, 'user', 'Approved by user; the agent may now run it');
        } else if (result.decision === 'rejected') {
          this.recorder.updateOperation(
            id,
            { status: 'Rejected', command: op.command ? { status: 'NotRun' } : undefined },
            { actor: 'user', note: result.reason ? `Rejected by user: ${result.reason}` : 'Rejected by user' },
          );
        } else if (isOpen(id)) {
          this.recorder.updateOperation(
            id,
            { status: 'Cancelled', command: op.command ? { status: 'NotRun' } : undefined },
            { actor: 'user', note: 'Task stopped before a decision was made' },
          );
        }
        this.emitState();
        return result;
      },

      autoDecide: (id, _decision, reason) => {
        const op = this.recorder.getOperation(id);
        if (!op || !isOpen(id)) {
          return;
        }
        this.recorder.updateOperation(id, { requiresApproval: true, enforcement: 'agent-approval' }, { actor: 'agent' });
        this.recordChangeDecision(op, 'rejected', reason);
        this.recorder.updateOperation(
          id,
          { status: 'Rejected', command: op.command ? { status: 'NotRun' } : undefined },
          { actor: 'controller', note: `Declined automatically: ${reason}` },
        );
        this.emitState();
      },

      log: (m) => this.log(m),

      setAwaitingInput: (waiting) => {
        if (waiting && (this.stopRequested || this.pendingDecisions.size)) return;
        if (this.awaitingInput !== waiting) {
          if (waiting) this.recorder.finishTurn(ctx.taskId, 'Completed');
          this.awaitingInput = waiting;
          if (waiting) this.currentOperationId = undefined;
          this.emitState();
        }
      },
      setSession: (session) => this.recorder.setSession(ctx.taskId, session),
    };
  }

  // -------------------------------------------------------------- shared

  private finish(ctx: AgentTaskContext, fatal: unknown): void {
    const status: TaskStatus = this.stopRequested ? 'Stopped' : fatal ? 'Failed' : 'Completed';
    this.recorder.finishTurn(ctx.taskId, status, fatal ? errorMessage(fatal) : undefined);
    const task = this.recorder.getTask(ctx.taskId)!;

    // Record a summary operation built from the audit trail itself.
    const ops = this.recorder.getOperations(ctx.taskId);
    if (ops.length > 0 || fatal) {
      const summaryOp = this.recorder.recordOperation(ctx.taskId, {
        source: 'system',
        simulated: this.adapter.simulated,
        operationType: 'Summary',
        description: 'Generate operation summary',
        requiresApproval: false,
        enforcement: 'controller',
      });
      const counts = countBy(ops.map((o) => o.status));
      this.recorder.updateOperation(
        summaryOp.operationId,
        {
          status: 'Completed',
          resultSummary:
            `Task ${status.toLowerCase()}. ` +
            Object.entries(counts)
              .map(([s, n]) => `${n} ${s.toLowerCase()}`)
              .join(', ') +
            (fatal ? `. Error: ${errorMessage(fatal)}` : ''),
        },
        { actor: 'controller' },
      );
    }
    const summary = buildTaskSummary(
      task,
      status,
      this.recorder.getOperations(ctx.taskId),
      this.recorder.getChanges(ctx.taskId),
      fatal ? errorMessage(fatal) : undefined,
    );
    this.recorder.finishTask(ctx.taskId, status, summary);

    this.taskStatus = status;
    this.paused = false;
    this.pendingDecisions.clear();
    this.currentOperationId = undefined;
    this.awaitingInput = false;
    this.abort = undefined;
    this.emitState();
  }

  private recordChangeDecision(op: AgentOperation, decision: OperationDecision, reason?: string): void {
    const ids = op.associatedChangeIds ?? (op.associatedChangeId ? [op.associatedChangeId] : []);
    const map = { approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' } as const;
    for (const id of ids) {
      this.recorder.decideChange(id, map[decision], reason);
    }
  }

  private decide(operationId: string, decision: 'approved' | 'rejected', reason?: string): boolean {
    const resolve = this.pendingDecisions.get(operationId);
    if (!this.isActive || this.stopRequested || !resolve) {
      return false;
    }
    resolve(decision, reason);
    return true;
  }

  private awaitDecision(operationId: string): Promise<{ decision: OperationDecision; reason?: string }> {
    if (this.stopRequested) {
      return Promise.resolve({ decision: 'cancelled' });
    }
    return new Promise((resolve) => {
      this.pendingDecisions.set(operationId, (decision, reason) => {
        this.pendingDecisions.delete(operationId);
        resolve({ decision, reason });
      });
      this.emitState();
    });
  }

  private cancel(op: AgentOperation, note: string): DispatchOutcome {
    this.recorder.updateOperation(
      op.operationId,
      {
        status: 'Cancelled',
        command: op.command
          ? { status: op.command.status === 'Running' ? 'Cancelled' : 'NotRun' }
          : undefined,
      },
      { actor: 'user', note },
    );
    this.currentOperationId = undefined;
    return 'cancelled';
  }

  private waitWhilePaused(): Promise<void> {
    if (!this.paused || this.stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private flushResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((w) => w());
  }

  /** Delay that ends early when the task is stopped. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  private emitState(): void {
    this.stateEmitter.fire(this.getSnapshot());
  }

  private log(message: string): void {
    this.options.log?.(`[controller] ${message}`);
  }
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
