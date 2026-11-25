import { applyUnifiedDiff, parseHunks } from '../review/unifiedDiff';
import { guessLanguage, innermost, listFunctionRanges } from '../navigation/symbolSearch';
import { parseScriptSymbols } from '../navigation/scriptSymbols';
import { AffectedFunction, ChangedRange } from '../types/events';

/**
 * Pure analysis of one file's patch: which lines change and which functions
 * contain them. No LLM involved. Function names come only from parsing the
 * actual file text; lines outside any parsed definition get no name.
 */
export interface FileChangeAnalysis {
  /** 1-based, inclusive. 'new' = lines in the patched file; 'old' = removed-only regions in the original. */
  ranges: ChangedRange[];
  functions: AffectedFunction[];
  /** Patched text, if the hunks applied cleanly. */
  newText?: string;
}

export function analyzeFileChange(
  filePath: string,
  originalText: string | undefined,
  unifiedDiff: string,
  changeKind: 'add' | 'delete' | 'update' = 'update',
): FileChangeAnalysis {
  const lang = guessLanguage(filePath);
  const ranges = changedRanges(filePath, unifiedDiff);
  const base = changeKind === 'add' ? '' : originalText;
  const newText = changeKind === 'delete' ? '' : base === undefined ? undefined : applyUnifiedDiff(base, unifiedDiff);

  const functions = new Map<string, AffectedFunction>();
  const add = (text: string, lines: number[], side: 'new' | 'old') => {
    const defs = parseScriptSymbols(filePath, text)?.functions ?? listFunctionRanges(text, lang);
    for (const line of lines) {
      const fn = innermost(defs, line - 1);
      if (fn?.name && !functions.has(`${fn.name}:${side}`) && !(side === 'old' && functions.has(`${fn.name}:new`))) {
        functions.set(`${fn.name}:${side}`, {
          filePath,
          name: fn.name,
          kind: fn.kind,
          startLine: fn.startLine + 1,
          endLine: fn.endLine + 1,
          side,
          source: 'parser',
        });
      }
    }
  };
  const newLines = ranges.filter((r) => r.side === 'new').flatMap((r) => span(r.startLine, r.endLine));
  const oldLines = oldChangedLines(unifiedDiff);
  if (newText !== undefined) {
    add(newText, newLines, 'new');
  }
  if (originalText !== undefined && changeKind !== 'add') {
    // Functions that were edited or deleted, as located in the original file.
    add(originalText, oldLines, 'old');
  }
  return { ranges, functions: [...functions.values()], newText };
}

/**
 * Changed line ranges from hunks. Added/modified lines are reported on the
 * new side; a removal that is not replaced by added lines is reported on
 * the old side (it has no new-side lines to point at).
 */
export function changedRanges(filePath: string, unifiedDiff: string): ChangedRange[] {
  const out: ChangedRange[] = [];
  for (const h of parseHunks(unifiedDiff)) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    let added: { start: number } | undefined;
    let removed: { start: number; end: number } | undefined;
    const flush = () => {
      if (added) {
        out.push({ filePath, side: 'new', startLine: added.start, endLine: newLine - 1 });
      } else if (removed) {
        out.push({ filePath, side: 'old', startLine: removed.start, endLine: removed.end });
      }
      added = undefined;
      removed = undefined;
    };
    for (const l of h.lines) {
      if (l[0] === '+') {
        added ??= { start: newLine };
        newLine++;
      } else if (l[0] === '-') {
        if (added) {
          flush();
        }
        removed = removed ? { ...removed, end: oldLine } : { start: oldLine, end: oldLine };
        oldLine++;
      } else {
        flush();
        oldLine++;
        newLine++;
      }
    }
    flush();
  }
  return out;
}


function oldChangedLines(diff: string): number[] {
  const lines: number[] = [];
  for (const h of parseHunks(diff)) {
    let oldLine = h.oldStart;
    for (const l of h.lines) {
      if (l[0] === '-') {
        lines.push(oldLine);
      }
      if (l[0] !== '+') {
        oldLine++;
      }
    }
  }
  return lines;
}

function span(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b && out.length < 10_000; i++) {
    out.push(i);
  }
  return out;
}
