import * as fs from 'node:fs';
import * as path from 'node:path';
import { AnnouncedOperation } from '../adapters/AgentAdapter';
import { analyzeFileChange } from '../analysis/changeAnalysis';
import { isInside } from '../navigation/pathSafety';
import { createUnifiedDiff, parseHunks } from '../review/unifiedDiff';

/**
 * Shared mapping for agents with file/shell tools (OpenCode, Claude Code).
 * Pure apart from reading the current file text (to build the real diff of
 * a proposed edit BEFORE it is applied). No model involved.
 */
export interface ToolCall {
  /** Tool name as reported by the agent (any case). */
  tool: string;
  input: Record<string, unknown>;
  workspaceRoot: string;
  externalId?: string;
  /** Agent-supplied unified diff (e.g. OpenCode permission metadata), preferred when present. */
  unifiedDiff?: string;
  readText?: (absolutePath: string) => string | undefined;
}

const TEST_COMMAND =
  /\b(pytest|py\.test|unittest|jest|vitest|mocha|(npm|pnpm|yarn)\s+(run\s+)?test|node\s+[\w./-]*test[\w./-]*\.m?[jt]s|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|ctest)\b/i;

/** Commands that can destroy work or data; shown with a warning when approval is requested. */
export const DESTRUCTIVE_COMMAND =
  /(^|[;&|]\s*)(rm|rmdir|del|erase|rd|format|mkfs|dd|shred|truncate)\b|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\b|checkout\s+--\s|branch\s+-D|rebase\b|filter-branch)|\bRemove-Item\b|\bchmod\s+-R\b|\bchown\s+-R\b|>\s*[^&|]+$/i;

/** Files the local agent must never read or modify. Patterns are matched against workspace-relative paths. */
export const SENSITIVE_PATH = /(^|\/)(\.git(\/|$)|\.env($|\.)|\.npmrc$|\.pypirc$|\.netrc$|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)$|.*credentials.*\.json$)/i;

export function str(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v) {
      return v;
    }
  }
  return undefined;
}

export function relPath(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
  return root && isInside(root, abs) ? path.relative(root, abs).replace(/\\/g, '/') || '.' : abs;
}

export function insideWorkspace(root: string, p: string): boolean {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  return !!root && isInside(root, abs);
}

export function isSensitive(root: string, p: string): boolean {
  return SENSITIVE_PATH.test(relPath(root, p).replace(/\\/g, '/'));
}

export function readTextSafe(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size < 2_000_000 ? fs.readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

export function mapToolCall(call: ToolCall): AnnouncedOperation {
  const t = call.tool.toLowerCase();
  const input = call.input ?? {};
  const root = call.workspaceRoot;
  const read = call.readText ?? readTextSafe;
  const filePath = str(input, 'filePath', 'file_path', 'path', 'notebook_path');
  const base = { externalId: call.externalId };

  if (t === 'read' || t === 'view') {
    const rel = filePath ? relPath(root, filePath) : undefined;
    return { ...base, operationType: 'Read', description: rel ? `Read ${rel}` : 'Read file', filePath: rel, lineNumber: num(input.offset) ?? 1 };
  }
  if (t === 'edit' || t === 'multiedit' || t === 'write' || t === 'patch' || t === 'notebookedit') {
    return editOperation(call, t, filePath, read);
  }
  if (t === 'bash' || t === 'shell' || t === 'powershell') {
    const command = str(input, 'command') ?? '';
    const cwd = str(input, 'workdir', 'cwd') ?? root;
    const isTest = TEST_COMMAND.test(command);
    const desc = str(input, 'description');
    return {
      ...base,
      operationType: isTest ? 'Test' : 'Execute',
      description: `${isTest ? 'Run tests' : 'Run'}: ${command}`,
      rationale: desc,
      command: { command, workingDirectory: cwd },
    };
  }
  if (t === 'grep' || t === 'glob' || t === 'list' || t === 'ls' || t === 'find' || t === 'codesearch') {
    const pattern = str(input, 'pattern', 'query', 'glob');
    const where = filePath ? ` in ${relPath(root, filePath)}` : '';
    return { ...base, operationType: 'Read', description: t === 'list' || t === 'ls' ? `List files${where}` : `Search${pattern ? ` for "${pattern}"` : ''}${where}` };
  }
  if (t === 'webfetch' || t === 'websearch') {
    return { ...base, operationType: 'Read', description: `Web: ${str(input, 'url', 'query') ?? ''}`.trim() };
  }
  if (t === 'todowrite' || t === 'todoread') {
    return { ...base, operationType: 'Analyze', description: 'Update task list' };
  }
  if (t === 'task' || t === 'agent') {
    return { ...base, operationType: 'Analyze', description: `Sub-agent: ${str(input, 'description', 'prompt') ?? ''}`.slice(0, 160) };
  }
  return { ...base, operationType: 'Execute', description: `Tool ${call.tool}` };
}

function editOperation(call: ToolCall, t: string, filePath: string | undefined, read: (p: string) => string | undefined): AnnouncedOperation {
  const root = call.workspaceRoot;
  const input = call.input ?? {};
  if (!filePath) {
    return { externalId: call.externalId, operationType: 'Edit', description: `Edit (${call.tool}): file not specified` };
  }
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = relPath(root, filePath);
  const original = read(abs);
  let diff = call.unifiedDiff && parseHunks(call.unifiedDiff).length ? call.unifiedDiff : undefined;
  let kind: 'add' | 'update' = original === undefined ? 'add' : 'update';
  let note: string | undefined;
  if (!diff) {
    let proposed: string | undefined;
    if (t === 'write') {
      proposed = str(input, 'content') ?? '';
    } else if (t === 'edit' || t === 'multiedit') {
      const edits =
        t === 'multiedit' && Array.isArray(input.edits)
          ? (input.edits as Array<Record<string, unknown>>)
          : [input];
      proposed = original ?? '';
      for (const e of edits) {
        const oldS = str(e, 'oldString', 'old_string') ?? '';
        const newS = typeof e.newString === 'string' ? e.newString : typeof e.new_string === 'string' ? e.new_string : '';
        const all = e.replaceAll === true || e.replace_all === true;
        if (oldS === '' && original === undefined) {
          proposed = newS;
          continue;
        }
        if (!proposed.includes(oldS)) {
          note = 'The text to replace was not found in the current file; the agent tool will likely fail.';
          proposed = undefined;
          break;
        }
        proposed = all ? proposed.split(oldS).join(newS) : proposed.replace(oldS, () => newS);
      }
    }
    if (proposed !== undefined) {
      diff = createUnifiedDiff(original ?? '', proposed) ?? undefined;
    }
    if (original === undefined) {
      kind = 'add';
    }
  }
  const analysis = diff ? analyzeFileChange(rel, original, diff, kind) : undefined;
  const fns = (analysis?.functions ?? []).filter((f) => f.kind !== 'class');
  const stats = diff ? countLines(diff) : undefined;
  return {
    externalId: call.externalId,
    operationType: 'Edit',
    description: `${kind === 'add' ? 'Create' : 'Edit'} ${rel}${fns.length === 1 ? ` › ${fns[0].name}()` : fns.length > 1 ? ` › ${fns.length} functions` : ''}${stats ? ` (+${stats.added} −${stats.removed})` : ''}`,
    rationale: note ?? 'Diff computed from the agent tool input against the current file (before it is applied).',
    filePath: rel,
    functionName: fns.length === 1 ? fns[0].name : undefined,
    lineNumber: analysis?.ranges[0]?.startLine,
    changes: diff ? [{ filePath: rel, unifiedDiff: diff, changeKind: kind, functionName: fns.length === 1 ? fns[0].name : undefined }] : undefined,
    changedRanges: analysis?.ranges,
    affectedFunctions: analysis?.functions,
  };
}

function countLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of parseHunks(diff)) {
    for (const l of h.lines) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
  }
  return { added, removed };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}
