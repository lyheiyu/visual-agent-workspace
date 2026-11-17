import * as path from 'node:path';

export type PathResolution =
  | { ok: true; absolutePath: string; relativePath: string; insideWorkspace: boolean }
  | { ok: false; reason: string };

/**
 * Resolve an agent-supplied path against the workspace root and verify it is
 * safe to open. Paths outside the workspace are refused unless explicitly
 * allowed. Never touches the filesystem.
 */
export function resolveWorkspacePath(
  workspaceRoot: string | undefined,
  requested: string,
  options: { allowOutsideWorkspace?: boolean; pathModule?: path.PlatformPath } = {},
): PathResolution {
  const p = options.pathModule ?? path;
  if (!requested || typeof requested !== 'string') {
    return { ok: false, reason: 'No file path was provided.' };
  }
  if (requested.includes('\0')) {
    return { ok: false, reason: 'File path contains an invalid character.' };
  }
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(requested)) {
    return { ok: false, reason: `Only local workspace files can be opened (got "${requested}").` };
  }
  if (!workspaceRoot) {
    if (p.isAbsolute(requested) && options.allowOutsideWorkspace) {
      const abs = p.normalize(requested);
      return { ok: true, absolutePath: abs, relativePath: abs, insideWorkspace: false };
    }
    return { ok: false, reason: 'No workspace folder is open.' };
  }
  const root = p.resolve(workspaceRoot);
  const absolutePath = p.isAbsolute(requested) ? p.normalize(requested) : p.resolve(root, requested);
  const inside = isInside(root, absolutePath, p);
  if (!inside && !options.allowOutsideWorkspace) {
    return { ok: false, reason: `"${requested}" is outside the workspace; navigation refused.` };
  }
  return {
    ok: true,
    absolutePath,
    relativePath: inside ? p.relative(root, absolutePath) || '.' : absolutePath,
    insideWorkspace: inside,
  };
}

export function isInside(root: string, candidate: string, p: path.PlatformPath = path): boolean {
  const caseInsensitive = p.sep === '\\';
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const rel = p.relative(norm(p.resolve(root)), norm(p.resolve(candidate)));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}
