import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { explainErrorPrompt, explainFunctionPrompt, numbered, reviewChangePrompt } from '../reviewer/prompts';
import { extractErrorLocations, findCallees, findCallSites, SourceFile } from '../analysis/staticAnalysis';
import { buildReviewContextMarkdown } from '../export/reviewContext';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { createUnifiedDiff, applyUnifiedDiff } from '../review/unifiedDiff';
import { listFunctionRanges } from '../navigation/symbolSearch';

const ROOT = path.resolve(__dirname, '..', '..', 'demo-workspace');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const files: SourceFile[] = ['importer.py', 'validation.py', 'tests/test_validation.py'].map((f) => ({ filePath: f, text: read(f), language: 'python' }));

test('prompt: numbered lines match the file, secrets redacted, budget respected by priority', () => {
  const v = read('validation.py');
  const fn = listFunctionRanges(v, 'python').find((f) => f.name === 'validate_samples')!;
  const code = v.split(/\r?\n/).slice(fn.startLine, fn.endLine + 1).join('\n');
  const p = explainFunctionPrompt({ fn: { filePath: 'validation.py', startLine: fn.startLine + 1, code, name: 'validate_samples' }, language: 'python' }, 10_000);
  assert.match(p.messages[1].content, /10 \| def validate_samples\(samples\):/);
  assert.match(p.messages[1].content, /17 \|     return validated/);
  assert.equal(p.truncated, false);
  assert.match(p.messages[0].content, /cannot run code/);

  const secret = explainFunctionPrompt({ fn: { filePath: 'a.py', startLine: 1, code: 'API_KEY = "sk-abcdefghijklmnopqrstuv"\npassword = hunter2', name: 'x' }, language: 'python' }, 10_000);
  assert.doesNotMatch(secret.messages[1].content, /sk-abcdefghijklmnopqrstuv|hunter2/);

  const big = reviewChangePrompt(
    { filePath: 'a.py', diff: '@@ -1 +1 @@\n-a\n+b\n', original: { filePath: 'a.py', startLine: 1, code: 'x\n'.repeat(5000) }, modified: { filePath: 'a.py', startLine: 1, code: 'y\n' } },
    2000,
  );
  assert.equal(big.truncated, true);
  assert.match(big.context, /```diff/, 'highest-priority section (diff) kept');
  assert.match(big.context, /Modified code/);
  assert.doesNotMatch(big.context, /Original code/, 'lowest-priority section dropped first');
});

test('error prompt keeps the tail of long output', () => {
  const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const p = explainErrorPrompt({ command: 'pytest', exitCode: 1, output, related: [] }, 50_000);
  assert.match(p.context, /line 499/);
  assert.doesNotMatch(p.context, /line 10\n/);
  assert.match(p.context, /earlier lines omitted/);
  assert.equal(numbered({ filePath: 'f', startLine: 9, code: 'a\nb' }), ' 9 | a\n10 | b');
});

test('static analysis: call sites and callees in the demo workspace', () => {
  const callers = findCallSites('validate_samples', files);
  assert.deepEqual(
    callers.map((c) => `${c.filePath}:${c.line}:${c.callerFunction ?? '-'}`),
    ['importer.py:16:load_data', 'tests/test_validation.py:7:test_valid_samples_pass', 'tests/test_validation.py:14:test_missing_sample_id_rejected', 'tests/test_validation.py:19:test_missing_concentration_rejected', 'tests/test_validation.py:24:test_negative_concentration_rejected', 'tests/test_validation.py:29:test_non_numeric_concentration_rejected'],
  );
  assert.ok(!callers.some((c) => c.filePath === 'validation.py'), 'the definition is not a call site');
  const loadData = read('importer.py').split(/\r?\n/).slice(8, 16).join('\n');
  assert.deepEqual(findCallees(loadData, files, 'load_data').map((c) => c.name), ['validate_samples']);
  assert.deepEqual(findCallSites('bad name(', files), []);
});

test('error locations: Python traceback, pytest and tsc formats; outside paths ignored', () => {
  const out = [
    `  File "${path.join(ROOT, 'validation.py')}", line 15, in validate_samples`,
    'tests/test_validation.py:19: Failed: DID NOT RAISE',
    'src/app.ts(12,5): error TS2322',
    '  File "/usr/lib/python3/site-packages/x.py", line 3',
  ].join('\n');
  assert.deepEqual(
    extractErrorLocations(out, ROOT).map((l) => `${l.filePath}:${l.line}`),
    ['validation.py:15', 'tests/test_validation.py:19', 'src/app.ts:12'],
  );
});

test('derived diff round-trips (used for changes not recorded as a diff)', () => {
  const a = read('validation.py');
  const b = a.replace('missing sample_id', 'sample_id is required').replace('def summarize', '# note\ndef summarize');
  const d = createUnifiedDiff(a, b)!;
  assert.equal(applyUnifiedDiff(a, d)!.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'));
  assert.equal(createUnifiedDiff(a, a), '');
});

test('export: exact source code, labelled evidence, simulated marked, secrets redacted', async () => {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => ROOT });
  const taskId = controller.start('demo');
  await new Promise<void>((resolve) => {
    const sub = controller.onDidChangeState((s) => {
      if (s.awaitingApprovalFor) {
        sub.dispose();
        controller.approve(s.awaitingApprovalFor);
        resolve();
      }
    });
  });
  await controller.whenIdle();
  const ops = recorder.getOperations(taskId);
  const v = read('validation.py');
  const fn = listFunctionRanges(v, 'python').find((f) => f.name === 'validate_samples')!;
  const code = v.split(/\r?\n/).slice(fn.startLine, fn.endLine + 1).join('\n');
  const md = buildReviewContextMarkdown({
    scope: 'task',
    title: 'demo',
    generatedAt: '2026-01-01T00:00:00.000Z',
    task: recorder.getTask(taskId),
    operations: ops,
    changes: [],
    fn: { name: 'validate_samples', code: { filePath: 'validation.py', startLine: fn.startLine + 1, code: code + '\n# token=abcdef123456' }, nameSource: 'parser' },
  });
  assert.ok(md.includes('```python\n' + code), 'function source is exported verbatim');
  assert.match(md, /`validation.py` lines 10–18/);
  assert.match(md, /\[inferred: text parser\]/);
  assert.match(md, /\*\*SIMULATED\*\* \[mock demo: not executed\]/);
  assert.match(md, /python -m pytest tests\/test_validation\.py -v/);
  assert.match(md, /5 passed/);
  assert.match(md, /\| 5 \| Edit \| Completed \| simulated \|/);
  assert.doesNotMatch(md, /abcdef123456/);
  assert.match(md, /Contains no model-generated text/);
});

test('module-level definitions referenced by a function are included (avoids false "undefined" findings)', async () => {
  const { referencedModuleDefinitions } = await import('../analysis/staticAnalysis');
  const { PROPOSED_VALIDATE_SAMPLES } = await import('../adapters/demoScenario');
  const defs = referencedModuleDefinitions(read('validation.py'), PROPOSED_VALIDATE_SAMPLES, 'python');
  assert.deepEqual(defs, [{ line: 3, text: 'REQUIRED_FIELDS = ("sample_id", "concentration")' }]);
  const p = reviewChangePrompt({ filePath: 'validation.py', diff: '@@ -1 +1 @@\n-a\n+b\n', moduleDefs: defs }, 10_000);
  assert.match(p.context, /3 \| REQUIRED_FIELDS = /);
  assert.deepEqual(referencedModuleDefinitions(read('validation.py'), 'def f():\n    return 1', 'python'), []);
});
