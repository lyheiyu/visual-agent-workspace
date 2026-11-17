import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CodexItemMapper, unwrapShellCommand } from '../adapters/codex/CodexItemMapper';
import { applyUnifiedDiff, diffStats, parseHunks } from '../review/unifiedDiff';
import { findEnclosingFunction } from '../navigation/symbolSearch';
import { commandItem } from './support/fakeCodex';

const ROOT = path.resolve(__dirname, '..', '..', 'demo-workspace');
const validation = fs.readFileSync(path.join(ROOT, 'validation.py'), 'utf8');

test('unwraps the shell wrappers Codex uses, keeping inner command', () => {
  assert.equal(
    unwrapShellCommand(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg --files -g validation.py'`),
    'rg --files -g validation.py',
  );
  assert.equal(unwrapShellCommand(`/bin/bash -lc 'python -m pytest -q'`), 'python -m pytest -q');
  assert.equal(unwrapShellCommand(`powershell.exe -Command 'echo ''hi'''`), "echo 'hi'");
  assert.equal(unwrapShellCommand('git status'), 'git status');
});

test('classifies Codex commands into Read / Test / Execute', () => {
  const m = new CodexItemMapper(ROOT);
  const read = m.announce(commandItem(ROOT) as any)!;
  assert.equal(read.operationType, 'Read');
  assert.equal(read.filePath, 'validation.py');
  assert.match(read.command!.command, /powershell\.exe/, 'exact command preserved');

  const search = m.announce(commandItem(ROOT, { commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: null }] }) as any)!;
  assert.equal(search.operationType, 'Read');
  assert.equal(search.description, 'Search for "foo"');

  const t = m.announce(commandItem(ROOT, { command: `/bin/bash -lc 'python -m pytest tests -q'`, commandActions: [{ type: 'unknown', command: 'python -m pytest tests -q' }] }) as any)!;
  assert.equal(t.operationType, 'Test');

  const ex = m.announce(commandItem(ROOT, { command: 'git status', commandActions: [{ type: 'unknown', command: 'git status' }] }) as any)!;
  assert.equal(ex.operationType, 'Execute');
  assert.equal(ex.description, 'Run: git status');
});

test('maps completion states, including declined and failing commands', () => {
  const m = new CodexItemMapper(ROOT);
  assert.equal(m.completion(commandItem(ROOT, { status: 'declined' }) as any).outcome, 'Rejected');
  assert.equal(m.completion(commandItem(ROOT, { status: 'completed', exitCode: 0 }) as any).outcome, 'Completed');
  assert.equal(m.completion(commandItem(ROOT, { status: 'completed', exitCode: 2 }) as any).outcome, 'Failed');
  assert.equal(m.completion(commandItem(ROOT, { status: 'failed', exitCode: 1 }) as any).outcome, 'Failed');
  assert.equal(m.completion({ type: 'fileChange', id: 'p', changes: [], status: 'declined' } as any).outcome, 'Rejected');
});

test('paths outside the workspace stay absolute and are flagged', () => {
  const m = new CodexItemMapper(ROOT);
  const outside = path.resolve(ROOT, '..', 'package.json');
  assert.equal(m.displayPath(outside), outside);
  assert.equal(m.isInsideWorkspace(outside), false);
  assert.equal(m.isInsideWorkspace(path.join(ROOT, 'tests', 'x.py')), true);
  assert.equal(m.displayPath(path.join(ROOT, 'tests', 'x.py')), 'tests/x.py');
});

test('unified diff: the real Codex hunk applies to the fixture', () => {
  const diff = '@@ -26 +26,2 @@\n     }\n+# reviewed\n';
  const out = applyUnifiedDiff(validation, diff)!;
  assert.ok(out);
  const lines = out.split(/\r?\n/);
  assert.equal(lines[25], '    }');
  assert.equal(lines[26], '# reviewed');
  assert.deepEqual(diffStats(diff), { added: 1, removed: 0, hunks: 1, firstChangedOldLine: 27 });
});

test('unified diff: replacement, multiple hunks, fuzz, CRLF, mismatch', () => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n') + '\n';
  const diff = '@@ -2,2 +2,2 @@\n b\n-c\n+C\n@@ -5,2 +5,3 @@\n e\n+E2\n f\n';
  assert.equal(applyUnifiedDiff(original, diff), 'a\nb\nC\nd\ne\nE2\nf\n');
  // Hunk header off by two lines: still found by context.
  assert.equal(applyUnifiedDiff(original, '@@ -4,1 +4,1 @@\n-b\n+B\n'), 'a\nB\nc\nd\ne\nf\n');
  assert.equal(applyUnifiedDiff(original.replace(/\n/g, '\r\n'), '@@ -1 +1 @@\n-a\n+A\n'), 'A\r\nb\r\nc\r\nd\r\ne\r\nf\r\n');
  assert.equal(applyUnifiedDiff(original, '@@ -1 +1 @@\n-zzz\n+A\n'), undefined, 'never guesses');
  assert.equal(applyUnifiedDiff('', '@@ -0,0 +1,2 @@\n+x\n+y\n'), 'x\ny\n', 'new file');
  assert.equal(parseHunks('no hunks').length, 0);
});

test('enclosing function inference for edit labels', () => {
  assert.equal(findEnclosingFunction(validation, 12, 'python'), 'validate_samples');
  assert.equal(findEnclosingFunction(validation, 23, 'python'), 'summarize');
  assert.equal(findEnclosingFunction(validation, 2, 'python'), undefined, 'module level');
  const ts = 'class K {\n  run() {\n    go();\n  }\n}\nfunction other() {\n  return 1;\n}\n';
  assert.equal(findEnclosingFunction(ts, 2), 'run');
  assert.equal(findEnclosingFunction(ts, 6), 'other');
});
