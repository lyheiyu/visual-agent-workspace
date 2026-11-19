import { AffectedFunction, AgentOperation, AgentSourceId, ChangedRange, OperationType, TaskStatus } from '../types/events';

/**
 * Agent Adapter contract.
 *
 * The controller drives every adapter through the same cycle:
 *
 *   Propose  — `nextOperation()` returns what the agent *wants* to do.
 *   Inspect  — the controller records it; the UI shows it (and any diff).
 *   Decide   — if approval is required, the controller waits for the user.
 *   Execute  — only after approval does the controller call `execute()`.
 *   Record   — the controller records the actual result returned.
 *   Review   — history, diffs and command output stay inspectable.
 *
 * Mapping for future real integrations (v0.2+):
 * - Claude Code: a PreToolUse hook forwards each tool call to
 *   `nextOperation()`; the hook's allow/deny reply is driven by the controller
 *   decision; PostToolUse supplies the real result returned from `execute()`.
 * - Cline / Codex: wrap their tool-approval callbacks the same way.
 * - Ollama-based agents: run the tool loop locally; `execute()` performs the
 *   tool call through a permission-checked executor.
 *
 * Because results come back from `execute()` as structured data, the recorder
 * captures actual tool calls and outputs, not model-written summaries.
 */
export interface AgentAdapter {
  readonly id: AgentSourceId;
  readonly displayName: string;
  /** True when operations and results are simulated rather than real. */
  readonly simulated: boolean;

  beginTask(ctx: AgentTaskContext): Promise<void>;

  /**
   * Return the next operation the agent proposes, or `undefined` when the
   * agent has nothing more to do. Must not perform side effects.
   */
  nextOperation(ctx: AgentTaskContext, signal: AbortSignal): Promise<OperationRequest | undefined>;

  /**
   * Perform (or, for real agents, release) an operation that the controller
   * has allowed. Must honour `signal` for cancellation.
   */
  execute(operation: Readonly<AgentOperation>, signal: AbortSignal): Promise<ExecutionResult>;

  /** Informs the adapter of the user's decision on a gated operation. */
  onDecision?(operation: Readonly<AgentOperation>, decision: OperationDecision, reason?: string): void;

  endTask?(ctx: AgentTaskContext, status: TaskStatus): void | Promise<void>;

  dispose?(): void;
}

export interface AgentTaskContext {
  taskId: string;
  description: string;
  /** Absolute path of the workspace folder the agent operates in ('' if none). */
  workspaceRoot: string;
}

export interface OperationRequest {
  operationType: OperationType;
  description: string;
  rationale?: string;
  /** Workspace-relative path preferred. */
  filePath?: string;
  functionName?: string;
  /** 1-based line hint used when the function cannot be located. */
  lineNumber?: number;
  command?: { command: string; workingDirectory: string };
  change?: ChangeRequest;
  /** Adapter may request approval; the controller policy may also require it. */
  requiresApproval?: boolean;
}

export interface ChangeRequest {
  filePath: string;
  /** If set, `replacementText` replaces this function; otherwise the whole file. */
  functionName?: string;
  replacementText: string;
}

export interface ExecutionResult {
  outcome: 'Completed' | 'Failed';
  resultSummary?: string;
  command?: {
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    stdout?: string;
    stderr?: string;
  };
}

export type OperationDecision = 'approved' | 'rejected' | 'cancelled';

// ===========================================================================
// Streaming (push) adapters: real agents that decide on their own what to do
// and report events as they happen (Codex App Server).
// ===========================================================================

export interface AdapterCapabilities {
  /** Can new work be held without cancelling the task? (Codex: no.) */
  pause: boolean;
  /** Can the running turn be interrupted? */
  interrupt: boolean;
  /** Can instructions be added to the running turn? */
  steer: boolean;
  /**
   * Multi-turn sessions: the task stays open after the agent finishes a turn,
   * and "Send instruction" continues the SAME session. Ended with End session.
   */
  followUp?: boolean;
}

export interface StreamingRunResult {
  outcome: 'completed' | 'interrupted' | 'failed';
  message?: string;
}

/** Description of an operation as announced by a streaming agent. */
export interface AnnouncedOperation {
  operationType: OperationType;
  description: string;
  rationale?: string;
  filePath?: string;
  functionName?: string;
  lineNumber?: number;
  command?: { command: string; workingDirectory: string; startedAt?: string };
  /** Unified-diff file changes (one per file). Content is kept in memory only. */
  changes?: Array<{ filePath: string; unifiedDiff: string; changeKind: 'add' | 'delete' | 'update'; functionName?: string }>;
  changedRanges?: ChangedRange[];
  affectedFunctions?: AffectedFunction[];
  externalId?: string;
}

export interface OperationCompletion {
  outcome: 'Completed' | 'Failed' | 'Rejected' | 'Cancelled';
  resultSummary?: string;
  command?: { finishedAt?: string; exitCode?: number; stdout?: string; outputCombined?: boolean };
  note?: string;
  /** Actual assistant reply; tool output and reasoning are not conversation messages. */
  assistantMessage?: boolean;
}

/**
 * Implemented by the controller. Streaming adapters report through it; they
 * never touch the recorder or the UI directly.
 */
export interface OperationSink {
  /** Record an operation the agent announced. Status: Proposed, enforcement: none. */
  announce(op: AnnouncedOperation): string;
  /** The operation is now known to be executing. `note` explains why we know. */
  markRunning(operationId: string, note?: string): void;
  /** Terminal update. Ignored (and logged) if the operation is already final. */
  complete(operationId: string, completion: OperationCompletion): void;
  /**
   * The agent is blocked waiting for a decision on this operation. Marks it as
   * intercepted (enforcement: agent-approval) and resolves with the user's
   * decision, or 'cancelled' if the task is stopped.
   */
  requestDecision(operationId: string, reason?: string): Promise<{ decision: OperationDecision; reason?: string; blocked?: boolean }>;
  /** Record an automatic (policy) decision without asking the user. */
  autoDecide(operationId: string, decision: 'rejected', reason: string): void;
  log(message: string): void;
  /** Multi-turn adapters: the agent finished its turn and waits for the user. */
  setAwaitingInput?(waiting: boolean): void;
  /** Native provider session identity (not a credential). */
  setSession?(session: { provider: 'local'; id: string }): void;
  /** Display progress metadata only; never persist model reasoning text. */
  setProgress?(phase: 'thinking' | 'answering' | 'tool', characters: number): void;
  /**
   * Live preview of a file change the model is still generating (before any
   * approval request). Display only: never applied, never persisted.
   * `undefined` clears it (the proposal is complete or abandoned).
   */
  setPreview?(preview: { tool: string; filePath?: string; text: string } | undefined): void;
}

export interface StreamingAgentAdapter {
  readonly kind: 'streaming';
  readonly id: AgentSourceId;
  readonly displayName: string;
  readonly simulated: boolean;
  readonly capabilities: AdapterCapabilities;
  /** One-line description of the enforced boundary, shown in the UI. */
  readonly boundary: string;
  /** Run the task to completion. Must resolve (not hang) after interrupt(). */
  run(ctx: AgentTaskContext, sink: OperationSink, signal: AbortSignal): Promise<StreamingRunResult>;
  interrupt(): Promise<void>;
  /** Add an instruction to the active turn. Throws if no turn is active. */
  steer?(text: string): Promise<void>;
  /** Multi-turn adapters: finish the session gracefully (task completes). */
  endSession?(): Promise<void>;
  dispose?(): void;
}

export type AnyAgentAdapter = AgentAdapter | StreamingAgentAdapter;

export function isStreamingAdapter(a: AnyAgentAdapter): a is StreamingAgentAdapter {
  return (a as StreamingAgentAdapter).kind === 'streaming';
}
