import { resolveStrings, translator, Translator, UiLanguage } from '../i18n/i18n';
import { ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { conversation } from '../recorder/conversation';
import { describeCommand, durationMs, formatDuration } from '../analysis/commandInfo';
import {
  AgentOperation,
  ChangeRecord,
  CommandExecution,
  OperationStatus,
  OperationType,
  StatusTransition,
  TaskStatus,
} from '../types/events';

/**
 * Plain, serialisable data sent to the Activity webview. Built from recorder
 * and controller state only; the webview renders it and holds no state of
 * its own beyond UI selection.
 */
export interface ActivityViewModel {
  header: {
    statusLabel: string;
    statusKind: 'idle' | 'running' | 'paused' | 'waiting' | 'done' | 'stopped' | 'failed';
    adapterName: string;
    simulated: boolean;
    taskDescription?: string;
    workspaceRoot?: string;
    /** Enforced boundary of a real agent session (Codex profile). */
    boundary?: string;
    /** Live Tracking: events are being recorded for a connected session. */
    liveTracking: boolean;
    currentOperation?: string;
    /** Multi-turn session waiting for the next instruction. */
    awaitingInput: boolean;
  };
  controls: {
    canStart: boolean;
    canNewTask: boolean;
    canPause: boolean;
    canResume: boolean;
    canStop: boolean;
    follow: boolean;
    /** Running adapter cannot pause (Codex): show Pause disabled with an explanation. */
    pauseUnsupported: boolean;
    canSteer: boolean;
    /** Local AI Reviewer enabled in settings (AI buttons hidden otherwise). */
    reviewerEnabled: boolean;
    /** Multi-turn session that can be ended gracefully. */
    canEndSession: boolean;
  };
  tasks: Array<{ taskId: string; label: string }>;
  selectedTaskId?: string;
  /** UI language and its static strings (no LLM involved). */
  language: UiLanguage;
  strings: Record<string, string>;
  operations: OperationRow[];
  /** Older operations not sent to the webview (bounded list). */
  hiddenOperationCount: number;
  conversation: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }>;
  turns: NonNullable<import('../types/events').TaskRecord['turns']>;
  /** Timeline groups, newest last. Completed turns start collapsed (the webview remembers toggles). */
  turnGroups: TurnGroup[];
  selected?: OperationDetail;
}

export interface TurnGroup {
  /** 0 = steps recorded before the first turn (or tasks without turns). */
  number: number;
  status?: 'Running' | 'Completed' | 'Stopped' | 'Failed';
  steps: number;
  failed: number;
  pending: number;
  /** Default open state: running turns and turns with pending approvals or failures in the live turn. */
  open: boolean;
}

/** Primary action shown beside a step (derived from the recorded operation). */
export type PrimaryAction = 'review' | 'diff' | 'error' | 'command' | 'file' | 'result';

/** Max operations rendered in the timeline; older ones stay in history. */
export const MAX_RENDERED_OPERATIONS = 300;

export interface OperationRow {
  id: string;
  seq: number;
  time: string;
  type: OperationType;
  status: OperationStatus;
  description: string;
  file?: string;
  fn?: string;
  simulated: boolean;
  awaitingApproval: boolean;
  isCurrent: boolean;
  hasCommand: boolean;
  /** Explicit observe-vs-intercept label (empty for ordinary mock steps). */
  control: '' | 'OBSERVED' | 'INTERCEPTED' | 'GATED';
  /** Commands: short purpose (static, from the command text), write label and recorded duration. */
  /** Conversation turn this step belongs to (0 = before the first turn). */
  turn: number;
  primary?: PrimaryAction;
  /** Failed steps: a short reason from the recorded result/output (no model). */
  errorReason?: string;
  hasChange: boolean;
  cmd?: { summary: string; writes: boolean; writeTargets: string[]; writeReasons: string[]; long: boolean; embeddedCode: boolean; short: string; duration?: string; exitCode?: number; sourceWrite: boolean; mayGenerate: boolean };
}

export interface OperationDetail extends OperationRow {
  timestamp: string;
  rationale?: string;
  resultSummary?: string;
  lineNumber?: number;
  command?: CommandExecution;
  change?: Pick<ChangeRecord, 'decision' | 'decisionReason' | 'decidedAt'>;
  history: StatusTransition[];
  /** Plain-language explanation of how much control Visual Agent had. */
  controlExplanation: string;
  changeCount: number;
  /** Human-readable changed line ranges (actual patch lines). */
  changedLines: string[];
  /** Functions containing changed lines, found by parsing (never guessed). */
  affectedFunctions: Array<{ index: number; label: string }>;
  /** Command finished with a non-zero exit or failed. */
  hasFailedCommand: boolean;
  canApprove: boolean;
  canReject: boolean;
  canReviewChange: boolean;
  canReveal: boolean;
}

/** Primary action and short error reason, from the recorded operation only. */
export function stepActions(op: AgentOperation, awaiting: boolean): Pick<OperationRow, 'primary' | 'errorReason' | 'hasChange'> {
  const hasChange = !!(op.associatedChangeId || op.associatedChangeIds?.length);
  const errorReason = failureReason(op);
  const primary: PrimaryAction | undefined = awaiting && hasChange
    ? 'review'
    : errorReason
      ? 'error'
      : hasChange
        ? 'diff'
        : op.command
          ? 'command'
          : op.filePath
            ? 'file'
            : op.resultSummary
              ? 'result'
              : undefined;
  return { primary, errorReason, hasChange };
}

/** Short reason for a failed step: exit code + the most telling output line, else the first result line. */
export function failureReason(op: AgentOperation): string | undefined {
  const exit = op.command?.exitCode ?? op.exitCode;
  const commandFailed = !!op.command && exit !== undefined && exit !== 0;
  if (op.status !== 'Failed' && !commandFailed) return undefined;
  const clip = (t: string) => (t.length > 140 ? t.slice(0, 139) + '…' : t);
  if (op.command) {
    const lines = [op.command.stderr, op.command.stdout].filter(Boolean).join('\n').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const telling = [...lines].reverse().find((l) => /error|exception|failed|failure|assert|traceback|not found|denied|cannot|refused/i.test(l)) ?? lines.at(-1);
    return clip(`${exit !== undefined ? `exit ${exit}` : 'failed'}${telling ? `: ${telling}` : ''}`);
  }
  const first = (op.resultSummary ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return clip(first ?? 'Failed');
}

function groups(rows: OperationRow[], turns: NonNullable<import('../types/events').TaskRecord['turns']>): TurnGroup[] {
  const out = new Map<number, TurnGroup>();
  const last = rows.length ? rows[rows.length - 1].turn : 0;
  for (const r of rows) {
    let g = out.get(r.turn);
    if (!g) {
      const t = turns.find((x) => x.number === r.turn);
      g = { number: r.turn, status: t?.status, steps: 0, failed: 0, pending: 0, open: false };
      out.set(r.turn, g);
    }
    g.steps++;
    if (r.status === 'Failed') g.failed++;
    if (r.awaitingApproval) g.pending++;
  }
  for (const g of out.values()) {
    // Collapse completed turns; keep running ones, ones awaiting a decision, and untracked groups open.
    g.open = g.pending > 0 || g.status === 'Running' || (g.status === undefined && (g.number === last || turns.length === 0));
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/** Static command facts plus duration from the recorded timestamps (command times, else status history). */
function commandRow(op: AgentOperation): OperationRow['cmd'] {
  const info = describeCommand(op.command!.command);
  const running = op.history.find((h) => h.status === 'Running')?.timestamp;
  const ended = [...op.history].reverse().find((h) => ['Completed', 'Failed', 'Cancelled'].includes(h.status))?.timestamp;
  const ms = durationMs(op.command!.startedAt, op.command!.finishedAt) ?? durationMs(running, ended);
  return {
    summary: info.summary,
    writes: info.writes,
    writeTargets: info.writeTargets,
    writeReasons: info.writeReasons,
    long: info.long,
    embeddedCode: info.embeddedCode,
    short: info.short,
    sourceWrite: info.sourceWrite,
    mayGenerate: info.mayGenerate,
    duration: formatDuration(ms),
    exitCode: op.command!.exitCode ?? op.exitCode,
  };
}

export function buildActivityViewModel(
  recorder: EventRecorder,
  snapshot: ControllerSnapshot,
  ui: { follow: boolean; selectedTaskId?: string; selectedOperationId?: string; reviewerEnabled?: boolean; language?: UiLanguage },
): ActivityViewModel {
  const lang = ui.language ?? 'en';
  const tr = translator(lang);
  const tasks = recorder.getTasks();
  const selectedTaskId =
    ui.selectedTaskId && tasks.some((t) => t.taskId === ui.selectedTaskId) ? ui.selectedTaskId : tasks[0]?.taskId;
  const task = tasks.find((t) => t.taskId === selectedTaskId);
  const ops = selectedTaskId ? recorder.getOperations(selectedTaskId) : [];
  const active = snapshot.taskStatus === 'Running';
  const isLive = active && snapshot.taskId === selectedTaskId;

  const turns = task?.turns ?? [];
  const turnOf = (seq: number) => {
    let n = 0;
    for (const t of turns) if (t.firstSequence <= seq) n = t.number;
    return n;
  };
  const row = (op: AgentOperation): OperationRow => ({
    id: op.operationId,
    seq: op.sequenceNumber,
    time: formatTime(op.timestamp),
    type: op.operationType,
    status: op.status,
    description: op.description,
    file: op.filePath,
    fn: op.functionName,
    simulated: op.simulated,
    awaitingApproval: isLive && snapshot.pendingApprovals.includes(op.operationId),
    isCurrent: isLive && snapshot.currentOperationId === op.operationId,
    hasCommand: !!op.command,
    control: controlLabel(op),
    cmd: op.command ? commandRow(op) : undefined,
    turn: turnOf(op.sequenceNumber),
    ...stepActions(op, isLive && snapshot.pendingApprovals.includes(op.operationId)),
  });

  const rendered = ops.slice(-MAX_RENDERED_OPERATIONS).map(row);
  const selectedOp = ops.find((o) => o.operationId === ui.selectedOperationId);
  let selected: OperationDetail | undefined;
  if (selectedOp) {
    const r = row(selectedOp);
    const change = selectedOp.associatedChangeId ? recorder.getChange(selectedOp.associatedChangeId) : undefined;
    selected = {
      ...r,
      timestamp: selectedOp.timestamp,
      rationale: selectedOp.rationale,
      resultSummary: selectedOp.resultSummary,
      lineNumber: selectedOp.lineNumber,
      command: selectedOp.command,
      change: change && { decision: change.decision, decisionReason: change.decisionReason, decidedAt: change.decidedAt },
      history: selectedOp.history,
      controlExplanation: explainControl(selectedOp, tr),
      changeCount: selectedOp.associatedChangeIds?.length ?? (selectedOp.associatedChangeId ? 1 : 0),
      changedLines: (selectedOp.changedRanges ?? []).slice(0, 50).map((r) =>
        `${r.filePath}: ${r.startLine === r.endLine ? tr('vm.line', { n: r.startLine }) : tr('vm.lines', { a: r.startLine, b: r.endLine })}${r.side === 'old' ? ' ' + tr('vm.removedOriginal') : ''}`,
      ),
      affectedFunctions: (selectedOp.affectedFunctions ?? []).map((f, index) => ({
        index,
        label: `${f.name}() · ${f.filePath}:${f.startLine}${f.side === 'old' ? ' ' + tr('vm.originalFile') : ''}`,
      })),
      hasFailedCommand:
        !!selectedOp.command && (selectedOp.status === 'Failed' || (selectedOp.command.exitCode !== undefined && selectedOp.command.exitCode !== 0)),
      canApprove: r.awaitingApproval,
      canReject: r.awaitingApproval,
      canReviewChange: !!selectedOp.associatedChangeId,
      canReveal: !!selectedOp.filePath,
    };
  }

  return {
    header: {
      ...headerStatus(task && snapshot.taskId !== selectedTaskId ? { ...snapshot, taskStatus: 'Idle', awaitingInput: false, awaitingApprovalFor: undefined, paused: false } : snapshot, task?.status, tr),
      adapterName: task?.adapterName ?? snapshot.adapterName,
      simulated: task?.simulated ?? snapshot.simulated,
      taskDescription: task?.description,
      workspaceRoot: task?.workspaceRoot ?? task?.launch?.workspaceRoot,
      boundary: isLive || (active && snapshot.taskId === selectedTaskId) ? snapshot.boundary : undefined,
      liveTracking: isLive,
      awaitingInput: isLive && snapshot.awaitingInput,
      currentOperation: isLive && snapshot.currentOperationId ? ops.find((o) => o.operationId === snapshot.currentOperationId)?.description : undefined,
    },
    controls: {
      canStart: !active,
      canNewTask: !active || snapshot.awaitingInput,
      canPause: active && !snapshot.paused && snapshot.capabilities.pause,
      canResume: active && snapshot.paused,
      canStop: isLive,
      follow: ui.follow,
      pauseUnsupported: active && !snapshot.capabilities.pause,
      canSteer: isLive && snapshot.capabilities.steer && (!snapshot.capabilities.followUp || snapshot.awaitingInput),
      reviewerEnabled: !!ui.reviewerEnabled,
      canEndSession: isLive && snapshot.awaitingInput && !!snapshot.capabilities.followUp,
    },
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      label: `${new Date(t.startedAt).toLocaleDateString()} ${formatTime(t.startedAt)} · ${t.taskId === snapshot.taskId && snapshot.awaitingInput ? tr('state.ready') : tr('status.' + t.status as import('../i18n/i18n').StringKey)} · ${t.description.slice(0, 100)}`,
    })),
    selectedTaskId,
    language: lang,
    strings: resolveStrings(lang),
    operations: rendered,
    turnGroups: groups(rendered, turns),
    hiddenOperationCount: Math.max(0, ops.length - MAX_RENDERED_OPERATIONS),
    conversation: task ? conversation(task, ops).slice(-20).map((m) => ({ ...m, text: m.text.length > 4000 ? m.text.slice(0, 4000) + '\n[…] — 查看对话历史 / Open conversation history' : m.text })) : [],
    turns: task?.turns ?? [],
    selected,
  };
}

function controlLabel(op: AgentOperation): OperationRow['control'] {
  const e = op.enforcement ?? 'controller';
  if (op.operationType === 'Summary' || op.operationType === 'Instruct') {
    return '';
  }
  if (e === 'none') {
    return 'OBSERVED';
  }
  if (e === 'agent-approval') {
    return 'INTERCEPTED';
  }
  return op.requiresApproval ? 'GATED' : '';
}

export function explainControl(op: AgentOperation, tr: Translator = translator('en')): string {
  const e = op.enforcement ?? 'controller';
  if (op.operationType === 'Instruct') {
    return tr('ctl.explain.instruct');
  }
  if (e === 'none') {
    return tr('ctl.explain.observed');
  }
  if (e === 'agent-approval') {
    return op.operationType === 'Edit' ? tr('ctl.explain.interceptedEdit') : tr('ctl.explain.intercepted');
  }
  return op.simulated ? tr('ctl.explain.simulated') : tr('ctl.explain.controller');
}

function headerStatus(
  s: ControllerSnapshot,
  historicStatus: TaskStatus | undefined,
  tr: Translator,
): Pick<ActivityViewModel['header'], 'statusLabel' | 'statusKind'> {
  if (s.taskStatus === 'Running') {
    if (s.awaitingApprovalFor) {
      return s.paused
        ? { statusLabel: tr('state.pausedWaiting'), statusKind: 'paused' }
        : { statusLabel: tr('state.waiting'), statusKind: 'waiting' };
    }
    if (s.awaitingInput) return { statusLabel: tr('state.ready'), statusKind: 'idle' };
    if (!s.paused && s.preview) return { statusLabel: tr('state.generatingEdit'), statusKind: 'running' };
    if (!s.paused && s.progress?.phase === 'thinking') return { statusLabel: tr('state.thinking'), statusKind: 'running' };
    if (!s.paused && s.progress?.phase === 'answering') return { statusLabel: tr('state.answering'), statusKind: 'running' };
    return s.paused ? { statusLabel: tr('state.paused'), statusKind: 'paused' } : { statusLabel: tr('state.running'), statusKind: 'running' };
  }
  const status = s.taskStatus === 'Idle' ? historicStatus : s.taskStatus;
  switch (status) {
    case 'Completed':
      return { statusLabel: tr('state.done'), statusKind: 'done' };
    case 'Stopped':
      return { statusLabel: tr('state.stopped'), statusKind: 'stopped' };
    case 'Failed':
      return { statusLabel: tr('state.failed'), statusKind: 'failed' };
    default:
      return { statusLabel: tr('state.idle'), statusKind: 'idle' };
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
