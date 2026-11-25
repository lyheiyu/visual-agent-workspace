import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractChangeContext } from '../reviewer/changeContext';
import { reviewChangePrompt } from '../reviewer/prompts';
import { formatReviewOutput } from '../reviewer/reviewOutput';

test('extracts complete changed methods and referenced multiline definitions from both snapshots', () => {
  const before = [
    'const settings = {', '  minimum: 1,', '};',
    'class A {', '  run() { return 0; }', '}',
    'class B {', '  run(', '    value: number,', '  ): { valid: boolean } {',
    '    return { valid: value >= settings.minimum };', '  }', '}',
    'function later() { return false; }', '',
  ].join('\r\n');
  const after = before.replace('value >=', 'value >').replace('return false', 'return true');
  const result = extractChangeContext('check.ts', before, after);
  assert.deepEqual(result, extractChangeContext('check.ts', before, after));
  const modified = result.blocks.filter((block) => block.side === 'after');
  const functions = modified.filter((block) => block.kind === 'function');
  assert.deepEqual(functions.map((block) => [block.startLine, block.changed]), [[8, '11'], [14, '14']]);
  assert.equal(functions[0].code, '  run(\n    value: number,\n  ): { valid: boolean } {\n    return { valid: value > settings.minimum };\n  }');
  assert.equal(modified.find((block) => block.kind === 'definition')?.code, 'const settings = {\n  minimum: 1,\n};');
  assert.notEqual(result.fingerprint, extractChangeContext('check.ts', before, after + '\r\n').fingerprint);
});

test('keeps surrounding function code on both sides of a deletion and supports added and deleted files', () => {
  const original = 'LIMIT = 3\ndef check(value):\n    assert value <= LIMIT\n    return value\n';
  const modified = original.replace('    assert value <= LIMIT\n', '');
  const context = extractChangeContext('check.py', original, modified);
  assert.deepEqual(context.blocks.filter((block) => block.kind === 'function').map((block) => [block.side, block.startLine, block.changed]),
    [['after', 2, ''], ['before', 2, '3']]);
  assert.ok(context.blocks.some((block) => block.kind === 'definition' && block.code === 'LIMIT = 3'));
  assert.ok(extractChangeContext('check.py', '', original).blocks.every((block) => block.side === 'after'));
  assert.ok(extractChangeContext('check.py', original, '').blocks.every((block) => block.side === 'before'));
});

test('does not treat an unreconstructed patch as source evidence', () => {
  const original = 'function f() { return true; }';
  const rawPatch = '@@ -1 +1 @@\n-unmatched\n+replacement';
  const filePath = 'a.ts';
  const context = extractChangeContext(filePath, original, rawPatch, false);
  assert.deepEqual(context.blocks, []);
  assert.notEqual(context.fingerprint, extractChangeContext(filePath, original, rawPatch).fingerprint);
  const output = reviewChangePrompt({ filePath, ...context }, 5000).reviewOutput!;
  assert.deepEqual(output.evidence, { before: {}, after: {} });
  assert.match(formatReviewOutput('[]', output, 'en').text, /Insufficient context/);
});

test('retains operation references and permits citations only from redacted context included in the prompt', () => {
  const before = 'function f() {\n  return true;\n}\n';
  const after = `function f() {\n  const password = "hidden-value";\n  // ${'padding'.repeat(100)}\n  return false;\n}\n`;
  const input = { filePath: 'a.ts', operationRef: 'operation #7 (completed)', ...extractChangeContext('a.ts', before, after) };
  const complete = reviewChangePrompt(input, 5000);
  assert.match(complete.messages[1].content, /operation #7 \(completed\)/);
  assert.doesNotMatch(complete.context, /hidden-value/);
  assert.match(complete.reviewOutput!.evidence.after[2], /REDACTED/);
  const small = reviewChangePrompt(input, 115);
  assert.equal(small.truncated, true);
  assert.deepEqual(small.reviewOutput!.evidence.after, {});
  assert.match(small.context, /before function/);
  assert.match(formatReviewOutput('[]', small.reviewOutput!, 'en').text, /Insufficient context/);
});

test('validates evidence, removes duplicate findings and distinguishes certainty levels', () => {
  const context = { filePath: 'a.ts', evidence: { before: { 5: 'return true;' }, after: { 5: 'return false;' } }, incomplete: false, fingerprint: 'test' };
  const finding = { status: 'confirmed', side: 'after', line: 5, quote: 'return false;', message: 'The function now always rejects input.' };
  const raw = JSON.stringify([
    finding, { ...finding, message: finding.message.toUpperCase() },
    { ...finding, status: 'risk', message: 'Callers may fail if they require a true result.' },
    { ...finding, status: 'insufficient', message: 'Caller expectations are unavailable.' },
    { ...finding, side: 'before', message: 'Fabricated evidence.' },
    { ...finding, line: 99, message: 'Missing line.' },
  ]);
  const output = formatReviewOutput(`\`\`\`json\n${raw}\n\`\`\``, context, 'en');
  assert.equal(output.cacheable, false);
  assert.equal(output.text.match(/Confirmed issue/g)?.length, 1);
  assert.match(output.text, /a\.ts:5.*return false;/);
  assert.match(output.text, /Potential risk/);
  assert.match(output.text, /Insufficient context/);
  assert.doesNotMatch(output.text, /Fabricated evidence|Missing line/);
  assert.deepEqual(formatReviewOutput('[]', context, 'en'), { text: 'No issues found.', cacheable: true });
  assert.doesNotMatch(formatReviewOutput('bad JSON', context, 'en').text, /No issues found/);
});
