/**
 * Strongly typed event model shared by every module.
 *
 * Nothing in this file depends on `vscode`; it is the contract between agent
 * adapters, the controller, the recorder and the UI.
 */

export const OPERATION_TYPES = ['Read', 'Analyze', 'Edit', 'Execute', 'Test', 'Summary', 'Instruct'] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const OPERATION_STATUSES = [
  'Proposed',
  'Running',
  'Completed',
  'Failed',
  'Rejected',
  'Cancelled',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'Completed',
  'Failed',
  'Rejected',
  'Cancelled',
]);

/** Where an event came from. `mock` events are always simulated. */
export type AgentSourceId = 'mock' | 'codex' | 'cline' | 'claude-code' | 'ollama' | (string & {});

export type TaskStatus = 'Running' | 'Stopped' | 'Completed' | 'Failed';

/**
 * How much control Visual Agent had over an operation. This is the explicit
 * observe-vs-intercept distinction shown in the UI:
 * - 'controller':     dispatched by our own controller (mock adapter); it could
 *                     not run without passing through the controller.
 * - 'agent-approval': the agent paused and asked; the user decision was enforced
 *                     by the agent BEFORE the operation ran (interception).
 * - 'none':           reported by the agent; Visual Agent could only observe it.
 *                     Constraints came solely from the agent sandbox/policy.
 */
export type Enforcement = 'controller' | 'agent-approval' | 'none';

export type ChangeDecision = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';

export type Actor = 'agent' | 'user' | 'controller' | 'system';

export type CommandStatus = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled' | 'NotRun';

/** A command associated with an operation, and (once known) its result. */
export interface CommandExecution {
  command: string;
  workingDirectory: string;
  /** True when no real process was started (mock adapter). */
  simulated: boolean;
  status: CommandStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** True when stdout holds stdout+stderr interleaved (as reported by Codex). */
  outputCombined?: boolean;
}

/** One entry in an operation's audit trail. */
export interface StatusTransition {
  status: OperationStatus;
  timestamp: string;
  actor: Actor;
  note?: string;
}

/** A single agent operation (tool call). */
export interface AgentOperation {
  taskId: string;
  operationId: string;
  sequenceNumber: number;
  /** Creation time (ISO 8601). */
  timestamp: string;
  source: AgentSourceId;
  simulated: boolean;
  operationType: OperationType;
  status: OperationStatus;
  description: string;
  rationale?: string;
  filePath?: string;
  functionName?: string;
  /** 1-based line number hint. */
  lineNumber?: number;
  command?: CommandExecution;
  workingDirectory?: string;
  exitCode?: number;
  resultSummary?: string;
  associatedChangeId?: string;
  /** All change IDs when one operation touches several files. */
  associatedChangeIds?: string[];
  requiresApproval: boolean;
  /** Missing in v0.1 history: treat as 'controller'. */
  enforcement?: Enforcement;
  /** ID of the operation in the agent's own protocol (e.g. Codex item id). */
  externalId?: string;
  /** Edit operations: changed line ranges (metadata only, no code). */
  changedRanges?: ChangedRange[];
  /** Edit operations: functions containing changed lines (parsed, not guessed). */
  affectedFunctions?: AffectedFunction[];
  history: StatusTransition[];
}

export interface TaskRecord {
  taskId: string;
  description: string;
  source: AgentSourceId;
  adapterName: string;
  simulated: boolean;
  status: TaskStatus;
  startedAt: string;
  workspaceRoot?: string;
  updatedAt?: string;
  finishedAt?: string;
  summary?: string;
  messages?: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }>;
  launch?: { provider: 'codex' | 'local' | 'claude-code'; model: string; effort?: string; profile: string; workspaceRoot: string; claudeAuthKind?: 'subscription' | 'api-key' | 'cloud' };
  session?: { provider: 'local'; id: string };
  turns?: ConversationTurn[];
}

export interface ConversationTurn {
  number: number;
  startedAt: string;
  finishedAt?: string;
  firstSequence: number;
  status: 'Running' | 'Completed' | 'Stopped' | 'Failed';
  report?: string;
  failedOperations?: number;
}

/**
 * Metadata about a proposed change. Deliberately excludes source text so that
 * persisted history never contains code contents.
 */
export interface ChangeRecord {
  changeId: string;
  taskId: string;
  operationId: string;
  filePath: string;
  functionName?: string;
  rationale?: string;
  decision: ChangeDecision;
  decidedAt?: string;
  decisionReason?: string;
}

/** A changed line range (1-based, inclusive). */
export interface ChangedRange {
  filePath: string;
  /** 'new': lines in the patched file. 'old': removed-only lines in the original. */
  side: 'new' | 'old';
  startLine: number;
  endLine: number;
}

/**
 * A function containing changed lines. Only recorded when a parser or the
 * language server delimited it; names are never guessed.
 */
export interface AffectedFunction {
  filePath: string;
  name: string;
  kind?: 'function' | 'class' | 'method';
  /** 1-based range in the file on the given side. */
  startLine: number;
  endLine: number;
  side: 'new' | 'old';
  source: 'parser' | 'symbols';
}

/** Full change content. Held in memory only (never persisted). */
export interface ProposedChangeContent {
  changeId: string;
  taskId: string;
  operationId: string;
  filePath: string;
  functionName?: string;
  /** Replacement text for the target function (or whole file if no function). */
  replacementText?: string;
  /** Alternatively: unified-diff hunks to apply to the current file (Codex). */
  unifiedDiff?: string;
  changeKind?: 'add' | 'delete' | 'update';
  rationale?: string;
}
