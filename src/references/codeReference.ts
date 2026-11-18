/**
 * File/code references found in agent messages ("mujoco_optimizer.py:167",
 * "[x](C:/a b/c.py:12)", "src/x.ts#L4C2", ...). Pure functions: no
 * filesystem access, no VS Code API, so they run in unit tests unchanged.
 *
 * A reference is only ever OPENED by the extension host after it has been
 * re-validated and resolved (see referenceResolver.ts); nothing here executes
 * anything or opens URLs.
 */

export interface CodeReference {
  /** Path exactly as written (minus file:// and line suffix); may be relative. */
  path: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /** 1-based, inclusive (for "a.py:10-20" / "#L10-L20"). */
  endLine?: number;
}

/** Source-file extensions recognised in plain prose and code spans. */
export const SOURCE_EXTENSIONS = [
  'py', 'pyi', 'pyx', 'ipynb', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5',
  'md', 'mdx', 'rst', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'csv', 'tsv', 'xml', 'urdf', 'sdf', 'mjcf', 'launch',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cu', 'cuh',
  'cs', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm', 'r', 'jl', 'lua', 'pl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'fs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'proto', 'graphql', 'gql', 'gradle', 'cmake', 'mk', 'tf', 'hcl', 'lock', 'log',
];
const EXT = SOURCE_EXTENSIONS.slice().sort((a, b) => b.length - a.length).join('|');
const MAX_LINE = 10_000_000;
const MAX_PATH = 1024;

/** Line suffixes: ":12", ":12:5", ":12-20", "#L12", "#L12C5", "#L12-L20", "(12)", "(12,5)". */
const SUFFIX = String.raw`(?::(\d{1,8})(?::(\d{1,6}))?(?:-(\d{1,8}))?|#L(\d{1,8})(?:C(\d{1,6}))?(?:-L?(\d{1,8}))?|\((\d{1,8})(?:,\s?(\d{1,6}))?\))`;
const SUFFIX_AT_END = new RegExp(`${SUFFIX}$`);

function toLine(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE ? n : undefined;
}

function fromSuffix(m: RegExpExecArray, offset: number): Pick<CodeReference, 'line' | 'column' | 'endLine'> {
  const g = (i: number) => m[offset + i];
  const line = toLine(g(0) ?? g(3) ?? g(6));
  const column = toLine(g(1) ?? g(4) ?? g(7));
  let endLine = toLine(g(2) ?? g(5));
  if (endLine !== undefined && (line === undefined || endLine < line)) endLine = undefined;
  const out: Pick<CodeReference, 'line' | 'column' | 'endLine'> = {};
  if (line) out.line = line;
  if (line && column) out.column = column;
  if (line && endLine && endLine !== line) out.endLine = endLine;
  return out;
}

function hasKnownExtension(p: string): boolean {
  return new RegExp(`\\.(?:${EXT})$`, 'i').test(p);
}

function isDriveAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/** URL schemes other than file: are never file references (http, command:, vscode:, javascript: ...). */
export function hasForeignScheme(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !isDriveAbsolute(s) && !/^file:/i.test(s);
}

/**
 * Parse an explicit target: a Markdown link destination or a whole code span.
 * `strict` (code spans) requires a known source extension; link destinations
 * accept any path with an extension, an absolute path, or file://.
 */
export function parseReferenceTarget(raw: string, options: { strict?: boolean } = {}): CodeReference | undefined {
  let s = raw.trim();
  if (!s || s.length > MAX_PATH || /[\0\r\n]/.test(s)) return undefined;
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (hasForeignScheme(s)) return undefined;
  let explicitFile = false;
  if (/^file:/i.test(s)) {
    explicitFile = true;
    s = s.replace(/^file:(?:\/\/(?:localhost)?)?/i, '');
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1); // file:///C:/x
  }
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return undefined;
    }
  }
  let pos: Pick<CodeReference, 'line' | 'column' | 'endLine'> = {};
  const m = SUFFIX_AT_END.exec(s);
  if (m && m.index > 0) {
    pos = fromSuffix(m, 1);
    s = s.slice(0, m.index);
  }
  s = s.replace(/^\.\/(?=.)/, '');
  if (!s || /[<>"|?*\0]/.test(s.replace(/^[A-Za-z]:/, ''))) return undefined;
  const base = s.split(/[\\/]/).pop() ?? '';
  if (!base || base === '.' || base === '..') return undefined;
  const absolute = isDriveAbsolute(s) || s.startsWith('/') || s.startsWith('\\\\');
  if (options.strict) {
    if (!hasKnownExtension(s)) return undefined;
    // In code spans, whitespace is only accepted inside an absolute path ("C:/Orca robot hand/x.py").
    if (/\s/.test(s) && !isDriveAbsolute(s)) return undefined;
  } else if (!explicitFile && !absolute && !/\.[A-Za-z0-9_+-]{1,12}$/.test(base)) {
    return undefined;
  }
  return { path: s, ...pos };
}

export interface ReferenceMatch {
  /** Offset in the scanned string. */
  start: number;
  end: number;
  ref: CodeReference;
}

// Bare references in prose. Order matters: drive-absolute (may contain spaces), then paths with separators, then file:line.
const DRIVE = new RegExp(String.raw`[A-Za-z]:[\\/][^\0\r\n<>"|?*\x60()\[\]{}]*?\.(?:${EXT})(?![\w\\/-])` + `(?:${SUFFIX})?`, 'iy');
// Must contain a separator (checked in matchReferenceAt): "src/a.py", "./a.py", "../x/a.py", "~/a.py", "a\b.py".
const SLASHED = new RegExp(String.raw`(?:(?:~|\.{1,2})?[\\/])?(?:[\w@+-][\w.@+-]*[\\/])*[\w@+-][\w.@+-]*\.(?:${EXT})(?![\w\\/-])` + `(?:${SUFFIX})?`, 'iy');
const ROOTED = new RegExp(String.raw`[\\/][\w.@+-]+\.(?:${EXT})(?![\w\\/-])` + `(?:${SUFFIX})?`, 'iy');
const BARE_WITH_LINE = new RegExp(String.raw`[\w@+-][\w.@+-]*\.(?:${EXT})` + `${SUFFIX}`, 'iy');

/** Can a bare reference start at offset i (word boundary, not inside a URL or identifier)? */
function boundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return !/[\w.\\/:@$#%&=~+-]/.test(prev);
}

/** Match a bare reference starting exactly at `i`, or undefined. */
export function matchReferenceAt(text: string, i: number): ReferenceMatch | undefined {
  if (!boundary(text, i)) return undefined;
  for (const re of [DRIVE, SLASHED, ROOTED, BARE_WITH_LINE]) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) continue;
    let raw = m[0];
    // "a.py:12," / "a.py." — never swallow sentence punctuation (the regexes already stop before it).
    const sfx = SUFFIX_AT_END.exec(raw);
    const pathPart = sfx && sfx.index > 0 ? raw.slice(0, sfx.index) : raw;
    if (/\s$/.test(pathPart) || /\s{2,}/.test(pathPart)) continue;
    // Spaces are accepted in folder names of absolute paths only; a file name with spaces in prose
    // ("C:/foo is a dir and x.py") is far more likely to be a sentence than a path.
    if (/\s/.test(pathPart.split(/[\\/]/).pop() ?? '')) continue;
    const ref: CodeReference = { path: pathPart.replace(/^\.\/(?=.)/, ''), ...(sfx && sfx.index > 0 ? fromSuffix(sfx, 1) : {}) };
    if (re === BARE_WITH_LINE && ref.line === undefined) continue;
    if (re === SLASHED && !/[\\/]/.test(pathPart)) continue;
    raw = text.slice(i, i + raw.length);
    return { start: i, end: i + raw.length, ref };
  }
  return undefined;
}

/** All bare references in a run of plain text (used for code spans that mix commands and paths). */
export function findReferences(text: string): ReferenceMatch[] {
  const out: ReferenceMatch[] = [];
  for (let i = 0; i < text.length; ) {
    const m = matchReferenceAt(text, i);
    if (m) {
      out.push(m);
      i = m.end;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Validate a reference that came back from a webview (message or context
 * menu). Returns a fresh object with only known, bounded fields.
 */
export function sanitizeReference(input: unknown): CodeReference | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const rawPath = o.path ?? o.refPath;
  if (typeof rawPath !== 'string') return undefined;
  const p = rawPath.trim();
  if (!p || p.length > MAX_PATH || /[\0-\x1f]/.test(p) || hasForeignScheme(p)) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LINE ? v : undefined);
  const line = num(o.line ?? o.refLine);
  const endLine = num(o.endLine ?? o.refEndLine);
  return {
    path: p,
    line,
    column: line ? num(o.column ?? o.refColumn) : undefined,
    endLine: line && endLine && endLine > line ? endLine : undefined,
  };
}

export function formatReference(ref: CodeReference): string {
  return `${ref.path}${ref.line ? `:${ref.line}` : ''}${ref.line && ref.column ? `:${ref.column}` : ''}${ref.endLine ? `-${ref.endLine}` : ''}`;
}
