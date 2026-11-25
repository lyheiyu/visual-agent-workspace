import { createHash } from 'node:crypto';
import { referencedModuleDefinitions } from '../analysis/staticAnalysis';
import { innermost, listFunctionRanges, LineRange } from '../navigation/symbolSearch';
import { parseScriptSymbols } from '../navigation/scriptSymbols';
import { createUnifiedDiff } from '../review/unifiedDiff';
import type { CodeBlock } from './prompts';

export type ReviewSide = 'before' | 'after';

export interface ReviewBlock extends CodeBlock {
  side: ReviewSide;
  kind: 'function' | 'change' | 'definition';
  changed?: string;
}

export interface ExtractedChangeContext {
  blocks: ReviewBlock[];
  incomplete: boolean;
  fingerprint: string;
}

export function extractChangeContext(filePath: string, original: string, modified: string, comparisonAvailable = true): ExtractedChangeContext {
  const fingerprint = createHash('sha256').update(JSON.stringify([filePath, original, modified, comparisonAvailable])).digest('hex');
  if (!comparisonAvailable) return { blocks: [], incomplete: true, fingerprint };
  const lines = (text: string) => text === '' ? [] : text.split(/\r?\n/).slice(0, /\n$/.test(text) ? -1 : undefined);
  const before = lines(original);
  const after = lines(modified);
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const diff = createUnifiedDiff(before.slice(start, oldEnd).join('\n') + (oldEnd > start ? '\n' : ''),
    after.slice(start, newEnd).join('\n') + (newEnd > start ? '\n' : ''), 0);
  const changed = { before: [] as LineRange[], after: [] as LineRange[] };
  if (diff === undefined) {
    changed.before.push({ startLine: start, endLine: oldEnd - 1 });
    changed.after.push({ startLine: start, endLine: newEnd - 1 });
  } else {
    for (const match of diff.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/gm)) {
      const range = (line: string, count: string) => {
        const first = start + Number(line) - (Number(count) ? 1 : 0);
        return { startLine: first, endLine: first + Number(count) - 1 };
      };
      changed.before.push(range(match[1], match[2]));
      changed.after.push(range(match[3], match[4]));
    }
  }
  return {
    blocks: [
      ...snapshotBlocks(filePath, modified, after, 'after', changed.after),
      ...snapshotBlocks(filePath, original, before, 'before', changed.before),
    ],
    incomplete: diff === undefined || (!diff && original !== modified),
    fingerprint,
  };
}

function snapshotBlocks(filePath: string, text: string, lines: string[], side: ReviewSide, changes: LineRange[]): ReviewBlock[] {
  if (!changes.length || !lines.length) return [];
  const python = /\.pyi?$/i.test(filePath);
  const parsed = parseScriptSymbols(filePath, text);
  const functions = parsed?.functions.filter((fn) => fn.kind !== 'class') ?? listFunctionRanges(text, python ? 'python' : 'c-like')
    .filter((fn) => fn.kind !== 'class')
    .map((fn) => {
      let startLine = fn.startLine;
      const indent = /^\s*/.exec(lines[startLine])?.[0];
      while (python && startLine > 0 && lines[startLine - 1].trimStart().startsWith('@') &&
        /^\s*/.exec(lines[startLine - 1])?.[0] === indent) startLine--;
      return { ...fn, startLine };
    });
  const selected = new Set<LineRange>();
  for (const change of changes) {
    if (change.endLine < change.startLine) {
      const fn = innermost(functions, change.startLine);
      if (fn && fn.startLine < change.startLine) selected.add(fn);
    }
    for (let line = change.startLine; line <= change.endLine; line++) {
      const fn = innermost(functions, line);
      if (fn) selected.add(fn);
    }
  }
  const block = ({ startLine, endLine }: LineRange, kind: ReviewBlock['kind']): ReviewBlock => ({
    filePath, side, kind, startLine: startLine + 1, code: lines.slice(startLine, endLine + 1).join('\n'),
    changed: kind === 'function' ? changes.flatMap((change) => {
      const first = Math.max(startLine, change.startLine) + 1;
      const last = Math.min(endLine, change.endLine) + 1;
      return first > last ? [] : [first === last ? String(first) : `${first}-${last}`];
    }).join(', ') : undefined,
  });
  const full = [...selected].sort((a, b) => a.startLine - b.startLine)
    .filter((fn, index, all) => !all.some((outer, i) => i !== index && outer.startLine <= fn.startLine &&
      outer.endLine >= fn.endLine && (outer.startLine < fn.startLine || outer.endLine > fn.endLine || i < index)));
  const blocks = full.map((fn) => block(fn, 'function'));
  for (const change of changes) {
    for (let line = change.startLine; line <= change.endLine;) {
      const covered = full.find((fn) => fn.startLine <= line && fn.endLine >= line);
      if (covered) {
        line = covered.endLine + 1;
        continue;
      }
      const next = full.find((fn) => fn.startLine > line);
      const end = Math.min(change.endLine, (next?.startLine ?? Infinity) - 1);
      // Independent blocks let later changes survive an oversized excerpt.
      const endLine = Math.min(end, line + 39);
      blocks.push(block({ startLine: line, endLine }, 'change'));
      line = endLine + 1;
    }
  }
  const code = blocks.map((b) => b.code).join('\n');
  const names = new Set(code.match(/[\p{ID_Start}$_][\p{ID_Continue}$]*/gu));
  const definitions = parsed?.definitions.filter(({ name }) => names.has(name))
    .map(({ range }) => block(range, 'definition')) ??
    referencedModuleDefinitions(text, code, python ? 'python' : 'c-like').map(({ line, text }) => ({
      filePath, side, kind: 'definition' as const, startLine: line, code: text,
    }));
  return [...blocks, ...definitions.filter((definition) => !blocks.some((b) => b.startLine <= definition.startLine &&
    b.startLine + b.code.split('\n').length >= definition.startLine + definition.code.split('\n').length))];
}

