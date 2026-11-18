import { createUnifiedDiff, parseHunks } from './unifiedDiff';

/**
 * Pure checks for "review before writing" and "continue from my changes".
 * No filesystem, no VS Code, no model.
 */

export type ConflictReason = 'changed' | 'unsaved' | 'created' | 'deleted' | 'unavailable' | 'undoes-manual' | 'command-writes-edited';

export interface CurrentFile {
  /** Text currently on disk (undefined = file does not exist). */
  diskText?: string;
  /** An open editor has unsaved changes for this file. */
  dirty: boolean;
}

/**
 * Compare the snapshot the proposal's diff was computed against with the
 * file as it is now. Any difference — including unsaved editor edits —
 * is a conflict: applying would overwrite or ignore changes made since.
 */
export function snapshotConflict(original: string | undefined, kind: 'add' | 'delete' | 'update' | undefined, now: CurrentFile): ConflictReason | undefined {
  if (original === undefined) return 'unavailable';
  if (now.dirty) return 'unsaved';
  if (kind === 'add') {
    return now.diskText !== undefined && now.diskText !== original ? 'created' : undefined;
  }
  if (now.diskText === undefined) return 'deleted';
  return now.diskText === original ? undefined : 'changed';
}

export interface UserHunk {
  /** Lines the user added (as written). */
  added: string[];
  /** Lines the user removed from the agent's version. */
  removed: string[];
  /** 1-based line in the user's version where the hunk starts. */
  line: number;
}

/** The user's manual edits as hunks (agent's applied version → user's version). */
export function userHunks(agentVersion: string, userVersion: string): UserHunk[] {
  const diff = createUnifiedDiff(agentVersion, userVersion, 0);
  if (!diff) return [];
  return parseHunks(diff).map((h) => ({
    added: h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)),
    removed: h.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1)),
    line: h.newStart,
  }));
}

export interface PreservationResult {
  preserved: number;
  total: number;
  /** Hunks that are no longer present in the final file. */
  lost: Array<{ line: number; added: string[]; removed: string[]; why: 'added lines missing' | 'removed lines restored' }>;
}

const norm = (l: string) => l.trim();

function containsBlock(haystack: string[], block: string[]): boolean {
  const b = block.map(norm).filter(Boolean);
  if (!b.length) return true;
  const h = haystack.map(norm);
  outer: for (let i = 0; i + b.length <= h.length; i++) {
    for (let k = 0; k < b.length; k++) if (h[i + k] !== b[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Were the user's manual edits kept in the final version? A hunk counts as
 * preserved when its added lines still appear as a contiguous block
 * (whitespace-trimmed), and, for deletions, when the removed block has not
 * come back. Conservative and based only on the actual file texts.
 */
export function checkPreserved(agentVersion: string, userVersion: string, finalVersion: string): PreservationResult {
  const hunks = userHunks(agentVersion, userVersion);
  const finalLines = finalVersion.split(/\r?\n/);
  const agentLines = agentVersion.split(/\r?\n/);
  const lost: PreservationResult['lost'] = [];
  for (const h of hunks) {
    const addedKept = containsBlock(finalLines, h.added);
    // A deletion is undone if the removed block is back AND it was unique in the agent's version.
    const removedBlock = h.removed.map(norm).filter(Boolean);
    const restored = !h.added.some((l) => norm(l)) && removedBlock.length > 0 && containsBlock(finalLines, h.removed) && countBlock(agentLines, h.removed) === 1;
    if (!addedKept) lost.push({ line: h.line, added: h.added, removed: h.removed, why: 'added lines missing' });
    else if (restored) lost.push({ line: h.line, added: h.added, removed: h.removed, why: 'removed lines restored' });
  }
  return { preserved: hunks.length - lost.length, total: hunks.length, lost };
}

function countBlock(lines: string[], block: string[]): number {
  const b = block.map(norm).filter(Boolean);
  const h = lines.map(norm);
  let n = 0;
  outer: for (let i = 0; i + b.length <= h.length; i++) {
    for (let k = 0; k < b.length; k++) if (h[i + k] !== b[k]) continue outer;
    n++;
  }
  return n;
}

/** Fit per-file diffs into a message budget; files that don't fit are listed by name only. */
export function boundedDiffs(files: Array<{ rel: string; diff: string }>, budget: number): { text: string; omitted: string[] } {
  const out: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    const block = `--- ${f.rel}\n${f.diff.trim()}\n`;
    if (used + block.length <= budget) {
      out.push(block);
      used += block.length;
    } else if (budget - used > 400) {
      const cut = block.slice(0, budget - used - 60) + '\n… [diff truncated; read the file]\n';
      out.push(cut);
      used = budget;
    } else {
      omitted.push(f.rel);
    }
  }
  return { text: out.join('\n'), omitted };
}
