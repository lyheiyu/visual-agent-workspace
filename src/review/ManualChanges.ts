import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentController, ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder, RecorderChange } from '../recorder/EventRecorder';
import { AgentOperation } from '../types/events';
import { isInside } from '../navigation/pathSafety';
import { boundedDiffs, checkPreserved, PreservationResult } from './proposalGuard';
import { createUnifiedDiff, diffStats } from './unifiedDiff';
import { changeIds, samePath } from './ProposalReview';

export interface ManualChange {
  rel: string;
  abs: string;
  /** Text right after the agent's last applied edit (actual file content, read from disk). */
  agentVersion: string;
  current?: string;
  diff: string;
  added: number;
  removed: number;
  unsaved: boolean;
}

export interface ManualCheckResult {
  at: string;
  ok: boolean;
  text: string;
  files: Array<{ rel: string; result: PreservationResult }>;
}

const MAX_MESSAGE = 3900;
const MAX_TRACKED_BYTES = 1_500_000;
const MAX_STORED_BYTES = 20_000_000;
const STORE_VERSION = 1;

type StoredBaselines = { version: number; tasks: Record<string, Record<string, { rel: string; text: string; at: string }>> };

/**
 * "Check my changes" / "Continue from my changes".
 *
 * Baseline = the file's actual content right after an agent edit completed
 * (or after you applied your own edited proposal). Your manual changes are
 * the diff from that baseline to the file now. Both actions send a normal
 * message in the same conversation (no separate model). After "continue",
 * the extension itself checks the final files to see whether your edits
 * survived, and records the result as an operation.
 */
export class ManualChanges implements vscode.Disposable {
  private readonly baselines = new Map<string, Map<string, { rel: string; text: string; at: string }>>();
  private readonly pending = new Map<string, { files: ManualChange[]; sawBusy: boolean }>();
  private readonly results = new Map<string, ManualCheckResult>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private saveTimer: NodeJS.Timeout | undefined;
  /** Resolves once baselines saved by an earlier window session are loaded. */
  readonly loaded: Promise<void>;

  constructor(
    private readonly recorder: EventRecorder,
    controller: AgentController,
    private readonly send: (taskId: string, text: string) => Promise<boolean>,
    private readonly log: vscode.OutputChannel,
    onUserVersion?: vscode.Event<{ taskId: string; abs: string; rel: string; text: string }>,
    /** File that keeps baselines across window reloads (workspace storage, never the project). */
    private readonly storeFile?: vscode.Uri,
  ) {
    this.loaded = this.load();
    const rec = recorder.onDidChange((c) => void this.onRecorder(c));
    const ctl = controller.onDidChangeState((s) => void this.onState(s));
    this.disposables.push({ dispose: () => [rec, ctl].forEach((d) => d.dispose()) });
    if (onUserVersion) this.disposables.push(onUserVersion((e) => this.setBaseline(e.taskId, e.abs, e.rel, e.text)));
  }

  /** Where baselines are persisted (workspace storage), for diagnostics and tests. */
  get storeLocation(): vscode.Uri | undefined {
    return this.storeFile;
  }

  /** Files with a recorded agent version in this conversation (persisted across reloads). */
  tracked(taskId: string): number {
    // (baselines restored from storage are included once `loaded` resolves)
    return this.baselines.get(taskId)?.size ?? 0;
  }

  lastResult(taskId: string): ManualCheckResult | undefined {
    return this.results.get(taskId);
  }

  isValidating(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  /** Your edits since the agent's last applied version of each tracked file. */
  async detect(taskId: string): Promise<ManualChange[]> {
    await this.loaded;
    const out: ManualChange[] = [];
    for (const [abs, b] of this.baselines.get(taskId) ?? []) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs));
      const current = await readText(abs);
      const diff = createUnifiedDiff(b.text, current ?? '') ?? '';
      if (!diff && !open?.isDirty) continue;
      const st = diffStats(diff);
      out.push({ rel: b.rel, abs, agentVersion: b.text, current, diff, added: st.added, removed: st.removed, unsaved: !!open?.isDirty });
    }
    return out;
  }

  /** Ask the agent to review your manual edits (read-only turn). */
  async check(taskId: string): Promise<{ sent: boolean; reason?: string }> {
    const changes = await this.ready(taskId);
    if (!changes.length) return { sent: false, reason: this.noneReason(taskId) };
    const header = [
      'Check my changes (review only for this turn).',
      `I edited these files by hand after your last applied changes: ${changes.map((c) => `${c.rel} (+${c.added} −${c.removed})`).join(', ')}.`,
      'Read the LATEST version of each file from disk now; do not rely on earlier context.',
      'Review my edits for correctness and consistency with the surrounding code and your earlier changes. List concrete problems with path:line, or say they look correct.',
      'Do not modify files or run commands in this turn.',
      'My edits (diff from your applied version to the current file):',
    ].join('\n');
    return this.dispatch(taskId, header, changes, false);
  }

  /** Continue the task on top of your manual edits; afterwards verify they were kept. */
  async continueFrom(taskId: string, instruction?: string): Promise<{ sent: boolean; reason?: string }> {
    const changes = await this.ready(taskId);
    if (!changes.length) return { sent: false, reason: this.noneReason(taskId) };
    const next = instruction?.trim() ? instruction.trim().slice(0, 800) : 'the remaining work of this conversation';
    const header = [
      'Continue from my changes.',
      `I edited these files by hand after your last applied changes: ${changes.map((c) => `${c.rel} (+${c.added} −${c.removed})`).join(', ')}.`,
      'Rules for this turn:',
      '1. Before changing any file, read its latest version from disk. My edits are the new baseline.',
      '2. Keep my edits. Do not revert, overwrite or reformat them. If one of them looks wrong, say so and propose a separate change for approval instead of silently replacing it.',
      `3. Then continue with: ${next}`,
      '4. After your changes are applied, validate the final version on disk: re-read the changed files and run the relevant check or tests (commands need approval). Report the actual results; if you cannot validate, say "not validated".',
      'My edits (diff from your applied version to the current file):',
    ].join('\n');
    return this.dispatch(taskId, header, changes, true);
  }

  /**
   * Before an agent write is approved: would applying `proposed` undo the
   * user's manual edits (current file vs the agent's last applied version)?
   * Returns the hunks that would be lost, or [] when there is no conflict.
   */
  async wouldUndo(taskId: string, abs: string, proposed: string): Promise<PreservationResult['lost']> {
    await this.loaded;
    const b = this.findBaseline(taskId, abs);
    if (!b) return [];
    const current = await readText(abs);
    if (current === undefined || current === b.text) return [];
    return checkPreserved(b.text, current, proposed).lost;
  }

  /** The user's manual edits to a file since the agent's last applied version (none → false). */
  async hasManualEdits(taskId: string, abs: string): Promise<boolean> {
    await this.loaded;
    const b = this.findBaseline(taskId, abs);
    if (!b) return false;
    const current = await readText(abs);
    return current !== undefined && current !== b.text;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.save();
    }
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ internals

  private findBaseline(taskId: string, abs: string): { rel: string; text: string; at: string } | undefined {
    for (const [k, v] of this.baselines.get(taskId) ?? []) if (samePath(k, abs)) return v;
    return undefined;
  }

  private async load(): Promise<void> {
    if (!this.storeFile) return;
    try {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.storeFile))) as StoredBaselines;
      if (raw?.version !== STORE_VERSION || typeof raw.tasks !== 'object') return;
      for (const [taskId, files] of Object.entries(raw.tasks)) {
        if (!this.recorder.getTask(taskId)) continue; // history was cleared or trimmed
        const m = this.baselines.get(taskId) ?? new Map();
        for (const [abs, b] of Object.entries(files)) {
          if (typeof b?.text === 'string' && typeof b.rel === 'string' && !m.has(abs)) m.set(abs, { rel: b.rel, text: b.text, at: String(b.at ?? '') });
        }
        if (m.size) this.baselines.set(taskId, m);
      }
      this.log.appendLine(`[manual] restored baselines for ${this.baselines.size} conversation(s)`);
      this.emitter.fire();
    } catch {
      /* no saved baselines yet */
    }
  }

  private scheduleSave(): void {
    if (!this.storeFile) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 300);
  }

  /** Persist newest baselines first, within a total size cap. */
  async save(): Promise<void> {
    if (!this.storeFile) return;
    const all: Array<{ taskId: string; abs: string; b: { rel: string; text: string; at: string } }> = [];
    for (const [taskId, m] of this.baselines) for (const [abs, b] of m) all.push({ taskId, abs, b });
    all.sort((x, y) => y.b.at.localeCompare(x.b.at));
    const out: StoredBaselines = { version: STORE_VERSION, tasks: {} };
    let used = 0;
    for (const e of all) {
      used += e.b.text.length;
      if (used > MAX_STORED_BYTES) break;
      (out.tasks[e.taskId] ??= {})[e.abs] = e.b;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storeFile, '..'));
      await vscode.workspace.fs.writeFile(this.storeFile, new TextEncoder().encode(JSON.stringify(out)));
    } catch (err) {
      this.log.appendLine(`[manual] could not save baselines: ${(err as Error).message}`);
    }
  }

  private noneReason(taskId: string): string {
    return this.tracked(taskId)
      ? `No manual changes found since the agent's last applied edits (${this.tracked(taskId)} file(s) tracked). / 自代理上次修改后没有发现手动修改。`
      : 'No agent-applied edits are recorded for this conversation in this window, so there is no baseline to compare with. / 本会话在此窗口中没有记录到代理已应用的修改，无法比较。';
  }

  /** Detect changes; unsaved edits must be saved first because the agent reads files from disk. */
  private async ready(taskId: string): Promise<ManualChange[]> {
    let changes = await this.detect(taskId);
    const unsaved = changes.filter((c) => c.unsaved);
    if (unsaved.length) {
      const choice = await vscode.window.showWarningMessage(
        `${unsaved.map((c) => c.rel).join(', ')} ${unsaved.length > 1 ? 'have' : 'has'} unsaved edits. The agent reads files from disk. Save them first? / 有未保存的修改，代理只读取磁盘内容，是否先保存？`,
        { modal: true },
        'Save and continue / 保存并继续',
      );
      if (!choice) throw new Error('Cancelled: unsaved edits were not sent.');
      for (const c of unsaved) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, c.abs));
        if (doc && !(await doc.save())) throw new Error(`Could not save ${c.rel}.`);
      }
      changes = await this.detect(taskId);
    }
    return changes.filter((c) => c.diff);
  }

  private async dispatch(taskId: string, header: string, changes: ManualChange[], validate: boolean): Promise<{ sent: boolean; reason?: string }> {
    const { text, omitted } = boundedDiffs(changes.map((c) => ({ rel: c.rel, diff: c.diff })), MAX_MESSAGE - header.length - 200);
    const message = `${header}\n\`\`\`diff\n${text}\`\`\`${omitted.length ? `\nNot shown (too long; read these files): ${omitted.join(', ')}` : ''}`;
    if (validate) this.pending.set(taskId, { files: changes, sawBusy: false });
    try {
      const sent = await this.send(taskId, message.slice(0, 4000));
      if (!sent) this.pending.delete(taskId);
      this.log.appendLine(`[manual] ${validate ? 'continue' : 'check'}: ${changes.length} file(s) sent=${sent}`);
      this.emitter.fire();
      return { sent };
    } catch (err) {
      this.pending.delete(taskId);
      throw err;
    }
  }

  private async onRecorder(c: RecorderChange): Promise<void> {
    if (c.kind === 'reset') {
      this.baselines.clear();
      this.scheduleSave();
      return;
    }
    if (c.kind !== 'operation') return;
    const op = c.operation;
    if (op.status !== 'Completed' || c.previousStatus === 'Completed' || op.operationType !== 'Edit' || op.simulated || op.source === 'user') return;
    for (const rel of this.files(op)) {
      const abs = this.absolute(op, rel);
      if (!abs) continue;
      const text = await readText(abs);
      if (text !== undefined) this.setBaseline(op.taskId, abs, rel, text);
    }
  }

  private setBaseline(taskId: string, abs: string, rel: string, text: string): void {
    if (text.length > MAX_TRACKED_BYTES) return;
    let m = this.baselines.get(taskId);
    if (!m) this.baselines.set(taskId, (m = new Map()));
    for (const k of [...m.keys()]) if (samePath(k, abs)) m.delete(k);
    m.set(abs, { rel, text, at: new Date().toISOString() });
    this.scheduleSave();
    this.emitter.fire();
  }

  private async onState(s: ControllerSnapshot): Promise<void> {
    for (const [taskId, p] of this.pending) {
      const mine = s.taskId === taskId && s.taskStatus === 'Running';
      if (mine && !s.awaitingInput) p.sawBusy = true;
      const finished = p.sawBusy && (!mine || s.awaitingInput);
      if (finished) {
        this.pending.delete(taskId);
        await this.validate(taskId, p.files);
      }
    }
  }

  /** Verify against the actual final files that the user's edits were kept. */
  async validate(taskId: string, files: ManualChange[]): Promise<ManualCheckResult> {
    const rows: ManualCheckResult['files'] = [];
    const lines: string[] = [];
    for (const f of files) {
      const final = await readText(f.abs);
      if (final === undefined || f.current === undefined) {
        rows.push({ rel: f.rel, result: { preserved: 0, total: 1, lost: [{ line: 1, added: [], removed: [], why: 'added lines missing' }] } });
        lines.push(`✖ ${f.rel}: file is missing now`);
        continue;
      }
      const result = checkPreserved(f.agentVersion, f.current, final);
      rows.push({ rel: f.rel, result });
      lines.push(
        result.lost.length
          ? `✖ ${f.rel}: ${result.preserved}/${result.total} of your edits kept; not kept: ${result.lost.map((l) => `near line ${l.line} (${l.why}: ${(l.added[0] ?? l.removed[0] ?? '').trim().slice(0, 60)})`).join('; ')}`
          : `✔ ${f.rel}: all ${result.total} of your edits kept`,
      );
      this.setBaseline(taskId, f.abs, f.rel, final);
    }
    const ok = rows.every((r) => !r.result.lost.length);
    const text = `${ok ? 'Your manual edits were kept' : 'Some of your manual edits are no longer in the files'} (checked against the actual files after the turn):\n${lines.join('\n')}`;
    const result: ManualCheckResult = { at: new Date().toISOString(), ok, text, files: rows };
    this.results.set(taskId, result);
    if (this.recorder.getTask(taskId)) {
      const op = this.recorder.recordOperation(taskId, {
        source: 'visual-agent',
        simulated: false,
        operationType: 'Analyze',
        description: `Manual edits check: ${rows.filter((r) => !r.result.lost.length).length}/${rows.length} file(s) kept your edits / 手动修改保留检查`,
        requiresApproval: false,
        enforcement: 'none',
      });
      this.recorder.updateOperation(op.operationId, { status: ok ? 'Completed' : 'Failed', resultSummary: text }, { actor: 'system' });
    }
    this.emitter.fire();
    return result;
  }

  private files(op: AgentOperation): string[] {
    const fromChanges = changeIds(op).map((id) => this.recorder.getChange(id)?.filePath).filter((f): f is string => !!f);
    return [...new Set(fromChanges.length ? fromChanges : op.filePath ? [op.filePath] : [])];
  }

  private absolute(op: AgentOperation, rel: string): string | undefined {
    const task = this.recorder.getTask(op.taskId);
    const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot;
    if (path.isAbsolute(rel)) return path.normalize(rel);
    if (!root) return undefined;
    const abs = path.resolve(root, rel);
    return isInside(root, abs) ? abs : undefined;
  }
}

async function readText(abs: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs)));
  } catch {
    return undefined;
  }
}
