import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { isInside } from '../navigation/pathSafety';
import { CodeReference } from './codeReference';

/**
 * Resolve a reference from an agent message to a real file. Read-only: it
 * only stats and lists directories; it never opens, creates or executes.
 *
 * Order:
 *  1. absolute path that exists (inside a root → file, otherwise → outside);
 *  2. relative to the PRIMARY root (the conversation's project), then the
 *     other workspace roots — a hit in the primary root wins;
 *  3. path-suffix search under the roots ("mujoco_optimizer.py" or
 *     "orca_sim/x.py" written relative to another folder); several matches
 *     → ambiguous (the caller asks the user), never a silent guess.
 */
export type RefResolution =
  | { kind: 'file'; absolutePath: string; root?: string; via: 'absolute' | 'relative' | 'suffix' }
  | { kind: 'ambiguous'; candidates: Array<{ absolutePath: string; root: string }> }
  | { kind: 'outside'; absolutePath: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface ResolveOptions {
  /** Primary root first (the conversation's project), then workspace folders. */
  roots: string[];
  pathModule?: nodePath.PlatformPath;
  stat?: (p: string) => Promise<'file' | 'dir' | undefined>;
  /** Suffix search; defaults to a bounded directory walk. */
  findBySuffix?: (root: string, segments: string[]) => Promise<string[]>;
}

export const SEARCH_EXCLUDES = new Set(['node_modules', '.git', '.hg', '.svn', 'out', 'dist', 'build', '.venv', 'venv', 'env', '__pycache__', '.vscode-test', '.mypy_cache', '.pytest_cache', '.tox', 'site-packages', '.next', 'target', '.idea']);

export async function resolveReference(ref: CodeReference, options: ResolveOptions): Promise<RefResolution> {
  const p = options.pathModule ?? nodePath;
  const stat = options.stat ?? defaultStat;
  const find = options.findBySuffix ?? ((root: string, segs: string[]) => walkForSuffix(root, segs, p));
  const roots = dedupe(options.roots.filter((r) => r && p.isAbsolute(r)).map((r) => p.resolve(r)), p);
  let raw = ref.path.trim();
  if (!raw || raw.includes('\0')) return { kind: 'invalid', reason: 'Empty or invalid path.' };
  // Git-Bash / MSYS style "/c/Users/..." on Windows.
  if (p.sep === '\\' && /^\/[A-Za-z]\//.test(raw)) raw = `${raw[1]}:${raw.slice(2)}`;
  const absolute = p.isAbsolute(raw);
  const segments = raw.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (!segments.length) return { kind: 'invalid', reason: `"${ref.path}" is not a file path.` };

  if (absolute) {
    const abs = p.normalize(raw);
    const kind = await stat(abs);
    if (kind === 'dir') return { kind: 'invalid', reason: `"${ref.path}" is a folder, not a file.` };
    if (kind === 'file') {
      const root = roots.find((r) => isInside(r, abs, p));
      return root ? { kind: 'file', absolutePath: abs, root, via: 'absolute' } : { kind: 'outside', absolutePath: abs };
    }
    // Written on another machine / in WSL: try the trailing segments inside the roots.
    const tail = segments.slice(-3);
    const viaSuffix = await bySuffix(roots, tail, find, p);
    if (viaSuffix) return viaSuffix;
    return { kind: 'missing', reason: `File not found: ${ref.path}` };
  }

  if (segments.includes('..')) {
    for (const root of roots) {
      const abs = p.resolve(root, raw);
      if (!isInside(root, abs, p) && (await stat(abs)) === 'file') return { kind: 'outside', absolutePath: abs };
    }
  }
  const direct: Array<{ absolutePath: string; root: string }> = [];
  for (const root of roots) {
    const abs = p.resolve(root, raw);
    if (!isInside(root, abs, p)) continue;
    const kind = await stat(abs);
    if (kind === 'file') {
      if (root === roots[0]) return { kind: 'file', absolutePath: abs, root, via: 'relative' };
      direct.push({ absolutePath: abs, root });
    } else if (kind === 'dir' && root === roots[0]) {
      return { kind: 'invalid', reason: `"${ref.path}" is a folder, not a file.` };
    }
  }
  if (direct.length === 1) return { kind: 'file', ...direct[0], via: 'relative' };
  if (direct.length > 1) return { kind: 'ambiguous', candidates: direct };
  if (segments.includes('..')) return { kind: 'missing', reason: `File not found: ${ref.path}` };
  const viaSuffix = await bySuffix(roots, segments, find, p);
  return viaSuffix ?? { kind: 'missing', reason: roots.length ? `File not found in the project: ${ref.path}` : 'No project folder is open to resolve this path.' };
}

async function bySuffix(roots: string[], segments: string[], find: (root: string, segs: string[]) => Promise<string[]>, p: nodePath.PlatformPath): Promise<RefResolution | undefined> {
  const found: Array<{ absolutePath: string; root: string }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const abs of await find(root, segments)) {
      const key = p.sep === '\\' ? abs.toLowerCase() : abs;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ absolutePath: abs, root });
    }
  }
  if (found.length === 1) return { kind: 'file', ...found[0], via: 'suffix' };
  if (found.length > 1) {
    // Prefer matches in the primary root only when it is the only root with matches? No: always ask.
    found.sort((a, b) => Number(b.root === roots[0]) - Number(a.root === roots[0]) || a.absolutePath.length - b.absolutePath.length);
    return { kind: 'ambiguous', candidates: found.slice(0, 50) };
  }
  return undefined;
}

async function defaultStat(p: string): Promise<'file' | 'dir' | undefined> {
  try {
    const s = await fs.promises.stat(p);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bounded breadth-first walk for files whose path ends with `segments`.
 * Skips dependency/build folders; stops after `maxEntries` directory entries
 * or `timeLimitMs`, so a huge folder can never hang the UI.
 */
export async function walkForSuffix(
  root: string,
  segments: string[],
  p: nodePath.PlatformPath = nodePath,
  limits: { maxEntries?: number; timeLimitMs?: number; maxResults?: number } = {},
): Promise<string[]> {
  const maxEntries = limits.maxEntries ?? 60_000;
  const deadline = Date.now() + (limits.timeLimitMs ?? 2500);
  const maxResults = limits.maxResults ?? 50;
  const ci = p.sep === '\\' || process.platform === 'darwin';
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  const want = segments.map(norm);
  const base = want[want.length - 1];
  const out: string[] = [];
  const queue = [root];
  let entries = 0;
  while (queue.length && out.length < maxResults) {
    const dir = queue.shift()!;
    let list: fs.Dirent[];
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of list) {
      if (++entries > maxEntries || Date.now() > deadline) return out;
      if (d.isDirectory()) {
        if (!SEARCH_EXCLUDES.has(d.name) && !d.name.startsWith('.')) queue.push(p.join(dir, d.name));
      } else if (d.isFile() && norm(d.name) === base) {
        const full = p.join(dir, d.name);
        // Compare against the full path so "orca sim/orca_sim/util.py" also matches when the root IS ".../orca sim/orca_sim".
        const rel = full.split(/[\\/]+/).map(norm);
        if (rel.length >= want.length && want.every((s, k) => rel[rel.length - want.length + k] === s)) out.push(full);
      }
    }
  }
  return out;
}

function dedupe(roots: string[], p: nodePath.PlatformPath): string[] {
  const seen = new Set<string>();
  return roots.filter((r) => {
    const k = p.sep === '\\' ? r.toLowerCase() : r;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
