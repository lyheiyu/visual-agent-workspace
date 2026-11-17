/**
 * Text-based function lookup used when no language server provides document
 * symbols (e.g. the Python extension is not installed). Pure functions so
 * they can be unit-tested without VS Code.
 */

export interface LineRange {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PY_LANGS = new Set(['python']);

export function guessLanguage(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  if (ext === 'py' || ext === 'pyi') {
    return 'python';
  }
  return 'c-like';
}

/** Locate a function/method/class definition and its full extent. */
export function findFunctionRange(text: string, name: string, languageId?: string): LineRange | undefined {
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const lang = languageId ?? 'c-like';
  return PY_LANGS.has(lang) ? findPython(lines, name) : findBraced(lines, name);
}

function findPython(lines: string[], name: string): LineRange | undefined {
  const def = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${escapeRegExp(name)}\\s*[(:]`);
  for (let i = 0; i < lines.length; i++) {
    const m = def.exec(lines[i]);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    let start = i;
    // Include decorators directly above.
    while (start > 0 && new RegExp(`^\\s{${indent}}@`).test(lines[start - 1])) {
      start--;
    }
    // Skip the (possibly multi-line) signature: find the line ending with ':'.
    let j = i;
    while (j < lines.length - 1 && !/:\s*(#.*)?$/.test(lines[j])) {
      j++;
    }
    let end = j;
    for (let k = j + 1; k < lines.length; k++) {
      const line = lines[k];
      if (line.trim() === '') {
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) {
        break;
      }
      end = k;
    }
    return { startLine: start, endLine: end };
  }
  return undefined;
}

function findBraced(lines: string[], name: string): LineRange | undefined {
  const n = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*[<(]`),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`),
    new RegExp(`\\bclass\\s+${n}\\b`),
    // methods: `name(...) {`, `async name(`, `public static name(`
    new RegExp(`^\\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\\s+)*${n}\\s*(?:<[^>]*>)?\\(`),
    // C/Java/Go-ish: `type name(`, `func name(`
    new RegExp(`^\\s*(?:func\\s+(?:\\([^)]*\\)\\s*)?|[\\w<>\\[\\],*&:\\s]+\\s)${n}\\s*\\(`),
  ];
  for (let i = 0; i < lines.length; i++) {
    if (!patterns.some((p) => p.test(lines[i]))) {
      continue;
    }
    // Brace matching from the first '{' at or after the signature.
    let depth = 0;
    let opened = false;
    for (let k = i; k < lines.length; k++) {
      for (const ch of stripStringsAndComments(lines[k])) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (opened && depth <= 0) {
        return { startLine: i, endLine: k };
      }
      if (!opened && k - i > 5) {
        break; // probably a declaration without a body
      }
    }
    return { startLine: i, endLine: i };
  }
  return undefined;
}

function stripStringsAndComments(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

export interface FunctionRange extends LineRange {
  name: string;
  kind: 'function' | 'class' | 'method';
}

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const TS_DEFS: Array<[RegExp, FunctionRange['kind']]> = [
  [/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/, 'function'],
  [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
  [/\bclass\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\{/, 'method'],
];
const NOT_NAMES = /^(if|for|while|switch|catch|return|function|else|do|try|with)$/;

/**
 * All function/class/method definitions with their full extents (0-based).
 * Text-based (Python indentation, brace matching for C-like languages); used
 * when no language-server symbols are available, and for virtual documents.
 * Returns only definitions it could delimit; never guesses names.
 */
export function listFunctionRanges(text: string, languageId?: string): FunctionRange[] {
  const lang = languageId ?? 'c-like';
  const lines = text.split(/\r?\n/);
  const out: FunctionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    let name: string | undefined;
    let kind: FunctionRange['kind'] = 'function';
    if (lang === 'python') {
      const m = PY_DEF.exec(lines[i]);
      if (m) {
        name = m[3];
        kind = m[2] === 'class' ? 'class' : m[1].length > 0 ? 'method' : 'function';
      }
    } else {
      for (const [re, k] of TS_DEFS) {
        const m = re.exec(lines[i]);
        if (m && !NOT_NAMES.test(m[1])) {
          name = m[1];
          kind = k;
          break;
        }
      }
    }
    if (!name) {
      continue;
    }
    // Measure the definition that starts on this line.
    const range = findFunctionRange(lines.slice(i).join('\n'), name, lang);
    if (!range || range.startLine !== 0) {
      continue;
    }
    out.push({ name, kind, startLine: i, endLine: i + range.endLine });
  }
  return out;
}

/**
 * Name of the innermost function/class containing `line` (0-based), or
 * undefined at module level. An inference for labels/navigation only.
 */
export function findEnclosingFunction(text: string, line: number, languageId?: string): string | undefined {
  return innermost(listFunctionRanges(text, languageId), line)?.name;
}

export function innermost<T extends LineRange>(ranges: T[], line: number): T | undefined {
  let best: T | undefined;
  for (const r of ranges) {
    if (line >= r.startLine && line <= r.endLine && (!best || r.endLine - r.startLine < best.endLine - best.startLine)) {
      best = r;
    }
  }
  return best;
}

/**
 * Replace the named function with `replacement`, preserving the file's EOL
 * style and the original indentation of the definition.
 */
export function replaceFunction(
  text: string,
  name: string,
  replacement: string,
  languageId?: string,
): { text: string; range: LineRange } | undefined {
  const range = findFunctionRange(text, name, languageId);
  if (!range) {
    return undefined;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const indent = /^\s*/.exec(lines[range.startLine])![0];
  const replacementLines = replacement
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l.length ? indent + l : l));
  lines.splice(range.startLine, range.endLine - range.startLine + 1, ...replacementLines);
  return { text: lines.join(eol), range };
}
