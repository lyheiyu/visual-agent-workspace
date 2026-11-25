import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventRecorder, RecorderChange } from '../recorder/EventRecorder';
import { AgentOperation, NativeSession, TaskRecord } from '../types/events';
import { conversation } from '../recorder/conversation';
import { isInside } from '../navigation/pathSafety';
import { describeCommand } from '../analysis/commandInfo';

/**
 * Lightweight per-conversation context record (no model calls, no file contents).
 *
 * - Which files the agent read or wrote in this conversation, with a SHA-256
 *   fingerprint of the version it saw. Before a follow-up, files that changed
 *   since (editor, other tools, external processes) are named in a short note
 *   so the agent re-reads exactly those; unchanged files need no re-read.
 *   This is a hint: it cannot prove the model still holds a file's content
 *   (context compaction, a lost session), so re-reading is never forbidden.
 * - Counters to measure continuity: native threads started / resumed /
 *   reconstructed, follow-ups in the same live session, reads, re-reads of
 *   unchanged files, project exploration steps, provider-reported tokens and
 *   per-turn latency.
 */

export interface FileFact {
  /** Fingerprint of the version the agent last saw (null = the file did not exist). */
  hash: string | null;
  at: string;
  by: 'read' | 'agent-edit' | 'user-apply';
  /** Version already reported to the agent as changed (so the same change is reported once). */
  noted?: string | null;
}

export interface SessionMetrics {
  threadsStarted: number;
  threadsResumed: number;
  /** Follow-ups sent into the same live native session (no new thread, no replay). */
  nativeTurns: number;
  reconstructed: number;
  reads: number;
  /** Reads of a file whose version the agent had already seen. */
  repeatedReads: number;
  /** Directory listings, workspace searches, AGENTS.md / README reads. */
  explorations: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  usageReports: number;
  turnMs: number[];
}

interface TaskContext {
  files: Record<string, FileFact>;
  metrics: SessionMetrics;
  session?: NativeSession;
  timedTurns: number;
}

const MAX_TASKS = 50;
const MAX_FILES = 300;
const EXPLORATION = /^(List files|Search|Inspect files)|\b(Get-ChildItem|ls|dir|tree|find|rg --files|git ls-files)\b/i;
const DOCS = /(^|\/)(AGENTS|README|CLAUDE)\.md$/i;

const emptyMetrics = (): SessionMetrics => ({ threadsStarted: 0, threadsResumed: 0, nativeTurns: 0, reconstructed: 0, reads: 0, repeatedReads: 0, explorations: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, usageReports: 0, turnMs: [] });

export function fingerprint(text: string | undefined): string | null {
  return text === undefined ? null : createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Candidate file paths named in a command line: quoted strings and bare words that look like
 * paths (contain a dot or a slash). Callers keep only existing files inside the project.
 * Heuristic and bounded; it never runs or parses the command beyond splitting.
 */
export function commandPaths(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/"([^"\r\n]{1,300})"|'([^'\r\n]{1,300})'/g)) {
    const q = (m[1] ?? m[2]).trim();
    if (!/\s-/.test(q) && /[./\\]/.test(q)) out.add(q);
  }
  for (const t of command.match(/[^\s"'`;|&()<>,]+/g) ?? []) {
    const w = t.replace(/^-\w+[:=]/, '').replace(/^\$?\(?|[)\]:]+$/g, '');
    if (w && !w.startsWith('-') && /[./\\]/.test(w) && !/^\w+:\/\//.test(w) && w.length <= 300) out.add(w);
  }
  return [...out].slice(0, 40);
}

function readText(abs: string): string | undefined {
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= 4_000_000 ? fs.readFileSync(abs, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

export class SessionContextTracker {
  private readonly tasks = new Map<string, TaskContext>();
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly recorder: EventRecorder,
    private readonly opts: { storeFile?: string; log?: (line: string) => void; read?: (abs: string) => string | undefined } = {},
  ) {
    this.load();
    this.sub = recorder.onDidChange((c) => this.onRecorder(c));
  }

  dispose(): void {
    this.sub.dispose();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }

  metrics(taskId: string): SessionMetrics {
    return structuredClone(this.ctx(taskId).metrics);
  }

  files(taskId: string): Record<string, FileFact> {
    return structuredClone(this.ctx(taskId).files);
  }

  /** A native session was started, resumed or replaced (from the adapter, through the controller). */
  noteSession(taskId: string, session: NativeSession): void {
    const c = this.ctx(taskId);
    const m = c.metrics;
    if (session.continuity === 'resumed') m.threadsResumed++;
    else if (session.continuity === 'reconstructed') {
      m.threadsStarted++;
      m.reconstructed++;
    } else if (session.continuity === 'new' || !session.continuity) m.threadsStarted++;
    c.session = session;
    this.log(taskId, `${session.provider} session ${session.id}: ${session.continuity ?? 'new'}${session.recoveryReason ? ` (native continuation failed: ${session.recoveryReason})` : ''}`);
    this.scheduleSave();
  }

  noteNativeTurn(taskId: string): void {
    this.ctx(taskId).metrics.nativeTurns++;
    this.scheduleSave();
  }

  noteUsage(taskId: string, u: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }): void {
    const m = this.ctx(taskId).metrics;
    m.inputTokens += u.inputTokens ?? 0;
    m.cachedInputTokens += u.cachedInputTokens ?? 0;
    m.outputTokens += u.outputTokens ?? 0;
    m.usageReports++;
    this.scheduleSave();
  }

  /**
   * Files the agent saw that changed since (by anyone but the agent's own
   * later write), for a short note before the next message. Each version is
   * reported once. Empty string when nothing changed.
   */
  changeNote(taskId: string): string {
    const task = this.recorder.getTask(taskId);
    const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot;
    if (!root) return '';
    const c = this.ctx(taskId);
    const changed: string[] = [];
    for (const [rel, f] of Object.entries(c.files)) {
      const now = fingerprint(this.read(path.join(root, rel)));
      if (now === f.hash || now === f.noted) continue;
      f.noted = now;
      changed.push(`${rel} (${now === null ? 'deleted' : f.hash === null ? 'created' : 'modified'})`);
    }
    if (!changed.length) return '';
    this.scheduleSave();
    this.log(taskId, `change note: ${changed.join(', ')}`);
    return `[Context update from the editor: since you last read or wrote them, these files changed outside your own edits: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? `, +${changed.length - 20} more` : ''}. Re-read them before relying on earlier content. The other files you inspected in this conversation are unchanged.]\n\n`;
  }

  /**
   * Compact context for a NEW provider session when the native one cannot be
   * continued. Bounded (≈8 KB), clearly labelled as reconstructed; it is not
   * equivalent to the lost session.
   */
  reconstructedContext(task: TaskRecord, operations: AgentOperation[], reason?: string): string {
    const c = this.ctx(task.taskId);
    const root = task.workspaceRoot ?? task.launch?.workspaceRoot;
    const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const recent = conversation(task, operations).slice(-6).map((m) => `${m.role.toUpperCase()}: ${clip(m.text.trim(), 1200)}`).join('\n\n');
    const changedByAgent = [...new Set(operations.filter((o) => o.operationType === 'Edit' && o.status === 'Completed' && o.source !== 'user' && o.filePath).map((o) => o.filePath!))].slice(-15);
    const inspected = Object.entries(c.files).slice(-25).map(([rel, f]) => {
      const now = root ? fingerprint(this.read(path.join(root, rel))) : f.hash;
      return now === f.hash ? rel : `${rel} (changed since)`;
    });
    const uncertain = operations.filter((o) => (o.status === 'Running' || o.status === 'Proposed') && (o.command || o.operationType === 'Edit')).slice(-5).map((o) => `- ${clip(o.description, 160)}`);
    return [
      `[Reconstructed context: the previous native session could not be continued${reason ? ` (${clip(reason, 200)})` : ''}. This is a short summary, not that session's context.]`,
      `Task: ${clip(task.description, 600)}`,
      recent && `Recent messages:\n${recent}`,
      changedByAgent.length ? `Files you changed earlier: ${changedByAgent.join(', ')}` : '',
      inspected.length ? `Files you inspected earlier (re-read the ones you need; do not re-list the project unless necessary): ${inspected.join(', ')}` : '',
      uncertain.length ? `Operations without a confirmed outcome (do not repeat them automatically; check the files or ask first):\n${uncertain.join('\n')}` : '',
      'Next instruction:\n',
    ].filter(Boolean).join('\n\n');
  }

  /** One diagnostic line (internal log only). */
  describe(taskId: string): string {
    const m = this.ctx(taskId).metrics;
    const avg = m.turnMs.length ? Math.round(m.turnMs.reduce((a, b) => a + b, 0) / m.turnMs.length / 100) / 10 : undefined;
    return `threads started ${m.threadsStarted}, resumed ${m.threadsResumed}, native follow-ups ${m.nativeTurns}, reconstructed ${m.reconstructed}; reads ${m.reads} (repeated unchanged ${m.repeatedReads}), exploration ${m.explorations}${m.usageReports ? `; tokens in ${m.inputTokens} (cached ${m.cachedInputTokens}) out ${m.outputTokens}` : ''}${avg !== undefined ? `; avg turn ${avg} s` : ''}`;
  }

  // ------------------------------------------------------------ internals

  private ctx(taskId: string): TaskContext {
    let c = this.tasks.get(taskId);
    if (!c) {
      c = { files: {}, metrics: emptyMetrics(), timedTurns: 0 };
      this.tasks.set(taskId, c);
      if (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    }
    return c;
  }

  private read(abs: string): string | undefined {
    return (this.opts.read ?? readText)(abs);
  }

  private onRecorder(change: RecorderChange): void {
    if (change.kind === 'reset') {
      this.tasks.clear();
      this.scheduleSave();
      return;
    }
    if (change.kind === 'task') {
      this.onTask(change.task);
      return;
    }
    if (change.kind !== 'operation') return;
    const op = change.operation;
    if (op.status !== 'Completed' || change.previousStatus === 'Completed' || op.simulated) return;
    const task = this.recorder.getTask(op.taskId);
    const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot;
    const c = this.ctx(op.taskId);
    const rel = (p: string) => {
      const abs = path.isAbsolute(p) ? path.normalize(p) : root ? path.resolve(root, p) : undefined;
      return abs && root && isInside(root, abs) ? { rel: path.relative(root, abs).replace(/\\/g, '/'), abs } : undefined;
    };
    const exploring = (op.operationType === 'Read' && !op.filePath) || (!!op.command && EXPLORATION.test(op.command.command)) || EXPLORATION.test(op.description);
    if (op.operationType === 'Read' && op.filePath) {
      const f = rel(op.filePath);
      if (f) {
        const hash = fingerprint(this.read(f.abs));
        const before = c.files[f.rel];
        c.metrics.reads++;
        if (before && before.hash === hash) c.metrics.repeatedReads++;
        if (DOCS.test(f.rel)) c.metrics.explorations++;
        c.files[f.rel] = { hash, at: op.timestamp, by: 'read' };
      }
    } else if (exploring) {
      c.metrics.explorations++;
    }
    // Files seen through a shell command (cat / Get-Content / sed -n / grep file …): fingerprint the
    // existing workspace files named in it, so a later outside change is reported like any read file.
    // A command that may write only refreshes files already tracked (its own changes are not "outside" ones).
    if (op.command && op.operationType !== 'Edit' && root) {
      const writes = describeCommand(op.command.command).writes;
      for (const p of commandPaths(op.command.command)) {
        const f = rel(p);
        if (!f || (writes && !c.files[f.rel]) || (op.filePath && rel(op.filePath)?.rel === f.rel)) continue;
        const text = this.read(f.abs);
        if (text === undefined) continue; // not an existing file (flag value, directory, word)
        const hash = fingerprint(text);
        if (writes) {
          c.files[f.rel] = { hash, at: op.timestamp, by: 'agent-edit' };
          continue;
        }
        c.metrics.reads++;
        if (c.files[f.rel]?.hash === hash) c.metrics.repeatedReads++;
        c.files[f.rel] = { hash, at: op.timestamp, by: 'read' };
      }
    }
    if (op.operationType === 'Edit') {
      const paths = [...new Set([...(op.associatedChangeIds ?? (op.associatedChangeId ? [op.associatedChangeId] : [])).map((id) => this.recorder.getChange(id)?.filePath).filter((x): x is string => !!x), ...(op.filePath && !op.associatedChangeIds?.length ? [op.filePath] : [])])];
      for (const p of paths) {
        const f = rel(p);
        if (f) c.files[f.rel] = { hash: fingerprint(this.read(f.abs)), at: op.timestamp, by: op.source === 'user' ? 'user-apply' : 'agent-edit' };
      }
    }
    const keys = Object.keys(c.files);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) delete c.files[k];
    this.scheduleSave();
  }

  /** Per-turn latency from the recorded turn timestamps. */
  private onTask(task: TaskRecord): void {
    const c = this.tasks.get(task.taskId);
    const turns = task.turns ?? [];
    if (!c && !turns.length) return;
    const ctx = this.ctx(task.taskId);
    const done = turns.filter((t) => t.finishedAt);
    while (ctx.timedTurns < done.length) {
      const t = done[ctx.timedTurns++];
      const ms = Date.parse(t.finishedAt!) - Date.parse(t.startedAt);
      if (Number.isFinite(ms) && ms >= 0) {
        ctx.metrics.turnMs = [...ctx.metrics.turnMs, ms].slice(-50);
        this.log(task.taskId, `turn ${t.number} ${t.status} in ${(ms / 1000).toFixed(1)} s · ${this.describe(task.taskId)}`);
      }
    }
  }

  private log(taskId: string, line: string): void {
    this.opts.log?.(`[session] ${taskId}: ${line}`);
  }

  private load(): void {
    if (!this.opts.storeFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.opts.storeFile, 'utf8')) as { version: number; tasks: Record<string, TaskContext> };
      if (raw.version !== 1) return;
      for (const [id, c] of Object.entries(raw.tasks ?? {})) {
        if (!this.recorder.getTask(id)) continue;
        this.tasks.set(id, { files: c.files ?? {}, metrics: { ...emptyMetrics(), ...c.metrics }, session: c.session, timedTurns: c.timedTurns ?? 0 });
      }
    } catch {
      /* nothing saved yet */
    }
  }

  private scheduleSave(): void {
    if (!this.opts.storeFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 500);
    this.saveTimer.unref?.();
  }

  private save(): void {
    if (!this.opts.storeFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.storeFile), { recursive: true });
      fs.writeFileSync(this.opts.storeFile, JSON.stringify({ version: 1, tasks: Object.fromEntries(this.tasks) }));
    } catch (err) {
      this.opts.log?.(`[session] could not save the context record: ${(err as Error).message}`);
    }
  }
}
