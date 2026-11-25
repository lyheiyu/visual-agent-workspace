import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextBudget, crossFileHints, diffHunks, estimateTokens, explainDiff, FileHunks, planBatches } from '../reviewer/diffBatches';
import type { ChatMessage, ChatResult } from '../reviewer/OllamaClient';
import { OllamaError } from '../reviewer/OllamaClient';
import { ReviewService } from '../reviewer/ReviewService';
import { FakeOllama } from './support/fakeOllama';

// ---------------------------------------------------------------- fixtures

/** A Python module with `n` small functions. */
function module(n: number, tweak: (i: number, body: string) => string = (_, b) => b): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`def step_${i}(value):`, tweak(i, `    total = value + ${i}`), '    return total', '');
  }
  return out.join('\n');
}

/** Answers like a well-behaved model: one verifiable "change" item per file shown, quoting its first added line. */
function answer(user: string): string {
  const items: unknown[] = [];
  const blocks = user.split(/^File (\d+): /m).slice(1);
  for (let i = 0; i < blocks.length; i += 2) {
    const file = Number(blocks[i]);
    const add = /^\+\s+(\d+) \| (.*)$/m.exec(blocks[i + 1]);
    const del = /^-\s+(\d+)\s+\| (.*)$/m.exec(blocks[i + 1]);
    const m = add ?? del;
    if (m) items.push({ file, status: 'change', side: add ? 'after' : 'before', line: Number(m[1]), quote: m[2].trim(), message: `changed line ${m[1]}` });
  }
  return JSON.stringify(items);
}

type Sent = { messages: ChatMessage[]; label: string };
function fakeCall(opts: { fail?: (sent: Sent, n: number) => Error | undefined; synthesis?: string } = {}) {
  const sent: Sent[] = [];
  let active = 0;
  let maxActive = 0;
  const call = async (messages: ChatMessage[], label: string): Promise<ChatResult> => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const s = { messages, label };
      sent.push(s);
      await new Promise((r) => setTimeout(r, 1));
      const err = opts.fail?.(s, sent.length);
      if (err) throw err;
      const synth = /combine verified findings/.test(messages[0].content);
      return { content: synth ? (opts.synthesis ?? '## Overall\nThe change adjusts constants.\n## Cross-file relationships\nNone identified') : answer(messages[1].content), thinking: '', promptTokens: estimateTokens(messages.map((m) => m.content).join('\n')) };
    } finally {
      active--;
    }
  };
  return { call, sent, maxActive: () => maxActive };
}

const budget = (window: number, maxChars = 200_000) => contextBudget({ setting: window, thinking: 'off', maxChars });

/** Every changed line of every file appears in exactly the set of lines sent. */
function changedLinesSent(files: FileHunks[], sent: Sent[]): boolean {
  const text = sent.map((s) => s.messages[1].content).join('\n');
  return files.every((f) => f.hunks.every((h) => h.lines.filter((l) => l.tag !== ' ').every((l) => text.includes(`| ${l.text}`))));
}

// ---------------------------------------------------------------- tests

test('small diff in two files: ONE request, hunks only (not four complete files), overall summary, all files explained', async () => {
  const a0 = module(60);
  const b0 = module(60).replace(/step_/g, 'load_');
  const files = [
    diffHunks('a.py', a0, a0.replace('    total = value + 7', '    total = value + 70')),
    diffHunks('b.py', b0, b0.replace('    total = value + 30', '    total = value * 30')),
  ];
  const f = fakeCall();
  const call = async (m: ChatMessage[], l: string) => {
    const r = await f.call(m, l);
    const items = JSON.parse(r.content);
    return { ...r, content: JSON.stringify([{ status: 'summary', message: 'Two constants change in a.py and b.py.' }, ...items]) };
  };
  const out = await explainDiff({ files, header: 'operation #3 (Completed)', budget: budget(8192), language: 'en', call });
  assert.equal(f.sent.length, 1, 'one model request');
  assert.equal(out.requests, 1);
  const user = f.sent[0].messages[1].content;
  assert.ok(user.length < (a0.length + b0.length) / 4, `diff input (${user.length} chars) is far smaller than the two files (${a0.length + b0.length} chars), let alone four versions`);
  assert.doesNotMatch(user, /step_40/, 'unchanged functions are not sent');
  assert.match(user, /^- 30 +\| {5}total = value \+ 7$/m, 'removed line with its before line number');
  assert.match(user, /^\+ +30 \| {5}total = value \+ 70$/m, 'added line with its after line number');
  assert.match(user, /def step_7\(value\):/, 'the enclosing function is visible');
  assert.doesNotMatch(user, /value \+ 6$|value \+ 8$/m, 'no neighbouring function bodies');
  assert.match(out.text, /^\*\*Overall\*\* — Two constants change/m);
  assert.match(out.text, /a\.py:30 \(after\)/);
  assert.match(out.text, /b\.py:\d+ \(after\)/);
  assert.equal(out.incomplete, false);
  assert.equal(out.cacheable, true);
});

test('large single-file diff: automatically sized batches, each within the budget, every changed line sent, one synthesis', async () => {
  const before = module(400);
  const after = module(400, (i, b) => (i % 4 === 0 ? b.replace(`+ ${i}`, `- ${i}`) : b));
  const files = [diffHunks('big.py', before, after)];
  assert.ok(files[0].hunks.length >= 50);
  const b = budget(4096);
  const f = fakeCall();
  const out = await explainDiff({ files, header: 'operation #9', budget: b, language: 'en', call: f.call });
  const batches = f.sent.filter((s) => /^Analysing batch/.test(s.label));
  assert.ok(batches.length > 1, `split into ${batches.length} batches`);
  for (const s of batches) assert.ok(estimateTokens(s.messages[1].content) <= b.input, 'each batch fits the input budget');
  assert.equal(f.sent.at(-1)!.label.startsWith('Combining'), true, 'final synthesis');
  assert.equal(f.sent.length, batches.length + 1);
  assert.ok(changedLinesSent(files, f.sent), 'every changed line was sent');
  assert.equal(f.maxActive(), 1, 'never more than one request at a time');
  assert.match(out.text, /big\.py: all \d+ hunks analysed/);
  assert.equal(out.incomplete, false);
  assert.match(out.text, /## Overall explanation[\s\S]*The change adjusts constants/);
  // Batch labels are numbered against the total.
  assert.deepEqual(batches.map((s) => s.label), batches.map((_, i) => `Analysing batch ${i + 1} of ${batches.length}`));
});

test('one hunk larger than a request is split into parts, never truncated', async () => {
  const before = Array.from({ length: 900 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 900 }, (_, i) => `line_${i} = ${i * 2}`).join('\n') + '\n';
  const files = [diffHunks('table.py', before, after)];
  assert.equal(files[0].hunks.length, 1);
  const f = fakeCall();
  const out = await explainDiff({ files, header: 'op', budget: budget(4096), language: 'en', call: f.call });
  assert.ok(f.sent.some((s) => /hunk 1 \(part 2 of \d+\)/.test(s.messages[1].content)));
  assert.ok(changedLinesSent(files, f.sent));
  assert.equal(out.incomplete, false);
});

test('multi-file: files are kept together in a batch when they fit, and every file is covered', () => {
  const files = ['a.py', 'b.py', 'c.py', 'd.py'].map((p, k) => {
    const s = module(40);
    return diffHunks(p, s, module(40, (i, b) => (i % 5 === k ? b + '  # tweak' : b)));
  });
  const b = budget(4096);
  const batches = planBatches(files, b.input);
  for (const [fi, f] of files.entries()) {
    const inBatches = batches.filter((x) => x.units.some((u) => u.file === fi)).length;
    const fits = estimateTokens(f.hunks.map((h) => JSON.stringify(h.lines)).join('')) < b.input / 3;
    if (fits) assert.equal(inBatches, 1, `${f.filePath} is not split across batches`);
  }
  const units = batches.flatMap((x) => x.units);
  assert.equal(units.length, files.reduce((a, f) => a + f.hunks.length, 0), 'every hunk is planned exactly once');
});

test('cross-file dependency: a function changed in one file and used in another is passed on as a hint and to the synthesis', async () => {
  const lib0 = 'def parse_row(row):\n    return row.split(",")\n';
  const lib1 = 'def parse_row(row, sep=","):\n    return row.split(sep)\n';
  const use0 = 'from lib import parse_row\n\ndef load(lines):\n    return [parse_row(l) for l in lines]\n';
  const use1 = 'from lib import parse_row\n\ndef load(lines):\n    return [parse_row(l, ";") for l in lines]\n';
  const files = [diffHunks('lib.py', lib0, lib1), diffHunks('importer.py', use0, use1)];
  assert.deepEqual(crossFileHints(files), ['`parse_row` changed in lib.py:1; appears in importer.py:1']);
  // Small: one request carries the hint.
  const one = fakeCall();
  await explainDiff({ files, header: 'op', budget: budget(8192), language: 'en', call: one.call });
  assert.equal(one.sent.length, 1);
  assert.match(one.sent[0].messages[1].content, /Static hints[\s\S]*parse_row/);
  assert.match(one.sent[0].messages[0].content, /how the files relate to each other/);
  // Forced into batches: the synthesis gets the hint and both files' findings.
  const many = fakeCall({ synthesis: '## Overall\nparse_row gained a separator.\n## Cross-file relationships\nimporter.py:4 now passes ";" to parse_row (lib.py:1).' });
  const out = await explainDiff({ files, header: 'op', budget: { ...budget(8192), input: 150 }, language: 'en', call: many.call });
  const synth = many.sent.at(-1)!.messages[1].content;
  assert.match(synth, /File 1: lib\.py[\s\S]*File 2: importer\.py/);
  assert.match(synth, /parse_row` changed in lib\.py:1; appears in importer\.py:1/);
  assert.match(out.text, /### Cross-file relationships\nimporter\.py:4 now passes/);
});

test('cancellation stops after the running batch: no further requests, the abort propagates', async () => {
  const before = module(300);
  const files = [diffHunks('big.py', before, module(300, (i, b) => (i % 3 === 0 ? b + ' # x' : b)))];
  const f = fakeCall({ fail: (_, n) => (n === 2 ? new OllamaError('aborted', 'The local AI request was cancelled.') : undefined) });
  await assert.rejects(explainDiff({ files, header: 'op', budget: budget(4096), language: 'en', call: f.call }), /cancelled/);
  assert.equal(f.sent.length, 2, 'nothing is sent after the cancelled request');
});

test('a failed batch is reported, the result is marked incomplete and not cached; the other batches still count', async () => {
  const before = module(300);
  const files = [diffHunks('big.py', before, module(300, (i, b) => (i % 3 === 0 ? b + ' # x' : b)))];
  const f = fakeCall({ fail: (s, n) => (n === 2 ? new OllamaError('http', 'Ollama returned 500: out of memory') : undefined) });
  const out = await explainDiff({ files, header: 'op', budget: budget(4096), language: 'en', call: f.call });
  assert.equal(out.incomplete, true);
  assert.equal(out.cacheable, false);
  assert.match(out.text, /⚠ \*\*Insufficient context — incomplete analysis\.\*\* \d+ of \d+ hunks could not be analysed/);
  assert.match(out.text, /not analysed: hunk \d+ \(before [\d–]+, after [\d–]+\) — Ollama returned 500: out of memory/);
  assert.match(out.text, /This is not a complete explanation/);
  assert.ok(f.sent.length > 3, 'later batches still ran');
});

test('a context-limit error splits the batch once and retries instead of dropping it', async () => {
  const before = module(200);
  const files = [diffHunks('big.py', before, module(200, (i, b) => (i % 2 === 0 ? b + ' # x' : b)))];
  let failed = false;
  const f = fakeCall({ fail: (s) => {
    if (!failed && /^Analysing batch 1 of/.test(s.label)) { failed = true; return new OllamaError('http', 'Ollama returned 500: input length exceeds the context length'); }
    return undefined;
  } });
  const out = await explainDiff({ files, header: 'op', budget: budget(4096), language: 'en', call: f.call });
  assert.equal(out.incomplete, false, out.text);
  assert.ok(changedLinesSent(files, f.sent));
  assert.match(out.text, /big\.py: all \d+ hunks analysed/);
});

test('Ollama silently filling the window (prompt_eval_count = window) is not trusted as a complete answer', async () => {
  const s = module(40);
  const files = [diffHunks('a.py', s, s.replace('value + 3', 'value + 30'))];
  const b = budget(8192);
  let n = 0;
  const call = async (m: ChatMessage[]): Promise<ChatResult> => ({ content: answer(m[1].content), thinking: '', promptTokens: ++n === 1 ? b.window : 100 });
  const out = await explainDiff({ files, header: 'op', budget: b, language: 'en', call: call as any });
  assert.ok(n >= 2, 'retried in smaller batches');
  assert.equal(out.incomplete, false);
});

test('budget: the model limit caps the configured window; unknown metadata falls back to the setting; maxContextChars still applies', () => {
  const capped = contextBudget({ setting: 32768, modelLength: 8192, thinking: 'off', maxChars: 200_000 });
  assert.equal(capped.window, 8192);
  assert.ok(capped.input + capped.responseReserve + capped.safety + capped.system <= 8192);
  const fallback = contextBudget({ setting: 8192, thinking: 'off', maxChars: 200_000 });
  assert.equal(fallback.window, 8192);
  assert.equal(fallback.modelLength, undefined);
  const thinking = contextBudget({ setting: 8192, thinking: 'on', maxChars: 200_000 });
  assert.ok(thinking.input < fallback.input, 'thinking reserves more room for the answer');
  assert.equal(contextBudget({ setting: 40960, thinking: 'off', maxChars: 12000 }).input, 4000, 'maxContextChars caps one request');
});

test('unavailable change content is reported, never presented as analysed', async () => {
  const s = module(10);
  const files = [diffHunks('a.py', s, s.replace('value + 3', 'value + 4')), diffHunks('blob.bin', '', '', false)];
  const f = fakeCall();
  const out = await explainDiff({ files, header: 'op', budget: budget(8192), language: 'en', call: f.call });
  assert.equal(out.incomplete, true);
  assert.match(out.text, /blob\.bin/);
});

test('ReviewService pipeline: one result, sequential requests, progress labels, cancellation status, cached only when complete', async () => {
  const fake = new FakeOllama();
  fake.contextLength = 4096;
  fake.respond = (req) => [answer(req.messages[1].content)];
  const url = await fake.start();
  try {
    const svc = new ReviewService({ enabled: () => true, endpoint: () => url, allowRemote: () => false, preferredModel: () => 'qwen3:8b', thinking: () => 'off', contextWindow: () => 8192, updateIntervalMs: 5 });
    await svc.refreshModels();
    assert.equal(await svc.modelContextLength('qwen3:8b'), 4096, 'model metadata read (no inference)');
    const before = module(300);
    const files = [diffHunks('big.py', before, module(300, (i, b) => (i % 3 === 0 ? b + ' # x' : b)))];
    const b = contextBudget({ setting: 8192, modelLength: 4096, thinking: 'off', maxChars: 200_000 });
    const progress = new Set<string>();
    svc.onDidChange((s) => s.current?.progress && progress.add(s.current.progress));
    const req = () => ({
      kind: 'review' as const, title: 'Explain diff', subject: {}, messages: [], context: '', truncated: false, language: 'en' as const,
      pipeline: { key: 'k1', run: (call: any) => explainDiff({ files, header: 'op', budget: b, language: 'en', call }) },
    });
    const r = await svc.run(req());
    assert.equal(r.status, 'done');
    assert.ok((r.requests ?? 0) > 2);
    assert.equal(fake.maxInFlight, 1, 'Ollama never received parallel requests');
    assert.ok([...progress].some((p) => /^Analysing batch 2 of \d+$/.test(p)), [...progress].join(' | '));
    assert.equal(svc.getState().history.length, 1, 'one result, not one per batch');
    assert.ok(fake.chatRequests.every((c) => c.options.num_ctx === 8192 && c.options.num_predict === b.responseReserve && c.model === 'qwen3:8b'));
    const again = await svc.run(req());
    assert.equal(again.cached, true, 'complete results are cached');
    // Cancel during the second batch.
    fake.chunkDelayMs = 30;
    const sentBefore = fake.chatRequests.length;
    const running = svc.run({ ...req(), noCache: true });
    while (fake.chatRequests.length < sentBefore + 2) await new Promise((r2) => setTimeout(r2, 5));
    svc.cancel();
    const cancelled = await running;
    assert.equal(cancelled.status, 'cancelled');
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(fake.chatRequests.length, sentBefore + 2, 'no request after cancellation');
  } finally {
    await fake.stop();
  }
});

test('verification: a file named by path is accepted when unambiguous; one broken object does not discard the valid ones; quotes are still checked', async () => {
  const { verifyReviewItems } = await import('../reviewer/reviewOutput');
  const ev = (line: number, text: string) => ({ before: {}, after: { [line]: text } });
  const ctx: any = { filePath: 'src/validation.py', evidence: { before: {}, after: {} }, incomplete: false, fingerprint: '', files: [
    { filePath: 'src/validation.py', evidence: ev(10, 'def validate(rows, strict=False):'), changedLines: { before: new Set(), after: new Set([10]) }, incomplete: false },
    { filePath: 'importer.py', evidence: ev(6, 'validate(rows, strict=True)'), changedLines: { before: new Set(), after: new Set([6]) }, incomplete: false },
  ] };
  const raw = '```json\n[\n {"file": "validation.py", "status": "change", "side": "after", "line": 10, "quote": "def validate(rows, strict=False):", "message": "adds strict"},\n { " "file": "importer.py", "broken": true},\n {"file": "importer.py", "status": "change", "side": "after", "line": 6, "quote": "validate(rows, strict=True)", "message": "passes strict"},\n {"file": "importer.py", "status": "risk", "side": "after", "line": 6, "quote": "not on this line", "message": "invented"}\n]\n```';
  const v = verifyReviewItems(raw, ctx);
  assert.deepEqual(v.items.map((i) => [i.file, i.line, i.message]), [[1, 10, 'adds strict'], [2, 6, 'passes strict']]);
  assert.equal(v.valid, false, 'the answer is still flagged as not fully verifiable');
});
