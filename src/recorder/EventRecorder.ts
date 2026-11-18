import { randomUUID } from 'node:crypto';
import { Emitter } from '../util/emitter';
import {
  Actor,
  AgentOperation,
  AgentSourceId,
  ChangeRecord,
  CommandExecution,
  OperationStatus,
  OperationType,
  TaskRecord,
  TaskStatus,
  TERMINAL_STATUSES,
} from '../types/events';
import { sanitize } from './redaction';

/** Pluggable persistence (VS Code workspaceState in the extension, memory in tests). */
export interface HistoryStorage {
  load(): PersistedHistory | undefined;
  save(history: PersistedHistory): void | PromiseLike<void>;
}

export interface PersistedHistory {
  version: 1;
  tasks: TaskRecord[];
  operations: AgentOperation[];
  changes: ChangeRecord[];
}

/** Keep both workspaces' records when VS Code must restart into a workspace file. */
export function mergeHistory(base: PersistedHistory | undefined, incoming: PersistedHistory): PersistedHistory {
  const merge = <T>(old: T[], fresh: T[], key: (item: T) => string) => [...new Map([...old, ...fresh].map((item) => [key(item), item])).values()];
  return {
    version: 1,
    tasks: merge(base?.tasks ?? [], incoming.tasks, (t) => t.taskId).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    operations: merge(base?.operations ?? [], incoming.operations, (o) => o.operationId),
    changes: merge(base?.changes ?? [], incoming.changes, (c) => c.changeId),
  };
}

export type RecorderChange =
  | { kind: 'task'; task: TaskRecord }
  | { kind: 'operation'; operation: AgentOperation; previousStatus?: OperationStatus }
  | { kind: 'change'; change: ChangeRecord }
  | { kind: 'reset' };

export interface NewOperationInput {
  source: AgentSourceId;
  simulated: boolean;
  operationType: OperationType;
  description: string;
  rationale?: string;
  filePath?: string;
  functionName?: string;
  lineNumber?: number;
  command?: CommandExecution;
  workingDirectory?: string;
  associatedChangeId?: string;
  associatedChangeIds?: string[];
  requiresApproval: boolean;
  enforcement?: AgentOperation['enforcement'];
  externalId?: string;
  changedRanges?: AgentOperation['changedRanges'];
  affectedFunctions?: AgentOperation['affectedFunctions'];
}

export type OperationPatch = Partial<
  Pick<
    AgentOperation,
    | 'status'
    | 'resultSummary'
    | 'exitCode'
    | 'filePath'
    | 'functionName'
    | 'lineNumber'
    | 'description'
    | 'requiresApproval'
    | 'enforcement'
  >
> & { command?: Partial<CommandExecution> };

export interface RecorderOptions {
  /** Maximum tasks kept in persisted history (oldest dropped first). */
  maxTasks?: number;
  /** Maximum characters kept per stdout/stderr/description field. */
  maxFieldChars?: number;
  /**
   * Coalesce persistence writes (ms). 0 = write on every change (tests).
   * Live sessions produce bursts of events; serializing history per event
   * would block the extension host.
   */
  persistDebounceMs?: number;
  /** Per-task cap; beyond it, the oldest finished operations lose bulky fields (output, summaries). */
  maxOperationsPerTask?: number;
  clock?: () => Date;
  idFactory?: (prefix: string) => string;
}

/**
 * Execution Event Recorder: the single source of truth for operation history.
 *
 * - Assigns IDs, per-task sequence numbers and timestamps.
 * - Keeps an append-only audit trail of status transitions per operation.
 * - Redacts secrets and truncates large outputs before storing anything.
 * - Never stores source-code contents (proposed change text lives only in
 *   the ChangeReviewManager's memory).
 */
export class EventRecorder {
  private tasks: TaskRecord[] = [];
  private operations: AgentOperation[] = [];
  private changes: ChangeRecord[] = [];
  private readonly sequence = new Map<string, number>();
  private readonly emitter = new Emitter<RecorderChange>();
  readonly onDidChange = this.emitter.event;

  private readonly maxTasks: number;
  private readonly maxFieldChars: number;
  private readonly persistDebounceMs: number;
  private readonly maxOperationsPerTask: number;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly clock: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly storage?: HistoryStorage, options: RecorderOptions = {}) {
    this.maxTasks = options.maxTasks ?? 20;
    this.maxFieldChars = options.maxFieldChars ?? 20_000;
    this.persistDebounceMs = options.persistDebounceMs ?? 0;
    this.maxOperationsPerTask = options.maxOperationsPerTask ?? 5_000;
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.idFactory ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.load();
  }

  // ---------------------------------------------------------------- tasks

  startTask(input: {
    description: string;
    source: AgentSourceId;
    adapterName: string;
    simulated: boolean;
    workspaceRoot?: string;
  }): TaskRecord {
    const task: TaskRecord = {
      taskId: this.newId('task'),
      description: this.clean(input.description) ?? '',
      source: input.source,
      adapterName: input.adapterName,
      simulated: input.simulated,
      status: 'Running',
      startedAt: this.now(),
      workspaceRoot: input.workspaceRoot,
    };
    this.tasks.push(task);
    this.sequence.set(task.taskId, 0);
    this.commit({ kind: 'task', task: clone(task) });
    return clone(task);
  }

  finishTask(taskId: string, status: TaskStatus, summary?: string): TaskRecord {
    const task = this.requireTask(taskId);
    task.status = status;
    task.finishedAt = this.now();
    task.updatedAt = task.finishedAt;
    task.summary = this.clean(summary);
    this.commit({ kind: 'task', task: clone(task) });
    return clone(task);
  }

  recordMessage(taskId: string, role: 'user' | 'assistant', text: string): void {
    const task = this.requireTask(taskId);
    task.messages = [...(task.messages ?? []), { role, text: this.clean(text) ?? '', timestamp: this.now() }].slice(-200);
    task.updatedAt = this.now();
    this.commit({ kind: 'task', task: clone(task) });
  }

  setLaunch(taskId: string, launch: NonNullable<TaskRecord['launch']>): void {
    const task = this.requireTask(taskId);
    task.launch = clone(launch);
    this.commit({ kind: 'task', task: clone(task) });
  }

  reopenTask(taskId: string): TaskRecord {
    const task = this.requireTask(taskId);
    if (task.status === 'Running') throw new Error('This conversation is already running.');
    task.status = 'Running';
    task.updatedAt = this.now();
    task.finishedAt = undefined;
    task.summary = undefined;
    this.commit({ kind: 'task', task: clone(task) });
    return clone(task);
  }

  setSession(taskId: string, session: NonNullable<TaskRecord['session']>): void {
    const task = this.requireTask(taskId);
    task.session = clone(session);
    this.commit({ kind: 'task', task: clone(task) });
  }

  startTurn(taskId: string): void {
    const task = this.requireTask(taskId);
    if (task.turns?.at(-1)?.status === 'Running') return;
    const number = (task.turns?.at(-1)?.number ?? 0) + 1;
    task.turns = [...(task.turns ?? []), { number, startedAt: this.now(), firstSequence: (this.sequence.get(taskId) ?? 0) + 1, status: 'Running' as const }].slice(-100);
    this.commit({ kind: 'task', task: clone(task) });
  }

  finishTurn(taskId: string, status: 'Completed' | 'Stopped' | 'Failed', error?: string): void {
    const task = this.requireTask(taskId);
    const turn = task.turns?.at(-1);
    if (!turn || turn.status !== 'Running') return;
    const ops = this.operations.filter((op) => op.taskId === taskId && op.sequenceNumber >= turn.firstSequence && op.operationType !== 'Summary');
    const edits = ops.filter((op) => op.operationType === 'Edit');
    const commands = ops.filter((op) => op.command);
    const failures = ops.filter((op) => op.status === 'Failed');
    turn.status = status;
    turn.finishedAt = this.now();
    turn.failedOperations = ops.filter((op) => op.status === 'Failed').length;
    turn.report = this.clean([
      `第 ${turn.number} 轮 / Turn ${turn.number} · ${status === 'Completed' && failures.length ? '本轮结束，有失败操作 / Finished with failed operations' : status}`,
      ...(error ? [`错误 / Error: ${error}`] : []),
      edits.length ? '文件修改 / File edits:\n' + edits.map((op) => `- ${op.filePath ?? op.description}: ${op.status}${op.simulated ? ' [SIMULATED]' : ''}`).join('\n') : '本轮没有记录到文件修改 / No recorded file edits.',
      commands.length ? '命令和测试 / Commands and tests:\n' + commands.map((op) => `- ${op.command!.command}: ${op.status}, exit ${op.command!.exitCode ?? 'unknown'}${op.simulated ? ' [SIMULATED]' : ''}`).join('\n') : '本轮未执行命令或测试 / No recorded commands or tests.',
      ...(failures.length ? ['失败详情 / Failure details:\n' + failures.slice(0, 10).map((op) => `- ${op.description}: ${(op.resultSummary ?? '').slice(0, 1500)}`).join('\n')] : []),
      `失败 ${ops.filter((op) => op.status === 'Failed').length} · 拒绝 ${ops.filter((op) => op.status === 'Rejected').length} · 取消 ${ops.filter((op) => op.status === 'Cancelled').length}`,
      '结果来自工具记录；不代表未记录的工作已完成。 / Results reflect recorded tools only.',
    ].join('\n\n'));
    this.commit({ kind: 'task', task: clone(task) });
  }

  // ----------------------------------------------------------- operations

  recordOperation(taskId: string, input: NewOperationInput): AgentOperation {
    this.requireTask(taskId);
    const seq = (this.sequence.get(taskId) ?? 0) + 1;
    this.sequence.set(taskId, seq);
    const timestamp = this.now();
    const op: AgentOperation = {
      taskId,
      operationId: this.newId('op'),
      sequenceNumber: seq,
      timestamp,
      source: input.source,
      simulated: input.simulated,
      operationType: input.operationType,
      status: 'Proposed',
      description: this.clean(input.description) ?? '',
      rationale: this.clean(input.rationale),
      filePath: input.filePath,
      functionName: input.functionName,
      lineNumber: input.lineNumber,
      command: input.command ? this.cleanCommand(input.command) : undefined,
      workingDirectory: input.workingDirectory ?? input.command?.workingDirectory,
      associatedChangeId: input.associatedChangeId,
      associatedChangeIds: input.associatedChangeIds,
      requiresApproval: input.requiresApproval,
      enforcement: input.enforcement ?? 'controller',
      externalId: input.externalId,
      changedRanges: input.changedRanges,
      affectedFunctions: input.affectedFunctions,
      history: [{ status: 'Proposed', timestamp, actor: 'agent' }],
    };
    this.operations.push(op);
    if (seq > this.maxOperationsPerTask) {
      this.compactTask(taskId);
    }
    this.commit({ kind: 'operation', operation: clone(op) });
    return clone(op);
  }

  /**
   * Apply a patch. A status change appends a transition to the audit trail;
   * terminal statuses are final and cannot be changed again.
   */
  updateOperation(
    operationId: string,
    patch: OperationPatch,
    transition: { actor: Actor; note?: string } = { actor: 'controller' },
  ): AgentOperation {
    const op = this.requireOperation(operationId);
    const previousStatus = op.status;
    if (patch.status && patch.status !== op.status && TERMINAL_STATUSES.has(op.status)) {
      throw new Error(`Operation ${operationId} is already ${op.status}; cannot become ${patch.status}`);
    }
    const { command, ...rest } = patch;
    Object.assign(op, rest);
    if (patch.resultSummary !== undefined) {
      op.resultSummary = this.clean(patch.resultSummary);
    }
    if (patch.description !== undefined) {
      op.description = this.clean(patch.description) ?? '';
    }
    if (command && op.command) {
      op.command = this.cleanCommand({ ...op.command, ...command });
      if (command.exitCode !== undefined) {
        op.exitCode = command.exitCode;
      }
    }
    if (patch.status && patch.status !== previousStatus) {
      op.history.push({
        status: patch.status,
        timestamp: this.now(),
        actor: transition.actor,
        note: this.clean(transition.note),
      });
    }
    this.commit({ kind: 'operation', operation: clone(op), previousStatus });
    return clone(op);
  }

  /** Append an audit note without changing status (e.g. "approved by user"). */
  addNote(operationId: string, actor: Actor, note: string): AgentOperation {
    const op = this.requireOperation(operationId);
    op.history.push({ status: op.status, timestamp: this.now(), actor, note: this.clean(note) });
    this.commit({ kind: 'operation', operation: clone(op), previousStatus: op.status });
    return clone(op);
  }

  // -------------------------------------------------------------- changes

  recordChange(change: Omit<ChangeRecord, 'decision' | 'decidedAt'>): ChangeRecord {
    const record: ChangeRecord = { ...change, rationale: this.clean(change.rationale), decision: 'Pending' };
    this.changes.push(record);
    this.commit({ kind: 'change', change: clone(record) });
    return clone(record);
  }

  decideChange(changeId: string, decision: ChangeRecord['decision'], reason?: string): ChangeRecord {
    const record = this.changes.find((c) => c.changeId === changeId);
    if (!record) {
      throw new Error(`Unknown change ${changeId}`);
    }
    record.decision = decision;
    record.decidedAt = this.now();
    record.decisionReason = this.clean(reason);
    this.commit({ kind: 'change', change: clone(record) });
    return clone(record);
  }

  // -------------------------------------------------------------- queries

  /** Tasks, newest first. */
  getTasks(): TaskRecord[] {
    return clone([...this.tasks].reverse().sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt)));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const t = this.tasks.find((x) => x.taskId === taskId);
    return t && clone(t);
  }

  exportHistory(): PersistedHistory {
    return clone({ version: 1, tasks: this.tasks, operations: this.operations, changes: this.changes });
  }

  /** Operations in chronological (sequence) order. */
  getOperations(taskId?: string): AgentOperation[] {
    return clone(this.operations.filter((o) => !taskId || o.taskId === taskId));
  }

  getOperation(operationId: string): AgentOperation | undefined {
    const o = this.operations.find((x) => x.operationId === operationId);
    return o && clone(o);
  }

  getChange(changeId: string): ChangeRecord | undefined {
    const c = this.changes.find((x) => x.changeId === changeId);
    return c && clone(c);
  }

  getChanges(taskId?: string): ChangeRecord[] {
    return clone(this.changes.filter((c) => !taskId || c.taskId === taskId));
  }

  clear(): void {
    this.tasks = [];
    this.operations = [];
    this.changes = [];
    this.sequence.clear();
    this.commit({ kind: 'reset' });
  }

  dispose(): void {
    this.flush();
    this.emitter.dispose();
  }

  // ------------------------------------------------------------ internals

  private load(): void {
    const data = this.storage?.load();
    if (!data || data.version !== 1 || !Array.isArray(data.tasks)) {
      return;
    }
    this.tasks = data.tasks;
    this.operations = data.operations ?? [];
    this.changes = data.changes ?? [];
    const now = this.now();
    // Anything left in flight when the window closed was interrupted.
    for (const op of this.operations) {
      if (!TERMINAL_STATUSES.has(op.status)) {
        op.status = 'Cancelled';
        op.history.push({ status: 'Cancelled', timestamp: now, actor: 'system', note: 'Interrupted: extension was reloaded' });
        if (op.command && (op.command.status === 'Pending' || op.command.status === 'Running')) {
          op.command.status = 'Cancelled';
        }
      }
    }
    for (const task of this.tasks) {
      if (task.status === 'Running') {
        task.status = 'Stopped';
        task.finishedAt = now;
        const turn = task.turns?.at(-1);
        if (turn?.status === 'Running') {
          turn.status = 'Stopped';
          turn.finishedAt = now;
          turn.report = '扩展重启，本轮中断；请检查实际文件和测试状态。 / Extension reloaded; this turn was interrupted. Recheck files and tests.';
        }
      }
    }
    for (const change of this.changes) {
      if (change.decision === 'Pending') {
        change.decision = 'Cancelled';
      }
    }
    for (const op of this.operations) {
      this.sequence.set(op.taskId, Math.max(this.sequence.get(op.taskId) ?? 0, op.sequenceNumber));
    }
  }

  private commit(change: RecorderChange): void {
    this.prune();
    if (this.storage) {
      if (this.persistDebounceMs > 0) {
        this.persistTimer ??= setTimeout(() => this.flush(), this.persistDebounceMs);
      } else {
        this.flush();
      }
    }
    this.emitter.fire(change);
  }

  /** Write pending history now (called on dispose and by the debounce timer). */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.storage) {
      return;
    }
    void Promise.resolve(
      this.storage.save({
        version: 1,
        tasks: this.tasks,
        operations: this.operations,
        changes: this.changes,
      }),
    ).catch((err) => console.error('[visual-agent] failed to persist history', err));
  }

  /** Bound memory for very long tasks: trim bulky fields of the oldest finished operations. */
  private compactTask(taskId: string): void {
    const ops = this.operations.filter((o) => o.taskId === taskId && TERMINAL_STATUSES.has(o.status));
    const excess = ops.length - Math.floor(this.maxOperationsPerTask * 0.9);
    for (const op of ops.slice(0, Math.max(0, excess))) {
      if (op.command?.stdout && op.command.stdout.length > 500) {
        op.command.stdout = op.command.stdout.slice(-500) + '\n… [compacted: older output dropped]';
      }
      if (op.command?.stderr && op.command.stderr.length > 500) {
        op.command.stderr = op.command.stderr.slice(-500);
      }
      if (op.resultSummary && op.resultSummary.length > 300) {
        op.resultSummary = op.resultSummary.slice(0, 300) + '… [compacted]';
      }
    }
  }

  private prune(): void {
    if (this.tasks.length <= this.maxTasks) {
      return;
    }
    // Never prune a running task.
    const removable = this.tasks.filter((t) => t.status !== 'Running');
    const toRemove = new Set(removable.slice(0, this.tasks.length - this.maxTasks).map((t) => t.taskId));
    this.tasks = this.tasks.filter((t) => !toRemove.has(t.taskId));
    this.operations = this.operations.filter((o) => !toRemove.has(o.taskId));
    this.changes = this.changes.filter((c) => !toRemove.has(c.taskId));
    toRemove.forEach((id) => this.sequence.delete(id));
  }

  private cleanCommand(cmd: CommandExecution): CommandExecution {
    return {
      ...cmd,
      command: this.clean(cmd.command) ?? '',
      stdout: this.clean(cmd.stdout),
      stderr: this.clean(cmd.stderr),
    };
  }

  private clean(text: string | undefined): string | undefined {
    return sanitize(text, this.maxFieldChars);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return task;
  }

  private requireOperation(operationId: string): AgentOperation {
    const op = this.operations.find((o) => o.operationId === operationId);
    if (!op) {
      throw new Error(`Unknown operation ${operationId}`);
    }
    return op;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory storage, used by tests and as a fallback. */
export class MemoryHistoryStorage implements HistoryStorage {
  data: PersistedHistory | undefined;
  constructor(initial?: PersistedHistory) {
    this.data = initial && structuredClone(initial);
  }
  load(): PersistedHistory | undefined {
    return this.data && structuredClone(this.data);
  }
  save(history: PersistedHistory): void {
    this.data = structuredClone(history);
  }
}
