import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import {
  buildExplainPrompt,
  buildSynthesisPrompt,
  chunkBudget,
  ExplanationRecord,
  hashText,
  outline,
  parseSections,
  planChunks,
  renderExplanationMarkdown,
  uncoveredCode,
} from '../reviewer/explainCode';
import { ReviewRequest, ReviewService } from '../reviewer/ReviewService';
import { parseMarkdown } from '../references/markdown';
import { FakeOllama } from './support/fakeOllama';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');

/** A Python module: imports, a class with N methods of `body` lines, and a module function. */
function pythonModule(methods: number, body: number): string {
  const lines = ['import numpy as np', 'from scipy.optimize import minimize', '', 'GAIN = 0.5', '', 'class MujocoOptimizer(Base):', '    """Optimizer."""', ''];
  for (let m = 0; m < methods; m++) {
    lines.push(`    def step_${m}(self, q, target):`);
    for (let k = 0; k < body; k++) lines.push(`        err_${k} = np.linalg.norm(q - target) * GAIN + ${k}`);
    lines.push(`        return err_${body - 1}`, '');
  }
  lines.push('def main():', '    opt = MujocoOptimizer()', '    return opt.step_0(np.zeros(3), np.ones(3))', '');
  return lines.join('\n');
}

test('chunking: a small function is one chunk with its enclosing class as context', () => {
  const text = pythonModule(3, 5);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('def step_1')) + 1;
  const plan = planChunks(text, 'python', { startLine: start, endLine: start + 6 }, { maxChunkChars: 6000, maxChunks: 8 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.partial, false);
  assert.deepEqual(plan.chunks[0].context, ['class MujocoOptimizer(Base):  (line 6)']);
});

test('chunking: a large file splits at function boundaries, keeps class context, and covers every line', () => {
  const text = pythonModule(12, 30);
  const total = text.split('\n').length;
  const plan = planChunks(text, 'python', { startLine: 1, endLine: total }, { maxChunkChars: 3000, maxChunks: 50 });
  assert.ok(plan.chunks.length > 3);
  assert.equal(plan.partial, false);
  const defs = outline(text, 'python');
  for (const c of plan.chunks) {
    // No method is cut in the middle when it fits a chunk on its own.
    for (const d of defs.filter((x) => x.text.startsWith('method'))) {
      const start = d.line;
      const end = start + 31;
      assert.ok(!(start < c.startLine && end >= c.startLine && end <= c.endLine) || false, `chunk ${c.startLine}-${c.endLine} cuts ${d.text}`);
    }
  }
  assert.ok(plan.chunks.some((c) => c.context.some((x) => x.startsWith('class MujocoOptimizer'))));
  assert.deepEqual(plan.analyzed, [{ startLine: 1, endLine: plan.chunks.at(-1)!.endLine }]);
  // Consecutive chunks are contiguous.
  for (let i = 1; i < plan.chunks.length; i++) assert.ok(plan.chunks[i].startLine > plan.chunks[i - 1].endLine);
});

test('chunking: the part limit makes the analysis explicitly partial', () => {
  const text = pythonModule(12, 30);
  const total = text.split('\n').length;
  const plan = planChunks(text, 'python', { startLine: 1, endLine: total }, { maxChunkChars: 3000, maxChunks: 2 });
  assert.equal(plan.chunks.length, 2);
  assert.equal(plan.partial, true);
  assert.ok(plan.omitted.length >= 1);
  assert.equal(plan.omitted.at(-1)!.endLine >= total - 3, true, 'the tail is reported as omitted');
  const prompt = buildExplainPrompt({ filePath: 'mujoco_optimizer.py', languageId: 'python', scope: 'file', mode: 'structured', text, plan, chunk: plan.chunks[0], totalLines: total, language: 'en' });
  assert.match(prompt.messages[1].content, /were NOT provided\. Do not describe them/);
});

test('chunking: one huge function without inner definitions is split by lines with its signature as context', () => {
  const lines = ['function solve(a, b) {', ...Array.from({ length: 400 }, (_, i) => (i % 25 === 24 ? '' : `  const v${i} = a * ${i} + b;`)), '  return a;', '}'];
  const text = lines.join('\n');
  const plan = planChunks(text, 'c-like', { startLine: 1, endLine: lines.length }, { maxChunkChars: 2500, maxChunks: 50 });
  assert.ok(plan.chunks.length > 3);
  assert.ok(plan.chunks.every((c) => c.context.some((x) => x.startsWith('function solve(a, b) {'))));
  assert.equal(plan.chunks[0].startLine, 1);
  assert.equal(plan.chunks.at(-1)!.endLine, lines.length);
});

test('context budget leaves room for the answer', () => {
  assert.equal(chunkBudget(8192, 12000), 10788);
  assert.equal(chunkBudget(2048, 12000), 1572);
  assert.equal(chunkBudget(131072, 12000), 12000);
});

test('prompts: real line numbers, only the chunk, structured sections vs line-by-line headings, secrets redacted', () => {
  const text = ['import os', 'API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"', '', 'def f(x):', '    y = x ** 2', '    return y + 1', '', 'def g():', '    return 2'].join('\n');
  const plan = planChunks(text, 'python', { startLine: 4, endLine: 6 }, { maxChunkChars: 5000, maxChunks: 4 });
  const base = { filePath: 'a.py', languageId: 'python', scope: 'symbol' as const, text, plan, chunk: plan.chunks[0], totalLines: 9, symbol: { name: 'f', kind: 'function' }, moduleLines: [{ line: 2, text: 'API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456"' }], language: 'zh-CN' as const };
  const s = buildExplainPrompt({ ...base, mode: 'structured' });
  const user = s.messages[1].content;
  assert.match(user, /4 \| def f\(x\):\n5 \|     y = x \*\* 2\n6 \|     return y \+ 1/);
  assert.doesNotMatch(user, /def g/, 'unrelated code is not sent');
  assert.match(user, /Role within the project[\s\S]*Modification impact/, 'function scope explains its role within the project');
  assert.doesNotMatch(user, /sk-abcdefghijklmnopqrstuvwxyz123456/, 'secrets are redacted');
  assert.match(s.messages[0].content, /\[Fact\][\s\S]*\[Inference\][\s\S]*\[Issue\]/);
  assert.match(s.messages[0].content, /Simplified Chinese/);
  const l = buildExplainPrompt({ ...base, mode: 'lineByLine' });
  assert.match(l.messages[1].content, /### Lines <start>–<end>: <short title>/);
  assert.match(l.messages[1].content, /covering lines 4–6/);
  const syn = buildSynthesisPrompt({ filePath: 'a.py', scopeText: 'entire file a.py', plan, partTexts: [{ span: { startLine: 1, endLine: 3 }, text: 'x'.repeat(50_000) }], language: 'en', budgetChars: 8000 });
  assert.ok(syn.messages[1].content.length < 12_000, 'synthesis input is bounded');
});

test('section parsing: English and Chinese ranges, invalid ranges flagged, code fences respected', () => {
  const md = [
    'Intro text.',
    '### Lines 167–175: Optimizer initialization',
    'Sets **q0**. See Lines 170–171.',
    '```python',
    '## not a heading inside code',
    '```',
    '### Line 176: Objective',
    'x',
    '### 第 177-180 行：优化执行',
    'y',
    '### Lines 900–910: hallucinated',
    'z',
  ].join('\n');
  const s = parseSections(md, { startLine: 160, endLine: 200 });
  assert.equal(s.length, 5);
  assert.equal(s[0].title, '');
  assert.deepEqual([s[1].startLine, s[1].endLine, s[1].rangeValid], [167, 175, true]);
  assert.match(s[1].body, /## not a heading inside code/);
  assert.deepEqual([s[2].startLine, s[2].endLine], [176, 176]);
  assert.deepEqual([s[3].startLine, s[3].endLine, s[3].rangeValid], [177, 180, true]);
  assert.equal(s[4].rangeValid, false, 'a range outside the analyzed lines is never linked');
  // "Lines 170–171" inside the body becomes a self reference in the panel.
  const refs = JSON.stringify(parseMarkdown(s[1].body, { lineRefsFor: 'x.py' }));
  assert.match(refs, /"line":170,"endLine":171,"self":true/);
});

test('line-by-line coverage: uncovered code is reported', () => {
  const text = ['a = 1', 'b = 2', '', '# comment', 'c = a + b', 'print(c)'].join('\n');
  const sections = parseSections('### Lines 1–2: init\nx\n#### ### Line 6: print\ny', { startLine: 1, endLine: 6 });
  assert.equal(sections[1].title, 'Line 6: print', 'malformed nested heading markers from small models are cleaned');
  assert.deepEqual(uncoveredCode(sections, { startLine: 1, endLine: 6 }, text), [{ startLine: 5, endLine: 5 }]);
});

test('export: metadata, partial and stale warnings, hash, model and every section', () => {
  const text = pythonModule(2, 3);
  const plan = planChunks(text, 'python', { startLine: 1, endLine: 20 }, { maxChunkChars: 400, maxChunks: 1 });
  const r: ExplanationRecord = {
    id: 'r1',
    createdAt: '2026-11-17T10:00:00Z',
    finishedAt: '2026-11-17T10:00:05Z',
    file: { uri: 'file:///x.py', fsPath: '/x.py', relPath: 'x.py', languageId: 'python', version: 3, hash: hashText(text), dirty: true, lineCount: 20 },
    scope: 'file',
    mode: 'lineByLine',
    target: { startLine: 1, endLine: 20 },
    model: 'qwen3:8b',
    language: 'en',
    plan,
    parts: [{ chunk: plan.chunks[0], status: 'done', text: '', sections: parseSections('### Lines 1–2: imports\n[Fact] imports numpy', plan.chunks[0]), gaps: [{ startLine: 4, endLine: 4 }] }],
    status: 'done',
    stale: true,
  };
  const md = renderExplanationMarkdown(r);
  assert.match(md, /Line-by-line explanation: x\.py/);
  assert.match(md, /qwen3:8b/);
  assert.match(md, /partial: .* not analyzed/);
  assert.match(md, /unsaved editor contents/);
  assert.match(md, new RegExp(`sha256 ${r.file.hash.slice(0, 16)}`));
  assert.match(md, /source changed after this analysis/);
  assert.match(md, /### Lines 1–2: imports\n\n\[Fact\] imports numpy/);
  assert.match(md, /Not covered by the model: line 4/);
});

test('re-run bypasses the reviewer cache; identical requests are otherwise cached', async () => {
  const fake = new FakeOllama();
  await fake.start();
  try {
    const service = new ReviewService({ enabled: () => true, endpoint: () => fake.url, allowRemote: () => false, preferredModel: () => 'qwen3:8b', thinking: () => 'off', contextWindow: () => 8192, updateIntervalMs: 5 });
    const req = (): ReviewRequest => ({ kind: 'detail', title: 't', subject: {}, messages: [{ role: 'user', content: 'explain' }], context: '', truncated: false });
    await service.run(req());
    const again = await service.run(req());
    assert.equal(again.cached, true);
    assert.equal(fake.chatRequests.length, 1);
    const fresh = await service.run({ ...req(), noCache: true });
    assert.equal(fresh.cached, false);
    assert.equal(fake.chatRequests.length, 2);
    service.dispose();
  } finally {
    await fake.stop();
  }
});

// ---------------------------------------------------------------- webview

class Element {
  id = ''; children: any[] = []; textContent = ''; className = ''; value = ''; disabled = false; open = true; selected = false; title = ''; tagName: string;
  listeners: Record<string, (event?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag; }
  append(...c: any[]) { this.children.push(...c); }
  appendChild(c: any) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(k: string, fn: (event?: any) => void) { this.listeners[k] = fn; }
}

test('explanation panel webview: clickable section ranges, self line references, mode switch and re-run are explicit', () => {
  const app = new Element(); app.id = 'app';
  const all = (n: any): any[] => [n, ...(n.children ?? []).flatMap(all)];
  let receive: (e: any) => void = () => {};
  const sent: any[] = [];
  const window: any = { addEventListener: (_: string, fn: any) => { receive = fn; } };
  const ctx = vm.createContext({
    window,
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m))) }),
    document: { getElementById: () => app, createElement: (t: string) => new Element(t), createTextNode: (v: string) => Object.assign(new Element('#text'), { textContent: v }) },
  });
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'markdownView.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'explain.js'), 'utf8'), ctx);
  assert.deepEqual(sent[0], { type: 'ready' });
  const sectionAst = JSON.parse(JSON.stringify(parseMarkdown('[Fact] Calls `minimize` (Lines 170–171).', { lineRefsFor: 'mujoco_optimizer.py' })));
  const record = {
    id: 'rec-1', file: { relPath: 'mujoco_optimizer.py', fsPath: '/p/mujoco_optimizer.py', languageId: 'python', version: 2, hash: 'abc', dirty: false, lineCount: 300 },
    stale: true, scope: 'symbol', scopeLabel: 'function optimize (lines 167–215)', target: { startLine: 167, endLine: 215 }, mode: 'lineByLine', model: 'qwen3:8b', language: 'en', status: 'done',
    plan: { partial: true, analyzed: ['lines 167–200'], omitted: ['lines 201–215'], parts: 1 },
    parts: [{ index: 0, startLine: 167, endLine: 200, context: [], status: 'done', gaps: [], sections: [
      { title: 'Lines 167–175: Optimizer initialization', startLine: 167, endLine: 175, rangeValid: true, ast: sectionAst },
      { title: 'Lines 900–910: hallucinated', startLine: 900, endLine: 910, rangeValid: false, ast: [] },
    ] }],
  };
  receive({ data: { type: 'state', model: { strings: {}, models: ['qwen3:8b', 'gpt-oss:20b'], selectedModel: 'qwen3:8b', busy: false, running: false, mode: 'lineByLine', needsRun: false, record, history: [] } } });
  const texts = all(app).map((e) => e.textContent);
  assert.ok(texts.includes('x.stale'), 'stale warning shown');
  assert.ok(texts.some((t) => t === 'x.partial'), 'partial analysis shown');
  const ranges = all(app).filter((e) => e.tagName === 'a' && e.className === 'range');
  const sectionRange = ranges.find((e) => e.textContent.startsWith('↗'))!;
  sectionRange.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(sent.at(-1), { type: 'gotoRange', id: 'rec-1', startLine: 167, endLine: 175 });
  assert.equal(ranges.filter((e) => /x\.lines/.test(e.textContent)).length, 2, 'part header + the valid section; the hallucinated range is not linked');
  const selfRef = all(app).find((e) => e.tagName === 'a' && /code-ref self/.test(e.className))!;
  selfRef.listeners.click({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'openReference', id: 'rec-1', side: false, ref: { path: 'mujoco_optimizer.py', line: 170, endLine: 171, self: true } });
  const selects = all(app).filter((e) => e.tagName === 'select');
  const mode = selects.find((s) => s.attrs['aria-label'] === 'x.mode')!;
  mode.value = 'structured';
  mode.listeners.change();
  assert.deepEqual(sent.at(-1), { type: 'setMode', mode: 'structured' }, 'switching mode alone never runs the model');
  all(app).find((e) => e.tagName === 'button' && e.textContent === 'x.rerun')!.listeners.click();
  assert.deepEqual(sent.at(-1), { type: 'run', mode: 'lineByLine' });
});
