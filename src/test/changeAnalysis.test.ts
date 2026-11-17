import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeFileChange, changedRanges } from '../analysis/changeAnalysis';
import { listFunctionRanges } from '../navigation/symbolSearch';
import { CodexItemMapper } from '../adapters/codex/CodexItemMapper';

const ROOT = path.resolve(__dirname, '..', '..', 'demo-workspace');
const validation = fs.readFileSync(path.join(ROOT, 'validation.py'), 'utf8');

test('lists Python functions, classes and methods with extents', () => {
  const fns = listFunctionRanges(validation, 'python').map((f) => `${f.kind}:${f.name}:${f.startLine + 1}-${f.endLine + 1}`);
  assert.deepEqual(fns, ['class:ValidationError:6-7', 'function:validate_samples:10-17', 'function:summarize:20-26']);
});

test('lists TypeScript functions, arrows, classes and methods', () => {
  const ts = [
    'export function load(a: string): number {', //1
    '  return 1;',
    '}',
    'const go = async (x: number) => {', //4
    '  return x;',
    '};',
    'export class Store {', //7
    '  private items: string[] = [];',
    '  async add(item: string): Promise<void> {', //9
    '    if (item) { this.items.push(item); }',
    '  }',
    '}',
  ].join('\n');
  const fns = listFunctionRanges(ts, 'c-like').map((f) => `${f.kind}:${f.name}:${f.startLine + 1}-${f.endLine + 1}`);
  assert.deepEqual(fns, ['function:load:1-3', 'function:go:4-6', 'class:Store:7-12', 'method:add:9-11']);
});

test('changed ranges: additions on the new side, pure removals on the old side', () => {
  const diff = '@@ -2,4 +2,4 @@\n a\n-b\n+B\n c\n-d\n e\n@@ -10,0 +10,2 @@\n+x\n+y\n';
  assert.deepEqual(
    changedRanges('f.py', diff).map((r) => `${r.side}:${r.startLine}-${r.endLine}`),
    ['new:3-3', 'old:5-5', 'new:10-11'],
  );
});

test('a change inside validate_samples() is attributed to it; module-level code gets no name', () => {
  const diff =
    '@@ -13,4 +13,6 @@\n' +
    '     for index, sample in enumerate(samples):\n' +
    '         if not sample.get("sample_id"):\n' +
    '             raise ValidationError(f"Row {index}: missing sample_id")\n' +
    '+        if sample.get("concentration") in (None, ""):\n' +
    '+            raise ValidationError(f"Row {index}: missing concentration")\n' +
    '         validated.append(sample)\n';
  const a = analyzeFileChange('validation.py', validation, diff);
  assert.deepEqual(a.ranges, [{ filePath: 'validation.py', side: 'new', startLine: 16, endLine: 17 }]);
  assert.deepEqual(a.functions.map((f) => [f.name, f.side, f.startLine, f.endLine, f.source]), [['validate_samples', 'new', 10, 19, 'parser']]);
  assert.match(a.newText!, /missing concentration/);

  // The real Codex hunk appended at module level: no function is claimed.
  const moduleLevel = analyzeFileChange('validation.py', validation, '@@ -26 +26,2 @@\n     }\n+# reviewed\n');
  assert.deepEqual(moduleLevel.functions, []);
  assert.deepEqual(moduleLevel.ranges, [{ filePath: 'validation.py', side: 'new', startLine: 27, endLine: 27 }]);
});

test('a change spanning two functions reports both; deleted function is located in the original', () => {
  const twoFns =
    '@@ -11 +11 @@\n-    """Return the list of samples, raising ValidationError for invalid records."""\n+    """Validate samples."""\n' +
    '@@ -21 +21 @@\n-    """Return a small summary dictionary for a list of validated samples."""\n+    """Summarize."""\n';
  const a = analyzeFileChange('validation.py', validation, twoFns);
  assert.deepEqual(a.functions.map((f) => f.name).sort(), ['summarize', 'validate_samples']);

  const lines = validation.split(/\r?\n/);
  const removeSummarize = `@@ -19,8 +19,0 @@\n${lines.slice(18, 26).map((l) => '-' + l).join('\n')}\n`;
  const d = analyzeFileChange('validation.py', validation, removeSummarize);
  assert.deepEqual(d.functions.map((f) => [f.name, f.side]), [['summarize', 'old']]);
  assert.equal(d.ranges[0].side, 'old');
});

test('unknown original file: ranges are still reported, functions are not guessed', () => {
  const a = analyzeFileChange('missing.py', undefined, '@@ -1 +1 @@\n-x = 1\n+x = 2\n');
  assert.equal(a.ranges.length, 1);
  assert.deepEqual(a.functions, []);
});

test('Codex mapper attaches ranges and functions to edit operations', () => {
  const m = new CodexItemMapper(ROOT, (p) => fs.readFileSync(p, 'utf8'));
  const op = m.announce({
    type: 'fileChange',
    id: 'p1',
    status: 'inProgress',
    changes: [
      {
        path: path.join(ROOT, 'validation.py'),
        kind: { type: 'update', move_path: null },
        diff: '@@ -15,1 +15,1 @@\n-            raise ValidationError(f"Row {index}: missing sample_id")\n+            raise ValidationError(f"Row {index}: sample_id is required")\n',
      },
    ],
  } as any)!;
  assert.equal(op.functionName, 'validate_samples');
  assert.equal(op.description, 'Edit validation.py › validate_samples() (+1 −1)');
  assert.deepEqual(op.changedRanges, [{ filePath: 'validation.py', side: 'new', startLine: 15, endLine: 15 }]);
  assert.equal(op.affectedFunctions?.[0].source, 'parser');
});
