/**
 * Minimal unified-diff support for Codex `fileChange` items.
 *
 * Codex sends per-file hunks without ---/+++ headers, e.g.
 *   "@@ -26 +26,2 @@\n     }\n+# reviewed\n"
 * Pure functions; used only to *render* a proposed change for review. The
 * extension never writes the result anywhere.
 */

export interface Hunk {
  oldStart: number; // 1-based
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each begins with ' ', '-', '+'
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('\\')) {
      continue;
    }
    if (raw === '' ) {
      continue; // trailing newline at end of diff text
    }
    if (raw[0] === ' ' || raw[0] === '-' || raw[0] === '+') {
      current.lines.push(raw);
    }
  }
  return hunks;
}

export interface DiffStats {
  added: number;
  removed: number;
  hunks: number;
  /** 1-based line in the ORIGINAL file of the first changed line. */
  firstChangedOldLine?: number;
}

export function diffStats(diff: string): DiffStats {
  const hunks = parseHunks(diff);
  let added = 0;
  let removed = 0;
  let firstChangedOldLine: number | undefined;
  for (const h of hunks) {
    let oldLine = h.oldStart;
    for (const l of h.lines) {
      if (l[0] === '+') {
        added++;
        firstChangedOldLine ??= Math.max(1, oldLine);
      } else if (l[0] === '-') {
        removed++;
        firstChangedOldLine ??= oldLine;
        oldLine++;
      } else {
        oldLine++;
      }
    }
  }
  return { added, removed, hunks: hunks.length, firstChangedOldLine };
}

/**
 * Apply hunks to `original`. Each hunk is located at its stated position,
 * or (fuzz) the nearest position where its context/removed lines match.
 * Returns undefined if any hunk does not match.
 */
export function applyUnifiedDiff(original: string, diff: string): string | undefined {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(original);
  const lines = original === '' ? [] : original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const hunks = parseHunks(diff);
  if (!hunks.length) {
    return undefined;
  }
  let offset = 0;
  for (const h of hunks) {
    const oldBlock = h.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1));
    const newBlock = h.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1));
    // For pure insertions, -N,0 means "after line N".
    const expected = (h.oldLines === 0 ? h.oldStart : h.oldStart - 1) + offset;
    const at = findBlock(lines, oldBlock, expected);
    if (at === undefined) {
      return undefined;
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    offset += newBlock.length - oldBlock.length;
  }
  return lines.join(eol) + (hadTrailingNewline || original === '' ? eol : '');
}

function findBlock(lines: string[], block: string[], expected: number): number | undefined {
  const matches = (at: number) =>
    at >= 0 && at + block.length <= lines.length && block.every((b, i) => lines[at + i] === b);
  if (block.length === 0) {
    return Math.min(Math.max(expected, 0), lines.length);
  }
  for (let d = 0; d <= Math.max(lines.length, 1); d++) {
    if (matches(expected - d)) {
      return expected - d;
    }
    if (d && matches(expected + d)) {
      return expected + d;
    }
  }
  return undefined;
}

/**
 * Small LCS line diff producing unified hunks (3 lines of context). Used only
 * to show changes that were not recorded as a diff (mock function
 * replacements). Returns undefined for inputs too large to diff cheaply.
 */
export function createUnifiedDiff(original: string, modified: string, context = 3): string | undefined {
  // An empty file has no lines (not one empty line).
  const lines = (t: string) => (t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));
  const a = lines(original);
  const b = lines(modified);
  if (a.length * b.length > 4_000_000) {
    return undefined;
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i], ai: i++, bi: j++ });
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push({ t: '+', s: b[j], ai: i, bi: j++ });
    } else {
      ops.push({ t: '-', s: a[i], ai: i++, bi: j });
    }
  }
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) {
    return '';
  }
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
    const slice = ops.slice(start, end + 1);
    const oldLines = slice.filter((o) => o.t !== '+').length;
    const newLines = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${slice[0].ai + (oldLines ? 1 : 0)},${oldLines} +${slice[0].bi + (newLines ? 1 : 0)},${newLines} @@`);
    out.push(...slice.map((o) => o.t + o.s));
    k++;
  }
  return out.join('\n') + '\n';
}
