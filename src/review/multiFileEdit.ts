import { createHash } from 'node:crypto';
import { createUnifiedDiff, diffStats } from './unifiedDiff';
import { snapshotConflict } from './proposalGuard';

/**
 * Edit before applying, for proposals that change several files.
 *
 * Pure: no VS Code, no model, no filesystem except through the `FileStore`
 * passed to `applyAll`. Holds the user's working text per file, so switching
 * between files never loses edits, builds the consolidated diff locally, and
 * applies all files as one unit (validate everything first, then write, and
 * roll back every file already written if any write fails).
 */

export type FileKind = 'add' | 'delete' | 'update';

export interface EditFileInput {
  changeId: string;
  /** Workspace-relative path (display, diff headers). */
  rel: string;
  /** Absolute path (validated inside the workspace by the caller). */
  abs: string;
  kind: FileKind;
  /** Snapshot the proposal's diff was computed against ('' for an added file). */
  original: string;
  /** The agent's proposed full text ('' for a deletion). */
  proposed: string;
}

export interface EditFileState {
  index: number;
  rel: string;
  kind: FileKind;
  /** Deletions have no text to edit; they can be excluded (file kept) instead. */
  editable: boolean;
  /** A proposed deletion the user excluded: the file is kept unchanged. */
  excluded: boolean;
  /** The working text differs from the agent's proposal. */
  edited: boolean;
  active: boolean;
  added: number;
  removed: number;
}

export class EditSession {
  private readonly texts: string[];
  private readonly kept = new Set<number>();
  private activeIndex: number;

  constructor(readonly files: readonly EditFileInput[]) {
    if (!files.length) throw new Error('The proposal has no file changes to edit.');
    this.texts = files.map((f) => f.proposed);
    const first = files.findIndex((f) => f.kind !== 'delete');
    this.activeIndex = first < 0 ? 0 : first;
  }

  get active(): number {
    return this.activeIndex;
  }

  get multi(): boolean {
    return this.files.length > 1;
  }

  select(index: number): EditFileInput {
    this.assertIndex(index);
    this.activeIndex = index;
    return this.files[index];
  }

  text(index: number): string {
    this.assertIndex(index);
    return this.texts[index];
  }

  /** Record the user's working text (ignored for deletions). Returns true if it changed. */
  setText(index: number, text: string): boolean {
    this.assertIndex(index);
    if (this.files[index].kind === 'delete' || this.texts[index] === text) return false;
    this.texts[index] = text;
    return true;
  }

  /** Back to the agent's proposal for this file (text, or the deletion). Returns the text. */
  reset(index: number): string {
    this.assertIndex(index);
    this.texts[index] = this.files[index].proposed;
    this.kept.delete(index);
    return this.texts[index];
  }

  /** Exclude (true) or re-include a proposed deletion without rejecting the rest of the proposal. */
  setExcluded(index: number, excluded: boolean): void {
    this.assertIndex(index);
    if (this.files[index].kind !== 'delete') throw new Error(`Only proposed deletions can be excluded; edit ${this.files[index].rel} instead.`);
    if (excluded) this.kept.add(index);
    else this.kept.delete(index);
  }

  isExcluded(index: number): boolean {
    return this.kept.has(index);
  }

  isEdited(index: number): boolean {
    this.assertIndex(index);
    return this.kept.has(index) || this.texts[index] !== this.files[index].proposed;
  }

  /** Something would still be written (not every file excluded). */
  hasWrites(): boolean {
    return this.files.some((_, i) => !this.kept.has(i));
  }

  state(): EditFileState[] {
    return this.files.map((f, index) => {
      const stats = diffStats(this.fileDiff(index) ?? '');
      return { index, rel: f.rel, kind: f.kind, editable: f.kind !== 'delete', excluded: this.kept.has(index), edited: this.isEdited(index), active: index === this.activeIndex, added: stats.added, removed: stats.removed };
    });
  }

  /** Changes with every user edit applied; identical working texts give an identical fingerprint. */
  fingerprint(): string {
    const h = createHash('sha256');
    this.files.forEach((f, i) => h.update(`${f.rel}\0${f.kind}\0${this.kept.has(i) ? 'kept' : 'apply'}\0${this.texts[i].length}\0${this.texts[i]}\0`));
    return h.digest('hex');
  }

  /** Unified diff of one file: snapshot → what would be written. */
  fileDiff(index: number): string | undefined {
    const f = this.files[index];
    if (this.kept.has(index)) return undefined;
    return createUnifiedDiff(f.original, f.kind === 'delete' ? '' : this.texts[index]);
  }

  /** The complete change that "apply" would write, as one reviewable diff. Local only. */
  consolidatedDiff(): string {
    const parts = this.files.map((f, i) => {
      if (this.kept.has(i)) return `diff --git a/${f.rel} b/${f.rel}\n(deletion excluded by you: the file is kept unchanged)\n`;
      const edited = this.isEdited(i) ? ' (edited by you)' : '';
      const header =
        f.kind === 'add'
          ? `diff --git a/${f.rel} b/${f.rel}${edited}\nnew file\n--- /dev/null\n+++ b/${f.rel}\n`
          : f.kind === 'delete'
            ? `diff --git a/${f.rel} b/${f.rel}\ndeleted file\n--- a/${f.rel}\n+++ /dev/null\n`
            : `diff --git a/${f.rel} b/${f.rel}${edited}\n--- a/${f.rel}\n+++ b/${f.rel}\n`;
      const body = this.fileDiff(i);
      return header + (body ? body.replace(/^(---|\+\+\+) .*\n/gm, '') : '(no change: identical to the current file)\n');
    });
    const totals = this.state().reduce((a, s) => ({ added: a.added + s.added, removed: a.removed + s.removed }), { added: 0, removed: 0 });
    const edited = this.files.filter((_, i) => this.isEdited(i) && !this.kept.has(i)).length;
    const kept = this.kept.size ? `; ${this.kept.size} deletion(s) excluded` : '';
    return `# Combined change: ${this.files.length - this.kept.size} of ${this.files.length} file(s), +${totals.added} −${totals.removed}; ${edited} edited by you${kept}. Nothing has been written yet.\n\n${parts.join('\n')}`;
  }

  /** What `applyAll` would do. */
  plan(): ApplyStep[] {
    return this.files.flatMap((f, i) => (this.kept.has(i) ? [] : [{ rel: f.rel, abs: f.abs, kind: f.kind, expected: f.original, text: f.kind === 'delete' ? undefined : this.texts[i] }]));
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.files.length) throw new Error(`No file #${index} in this proposal.`);
  }
}

// ------------------------------------------------------------------ apply

export interface FileStore {
  /** Current text, or undefined if the file does not exist. */
  read(abs: string): Promise<string | undefined>;
  /** Unsaved editor edits for this path. */
  isDirty?(abs: string): boolean;
  write(abs: string, text: string): Promise<void>;
  remove(abs: string): Promise<void>;
}

export interface ApplyStep {
  rel: string;
  abs: string;
  kind: FileKind;
  /** Text the proposal was computed against: the file must still contain exactly this. */
  expected: string;
  /** Text to write; undefined = delete. */
  text?: string;
}

export type ApplyResult =
  | { ok: true; written: string[] }
  | { ok: false; stage: 'validate'; conflicts: Array<{ rel: string; reason: string }> }
  | { ok: false; stage: 'write'; failed: string; error: string; rolledBack: string[]; rollbackFailed: string[] };

/**
 * All or nothing, as far as a filesystem without transactions allows:
 * 1. validate every file against its snapshot (no write if any differs);
 * 2. write / delete each file and read it back;
 * 3. on the first failure, restore every file touched so far (including the
 *    failing one) to the exact prior text, or remove files that did not exist.
 */
export async function applyAll(steps: ApplyStep[], store: FileStore): Promise<ApplyResult> {
  const before: Array<string | undefined> = [];
  const conflicts: Array<{ rel: string; reason: string }> = [];
  for (const s of steps) {
    const now = await store.read(s.abs);
    before.push(now);
    const reason = snapshotConflict(s.expected, s.kind, { diskText: now, dirty: store.isDirty?.(s.abs) ?? false });
    if (reason) conflicts.push({ rel: s.rel, reason });
  }
  if (new Set(steps.map((s) => s.abs.toLowerCase())).size !== steps.length) conflicts.push({ rel: '(proposal)', reason: 'duplicate' });
  if (conflicts.length) return { ok: false, stage: 'validate', conflicts };

  const touched: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    touched.push(i);
    try {
      if (s.text === undefined) {
        if (before[i] !== undefined) await store.remove(s.abs);
        if ((await store.read(s.abs)) !== undefined) throw new Error('the file still exists after deleting it');
      } else {
        await store.write(s.abs, s.text);
        if ((await store.read(s.abs)) !== s.text) throw new Error('the file does not contain the new text after writing');
      }
    } catch (err) {
      const rolledBack: string[] = [];
      const rollbackFailed: string[] = [];
      for (const j of touched.reverse()) {
        const t = steps[j];
        try {
          const prior = before[j];
          if (prior === undefined) {
            if ((await store.read(t.abs)) !== undefined) await store.remove(t.abs);
          } else if ((await store.read(t.abs)) !== prior) {
            await store.write(t.abs, prior);
          }
          if ((await store.read(t.abs)) !== prior) throw new Error('mismatch');
          rolledBack.push(t.rel);
        } catch {
          rollbackFailed.push(t.rel);
        }
      }
      return { ok: false, stage: 'write', failed: s.rel, error: err instanceof Error ? err.message : String(err), rolledBack, rollbackFailed };
    }
  }
  return { ok: true, written: steps.map((s) => s.rel) };
}

export function describeApplyFailure(r: Exclude<ApplyResult, { ok: true }>): string {
  if (r.stage === 'validate') return `nothing was written: ${r.conflicts.map((c) => `${c.rel} (${c.reason})`).join(', ')}`;
  const restored = r.rollbackFailed.length
    ? `Could NOT restore ${r.rollbackFailed.join(', ')}; check ${r.rollbackFailed.length > 1 ? 'these files' : 'this file'}.${r.rolledBack.length ? ` Restored: ${r.rolledBack.join(', ')}.` : ''}`
    : `Every file already written was restored to its previous content (${r.rolledBack.join(', ')}).`;
  return `writing ${r.failed} failed (${r.error}). ${restored}`;
}
