import * as path from 'node:path';
import { AnnouncedOperation, OperationCompletion } from '../AgentAdapter';
import { isInside } from '../../navigation/pathSafety';
import { diffStats, createUnifiedDiff } from '../../review/unifiedDiff';
import { analyzeFileChange } from '../../analysis/changeAnalysis';
import { AffectedFunction, ChangedRange } from '../../types/events';
import { CommandAction, ThreadItem } from './protocol';

/**
 * Pure translation of Codex App Server items into Agent Activity operations.
 * No I/O except the injected `readText` (used to infer which function an
 * edit touches, for labelling/navigation only).
 */
export class CodexItemMapper {
  constructor(
    private readonly workspaceRoot: string,
    private readonly readText: (absolutePath: string) => string | undefined = () => undefined,
  ) {}

  /** Path relative to the workspace when inside it; otherwise absolute. */
  displayPath(p: string, cwd?: string): string {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd ?? this.workspaceRoot, p);
    return this.workspaceRoot && isInside(this.workspaceRoot, abs) ? path.relative(this.workspaceRoot, abs).replace(/\\/g, '/') || '.' : abs;
  }

  isInsideWorkspace(p: string, cwd?: string): boolean {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd ?? this.workspaceRoot, p);
    return !!this.workspaceRoot && isInside(this.workspaceRoot, abs);
  }

  /** Announcement for item/started. Undefined = not an operation (e.g. user message). */
  announce(item: ThreadItem): AnnouncedOperation | undefined {
    switch (item.type) {
      case 'commandExecution':
        return this.commandOperation(item as Extract<ThreadItem, { type: 'commandExecution' }>);
      case 'fileChange':
        return this.fileChangeOperation(item as Extract<ThreadItem, { type: 'fileChange' }>);
      case 'mcpToolCall': {
        const it = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
        return { operationType: 'Execute', description: `MCP tool ${it.server}/${it.tool}`, externalId: it.id };
      }
      case 'webSearch': {
        const q = (item as { query?: string }).query;
        return { operationType: 'Read', description: q ? `Web search: ${q}` : 'Web search', externalId: item.id };
      }
      default:
        // agentMessage/reasoning/plan are recorded on completion (text is empty at start).
        return undefined;
    }
  }

  /** For items that are only meaningful once complete (messages, reasoning, plans). */
  announceOnCompletion(item: ThreadItem): { op: AnnouncedOperation; completion: OperationCompletion } | undefined {
    if (item.type === 'agentMessage') {
      const text = String((item as { text?: string }).text ?? '').trim();
      if (!text) {
        return undefined;
      }
      return {
        op: { operationType: 'Analyze', description: `Codex: ${firstLine(text, 140)}`, externalId: item.id },
        completion: { outcome: 'Completed', resultSummary: text, assistantMessage: true },
      };
    }
    if (item.type === 'reasoning') {
      const summary = ((item as { summary?: unknown[] }).summary ?? []).map(String).join('\n').trim();
      return summary
        ? {
            op: { operationType: 'Analyze', description: `Reasoning: ${firstLine(summary, 140)}`, externalId: item.id },
            completion: { outcome: 'Completed', resultSummary: summary },
          }
        : undefined;
    }
    if (item.type === 'plan') {
      const text = String((item as { text?: string }).text ?? '').trim();
      return text
        ? {
            op: { operationType: 'Analyze', description: `Plan: ${firstLine(text, 140)}`, externalId: item.id },
            completion: { outcome: 'Completed', resultSummary: text },
          }
        : undefined;
    }
    if (item.type === 'userMessage') {
      return undefined;
    }
    if (!['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) {
      return {
        op: { operationType: 'Analyze', description: `Codex item: ${item.type}`, externalId: item.id },
        completion: { outcome: 'Completed', resultSummary: 'Item type not interpreted by Visual Agent Workspace v0.2.' },
      };
    }
    return undefined;
  }

  /** Terminal state for item/completed of an operation item. */
  completion(item: ThreadItem): OperationCompletion {
    const status = (item as { status?: string }).status;
    if (item.type === 'commandExecution') {
      const it = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      const command = {
        exitCode: it.exitCode ?? undefined,
        stdout: it.aggregatedOutput ?? undefined,
        outputCombined: true,
        finishedAt: new Date().toISOString(),
      };
      if (status === 'declined') {
        return { outcome: 'Rejected', resultSummary: 'Declined: Codex did not run this command.', command };
      }
      const ok = status === 'completed' && (it.exitCode ?? 0) === 0;
      return {
        outcome: ok ? 'Completed' : 'Failed',
        resultSummary: `Exit code ${it.exitCode ?? 'unknown'}${it.durationMs != null ? ` after ${it.durationMs} ms` : ''}.`,
        command,
      };
    }
    if (item.type === 'fileChange') {
      if (status === 'declined') {
        return { outcome: 'Rejected', resultSummary: 'Patch declined: no file was changed.' };
      }
      return status === 'completed'
        ? { outcome: 'Completed', resultSummary: 'Patch applied by Codex.' }
        : { outcome: 'Failed', resultSummary: `Patch ${status ?? 'did not complete'}.` };
    }
    if (item.type === 'mcpToolCall') {
      const err = (item as { error?: { message?: string } | null }).error;
      return err ? { outcome: 'Failed', resultSummary: err.message ?? 'MCP tool call failed.' } : { outcome: 'Completed' };
    }
    return { outcome: status === 'failed' ? 'Failed' : 'Completed' };
  }

  // ------------------------------------------------------------ internals

  private commandOperation(it: Extract<ThreadItem, { type: 'commandExecution' }>): AnnouncedOperation {
    const display = unwrapShellCommand(it.command);
    const actions: CommandAction[] = it.commandActions ?? [];
    const readOnlyActions = actions.length > 0 && actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search');
    const read = actions.find((a): a is Extract<CommandAction, { type: 'read' }> => a.type === 'read');
    let operationType: AnnouncedOperation['operationType'] = 'Execute';
    let description = `Run: ${display}`;
    let filePath: string | undefined;
    if (readOnlyActions) {
      operationType = 'Read';
      if (read) {
        filePath = this.displayPath(read.path, it.cwd);
        description = `Read ${filePath}`;
      } else {
        const search = actions.find((a) => a.type === 'search') as Extract<CommandAction, { type: 'search' }> | undefined;
        description = search ? `Search${search.query ? ` for "${search.query}"` : ''}${search.path ? ` in ${search.path}` : ''}` : `List files`;
      }
    } else if (TEST_COMMAND.test(display)) {
      operationType = 'Test';
      description = `Run tests: ${display}`;
    }
    return {
      operationType,
      description,
      filePath,
      lineNumber: filePath ? 1 : undefined,
      command: { command: it.command, workingDirectory: it.cwd },
      externalId: it.id,
    };
  }

  private fileChangeOperation(it: Extract<ThreadItem, { type: 'fileChange' }>): AnnouncedOperation {
    let added = 0;
    let removed = 0;
    const allRanges: ChangedRange[] = [];
    const allFunctions: AffectedFunction[] = [];
    const changes = (it.changes ?? []).map((raw) => {
      // For added/deleted files Codex reports the file content, not a unified diff.
      const k = raw.kind?.type ?? 'update';
      const isHunked = /^@@ /m.test(raw.diff ?? '');
      const c = !isHunked && (k === 'add' || k === 'delete') && raw.diff !== undefined
        ? { ...raw, diff: (k === 'add' ? createUnifiedDiff('', raw.diff) : createUnifiedDiff(raw.diff, '')) ?? '' }
        : raw;
      const stats = diffStats(c.diff ?? '');
      added += stats.added;
      removed += stats.removed;
      const kind = c.kind?.type ?? 'update';
      const rel = this.displayPath(c.path);
      const abs = path.isAbsolute(c.path) ? c.path : path.resolve(this.workspaceRoot, c.path);
      // Original text is read at announcement time (before Codex applies anything).
      const original = kind === 'add' ? undefined : this.readText(abs);
      const analysis = analyzeFileChange(rel, original, c.diff ?? '', kind);
      allRanges.push(...analysis.ranges);
      allFunctions.push(...analysis.functions);
      const fns = analysis.functions.filter((f) => f.kind !== 'class');
      const firstRange = analysis.ranges[0];
      return {
        filePath: rel,
        unifiedDiff: c.diff ?? '',
        changeKind: kind,
        // Only name a function when exactly one was found by parsing.
        functionName: fns.length === 1 ? fns[0].name : undefined,
        line: firstRange?.startLine ?? stats.firstChangedOldLine,
      };
    });
    const first = changes[0];
    const counts = `(+${added} −${removed})`;
    const kindVerb = first?.changeKind === 'add' ? 'Create' : first?.changeKind === 'delete' ? 'Delete' : 'Edit';
    const fnNames = [...new Set(allFunctions.filter((f) => f.kind !== 'class').map((f) => `${f.name}()`))];
    const fnLabel = fnNames.length === 1 ? ` › ${fnNames[0]}` : fnNames.length > 1 ? ` › ${fnNames.length} functions` : '';
    const description =
      changes.length === 1
        ? `${kindVerb} ${first.filePath}${fnLabel} ${counts}`
        : `Edit ${changes.length} files: ${changes.map((c) => c.filePath).join(', ')} ${counts}`;
    return {
      operationType: 'Edit',
      description,
      rationale:
        'Codex patch. Approval covers the ENTIRE patch' +
        (changes.length > 1 ? ` across ${changes.length} files` : '') +
        '. Affected functions are found by parsing the file around the changed lines (no model involved).',
      filePath: first?.filePath,
      functionName: fnNames.length === 1 ? first?.functionName : undefined,
      lineNumber: first?.line,
      changes: changes.map(({ filePath, unifiedDiff, changeKind, functionName }) => ({ filePath, unifiedDiff, changeKind, functionName })),
      changedRanges: allRanges,
      affectedFunctions: allFunctions,
      externalId: it.id,
    };
  }

}

const TEST_COMMAND =
  /\b(pytest|py\.test|unittest|jest|vitest|mocha|(npm|pnpm|yarn)\s+(run\s+)?test|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|ctest)\b/i;

/**
 * Strip the shell wrapper Codex adds (powershell -Command '...', bash -lc '...')
 * for display. The exact command is still recorded unchanged.
 */
export function unwrapShellCommand(command: string): string {
  const patterns = [
    /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+'([\s\S]*)'$/i,
    /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+"([\s\S]*)"$/i,
    /^"?[^"\s]*?(?:bash|zsh|sh)"?\s+-l?c\s+'([\s\S]*)'$/,
    /^"?[^"\s]*?(?:bash|zsh|sh)"?\s+-l?c\s+"([\s\S]*)"$/,
    /^"?[^"]*?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]*)$/,
  ];
  for (const p of patterns) {
    const m = p.exec(command.trim());
    if (m) {
      return m[1].replace(/''/g, "'");
    }
  }
  return command;
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
