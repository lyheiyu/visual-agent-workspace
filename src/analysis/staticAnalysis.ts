import * as path from 'node:path';
import { FunctionRange, innermost, listFunctionRanges } from '../navigation/symbolSearch';
import { isInside } from '../navigation/pathSafety';

/**
 * Local, model-free static analysis used to pick MINIMAL context for the
 * reviewer. All results are heuristic text matches unless produced by a
 * language server (the caller labels the source).
 */
export interface SourceFile {
  filePath: string; // workspace-relative
  text: string;
  language: string; // 'python' | 'c-like'
}

export interface CallSite {
  filePath: string;
  line: number; // 1-based
  callerFunction?: string;
  snippet: string;
}

export function findCallSites(name: string, files: SourceFile[], max = 20): CallSite[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return [];
  }
  const call = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(|\\.${name.replace(/\$/g, '\\$')}\\s*\\(`);
  const def = new RegExp(`\\b(def|function|class)\\s+${name.replace(/\$/g, '\\$')}\\b|\\b(const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*=`);
  const out: CallSite[] = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    let defs: FunctionRange[] | undefined;
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const l = lines[i];
      if (!call.test(l) || def.test(l) || /^\s*(#|\/\/|\*)/.test(l)) {
        continue;
      }
      defs ??= listFunctionRanges(f.text, f.language);
      out.push({ filePath: f.filePath, line: i + 1, callerFunction: innermost(defs, i)?.name, snippet: l.trim().slice(0, 200) });
    }
  }
  return out;
}

/** Functions called from `code` that are defined somewhere in `files` (by name). */
export function findCallees(code: string, files: SourceFile[], self?: string): Array<{ name: string; filePath: string; line: number }> {
  const called = new Set<string>();
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    called.add(m[1]);
  }
  const out: Array<{ name: string; filePath: string; line: number }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const d of listFunctionRanges(f.text, f.language)) {
      if (called.has(d.name) && d.name !== self && !seen.has(d.name)) {
        seen.add(d.name);
        out.push({ name: d.name, filePath: f.filePath, line: d.startLine + 1 });
      }
    }
  }
  return out.slice(0, 20);
}

export interface ErrorLocation {
  filePath: string; // workspace-relative
  line: number;
}

/**
 * file:line references in command output (Python tracebacks, pytest, tsc,
 * node/jest stack traces). Only paths inside the workspace are returned.
 */
export function extractErrorLocations(output: string, workspaceRoot: string, cwd?: string, max = 5): ErrorLocation[] {
  const patterns = [
    /File "([^"]+)", line (\d+)/g, // Python traceback
    /^([^\s:()'"]+\.(?:py|ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::\d+)?/gm, // pytest / eslint / node
    /([^\s:()'"]+\.(?:ts|tsx|js|jsx))\((\d+),\d+\)/g, // tsc
    /\(([^\s()'"]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):\d+\)/g, // stack frames
  ];
  const out: ErrorLocation[] = [];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const m of output.matchAll(re)) {
      const abs = path.isAbsolute(m[1]) ? path.normalize(m[1]) : path.resolve(cwd || workspaceRoot, m[1]);
      if (!workspaceRoot || !isInside(workspaceRoot, abs)) {
        continue;
      }
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
      const key = `${rel}:${m[2]}`;
      if (!seen.has(key) && !/(^|\/)(node_modules|site-packages|\.venv|venv)\//.test(rel)) {
        seen.add(key);
        out.push({ filePath: rel, line: Number(m[2]) });
      }
    }
  }
  return out.slice(0, max);
}

/**
 * Module-level constant/variable definitions that `code` references, so a
 * reviewer does not report them as "undefined". Single-line definitions only.
 */
export function referencedModuleDefinitions(fileText: string, code: string, language: string, max = 10): Array<{ line: number; text: string }> {
  const re = language === 'python' ? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/ : /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!>)/;
  const out: Array<{ line: number; text: string }> = [];
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const m = re.exec(lines[i]);
    const name = m?.[1].replace(/\$/g, '\\$');
    if (m && new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(code) && !code.includes(lines[i])) {
      out.push({ line: i + 1, text: lines[i].slice(0, 300) });
    }
  }
  return out;
}
