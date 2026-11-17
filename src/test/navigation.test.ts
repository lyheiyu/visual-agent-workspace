import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveWorkspacePath } from '../navigation/pathSafety';
import { findFunctionRange, replaceFunction } from '../navigation/symbolSearch';
import { PROPOSED_VALIDATE_SAMPLES } from '../adapters/demoScenario';

const demoRoot = path.resolve(__dirname, '..', '..', 'demo-workspace');

test('path safety: accepts workspace-relative paths', () => {
  const r = resolveWorkspacePath(path.posix.resolve('/ws'), 'src/a.py', { pathModule: path.posix });
  assert.ok(r.ok);
  assert.equal(r.ok && r.absolutePath, '/ws/src/a.py');
  assert.equal(r.ok && r.relativePath, 'src/a.py');
});

test('path safety: refuses traversal and outside absolute paths by default', () => {
  const p = path.posix;
  assert.equal(resolveWorkspacePath('/ws', '../etc/passwd', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath('/ws', '/etc/passwd', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath('/ws', 'a/../../x', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath('/ws', '/ws-other/x', { pathModule: p }).ok, false, 'prefix sibling');
  assert.equal(resolveWorkspacePath('/ws', 'https://evil/x', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath('/ws', 'a\0b', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath(undefined, 'a.py', { pathModule: p }).ok, false);
  assert.equal(resolveWorkspacePath('/ws', '/etc/hosts', { pathModule: p, allowOutsideWorkspace: true }).ok, true);
});

test('path safety: Windows paths are compared case-insensitively', () => {
  const w = path.win32;
  const r = resolveWorkspacePath('C:\\Work\\Proj', 'c:\\work\\proj\\a.py', { pathModule: w });
  assert.ok(r.ok && r.insideWorkspace);
  assert.equal(resolveWorkspacePath('C:\\Work\\Proj', 'D:\\other\\a.py', { pathModule: w }).ok, false);
});

test('finds python functions in the demo fixture', () => {
  const importer = fs.readFileSync(path.join(demoRoot, 'importer.py'), 'utf8');
  const validation = fs.readFileSync(path.join(demoRoot, 'validation.py'), 'utf8');
  assert.deepEqual(findFunctionRange(importer, 'load_data', 'python'), { startLine: 8, endLine: 15 });
  assert.deepEqual(findFunctionRange(validation, 'validate_samples', 'python'), { startLine: 9, endLine: 16 });
  assert.equal(findFunctionRange(validation, 'does_not_exist', 'python'), undefined);
  assert.equal(findFunctionRange(validation, 'bad name(', 'python'), undefined);
});

test('python: decorators, nested methods, multi-line signatures', () => {
  const src = [
    'class A:',
    '    @staticmethod',
    '    def f(',
    '        x,',
    '    ):',
    '        return x',
    '',
    '    def g(self):',
    '        pass',
  ].join('\n');
  assert.deepEqual(findFunctionRange(src, 'f', 'python'), { startLine: 1, endLine: 5 });
  assert.deepEqual(findFunctionRange(src, 'A', 'python'), { startLine: 0, endLine: 8 });
});

test('c-like: functions, arrow functions and methods', () => {
  const src = [
    'export function load(a: string) {',
    '  if (a) { return "}"; }',
    '}',
    'const go = async (x) => {',
    '  return x;',
    '};',
    'class K {',
    '  public async run(): Promise<void> {',
    '    // }',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(findFunctionRange(src, 'load'), { startLine: 0, endLine: 2 });
  assert.deepEqual(findFunctionRange(src, 'go'), { startLine: 3, endLine: 5 });
  assert.deepEqual(findFunctionRange(src, 'run'), { startLine: 7, endLine: 9 });
});

test('replaceFunction only changes the target function and keeps EOL style', () => {
  const original = fs.readFileSync(path.join(demoRoot, 'validation.py'), 'utf8');
  for (const text of [original.replace(/\r\n/g, '\n'), original.replace(/\r?\n/g, '\r\n')]) {
    const result = replaceFunction(text, 'validate_samples', PROPOSED_VALIDATE_SAMPLES, 'python')!;
    assert.ok(result);
    assert.match(result.text, /concentration must be >= 0/);
    assert.match(result.text, /def summarize\(samples\):/, 'other functions untouched');
    assert.match(result.text, /^"""Validation helpers/);
    assert.equal(text.includes('\r\n'), result.text.includes('\r\n'));
    assert.equal((result.text.match(/def validate_samples/g) ?? []).length, 1);
  }
});
