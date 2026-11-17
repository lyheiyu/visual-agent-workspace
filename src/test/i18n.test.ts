import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { localizeError, normalizeLanguage, resolveStrings, STRINGS, t } from '../i18n/i18n';
import { buildActivityViewModel, explainControl } from '../ui/viewModel';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { codeSpans, codeSpansPreserved, explainFunctionPrompt, languageDirective, translatePrompt } from '../reviewer/prompts';
import { ReviewRequest, ReviewService } from '../reviewer/ReviewService';
import { FakeOllama } from './support/fakeOllama';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');

test('string table: every entry has English and Chinese; default language is 中文', () => {
  for (const [k, [en, zh]] of Object.entries(STRINGS) as Array<[string, [string, string]]>) {
    assert.ok(en.trim() && zh.trim(), `empty translation for ${k}`);
  }
  assert.equal(normalizeLanguage(undefined), 'zh-CN');
  assert.equal(normalizeLanguage('fr'), 'zh-CN');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(t('a.timeline', 'en'), 'Timeline');
  assert.equal(t('a.timeline', 'zh-CN'), '时间线');
  assert.equal(t('a.timeline', 'bilingual'), '时间线 / Timeline');
  assert.equal(t('a.details', 'zh-CN', { n: 5 }), '操作 #5 详情');
  assert.equal(t('r.translate', 'bilingual'), 'Translate / 翻译', 'identical strings are not duplicated');
});

test('every string key used by the webviews exists (static, no LLM)', () => {
  const keys = new Set(Object.keys(STRINGS));
  for (const file of ['activity.js', 'reviewer.js']) {
    const src = fs.readFileSync(path.join(MEDIA, file), 'utf8');
    for (const m of src.matchAll(/\bS\('([\w.\-]+)'\s*[,)]/g)) {
      assert.ok(keys.has(m[1]), `${file}: missing key ${m[1]}`);
    }
  }
  // Dynamic keys: statuses, operation types, control labels, language names.
  for (const s of ['Proposed', 'Running', 'Completed', 'Failed', 'Rejected', 'Cancelled']) assert.ok(keys.has(`status.${s}`));
  for (const s of ['Read', 'Analyze', 'Edit', 'Execute', 'Test', 'Summary', 'Instruct']) assert.ok(keys.has(`type.${s}`));
  for (const s of ['OBSERVED', 'INTERCEPTED', 'GATED']) assert.ok(keys.has(`ctl.${s}`));
  for (const s of ['zh-CN', 'en', 'bilingual']) assert.ok(keys.has(`lang.${s}`));
  // Manifest localization: every %key% has en and zh-cn entries.
  const root = path.resolve(__dirname, '..', '..');
  const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
  for (const m of manifest.matchAll(/"%([\w.\-]+)%"/g)) {
    assert.ok(en[m[1]] && zh[m[1]], `manifest key ${m[1]}`);
  }
});

test('view model switches between Chinese and English; data stays untranslated', async () => {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' });
  const taskId = controller.start('demo');
  await new Promise<void>((r) => {
    const sub = controller.onDidChangeState((s) => {
      if (s.awaitingApprovalFor) {
        sub.dispose();
        controller.approve(s.awaitingApprovalFor);
        r();
      }
    });
  });
  await controller.whenIdle();
  const testOp = recorder.getOperations(taskId).find((o) => o.operationType === 'Test')!;
  const zh = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true, selectedOperationId: testOp.operationId, language: 'zh-CN' });
  const en = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true, selectedOperationId: testOp.operationId, language: 'en' });
  assert.equal(zh.header.statusLabel, '已完成');
  assert.equal(en.header.statusLabel, 'Completed');
  assert.equal(zh.strings['a.timeline'], '时间线');
  assert.equal(en.strings['a.timeline'], 'Timeline');
  assert.match(zh.selected!.controlExplanation, /模拟/);
  // Raw evidence is never translated.
  assert.equal(zh.selected!.command!.command, 'python -m pytest tests/test_validation.py -v');
  assert.equal(zh.selected!.command!.stdout, en.selected!.command!.stdout);
  assert.equal(zh.selected!.description, en.selected!.description);
  assert.equal(zh.selected!.status, 'Completed', 'enum value kept; label translated in the webview');
  assert.match(explainControl(testOp), /^Simulated/, 'English default preserved');
});

test('common errors are localized; unknown messages pass through', () => {
  assert.equal(localizeError('That operation is not awaiting approval.', 'zh-CN'), '该操作不在等待批准。');
  assert.match(localizeError('Cannot reach Ollama at http://127.0.0.1:9 (ECONNREFUSED). Is it running?', 'zh-CN'), /^无法连接 Ollama.*ECONNREFUSED/);
  assert.equal(localizeError('That operation is not awaiting approval.', 'en'), 'That operation is not awaiting approval.');
  assert.equal(localizeError('weird internal error', 'zh-CN'), 'weird internal error');
});

test('prompts: answer directly in the selected language; one request for bilingual; identifiers kept', () => {
  const fn = { filePath: 'validation.py', startLine: 10, code: 'def validate_samples(samples):\n    return samples', name: 'validate_samples' };
  const zh = explainFunctionPrompt({ fn, language: 'python' }, 10_000, 'zh-CN');
  const en = explainFunctionPrompt({ fn, language: 'python' }, 10_000, 'en');
  const bi = explainFunctionPrompt({ fn, language: 'python' }, 10_000, 'bilingual');
  assert.match(zh.messages[0].content, /directly in Simplified Chinese \(简体中文\); do not write an English version first/);
  assert.match(en.messages[0].content, /Write the answer in English/);
  assert.match(bi.messages[0].content, /single response.*"## 中文".*"## English"/);
  for (const p of [zh, en, bi]) {
    assert.match(p.messages[0].content, /Keep code identifiers, code snippets, file paths, commands, exception names and API names exactly as written/);
    assert.match(p.messages[1].content, /10 \| def validate_samples/, 'code itself is never translated');
  }
  assert.equal(languageDirective('zh-CN') === languageDirective('en'), false);
  const tp = translatePrompt('Uses `validate_samples`.', 'zh-CN');
  assert.match(tp[0].content, /Simplified Chinese/);
  assert.match(tp[0].content, /byte-for-byte/);
});

test('code-span preservation check', () => {
  const md = 'Calls `validate_samples()` and raises `ValidationError`.\n```python\nx = 1\n```\nRun `python -m pytest -v`.';
  assert.deepEqual(codeSpans(md), ['x = 1', 'validate_samples()', 'ValidationError', 'python -m pytest -v']);
  assert.equal(codeSpansPreserved(md, '调用 `validate_samples()` 并抛出 `ValidationError`。\n```python\nx = 1\n```\n运行 `python -m pytest -v`。'), true);
  assert.equal(codeSpansPreserved(md, '调用 `验证样本()` 并抛出 `ValidationError`。\nx = 1\n运行 `python -m pytest -v`。'), false);
});

function svc(url: string, enabled = true) {
  return new ReviewService({
    enabled: () => enabled,
    endpoint: () => url,
    allowRemote: () => false,
    preferredModel: () => '',
    thinking: () => 'off',
    contextWindow: () => 8192,
    updateIntervalMs: 5,
  });
}
const req = (lang: 'zh-CN' | 'en' | 'bilingual'): ReviewRequest => ({
  kind: 'explain',
  title: 'x',
  subject: {},
  ...explainFunctionPrompt({ fn: { filePath: 'a.py', startLine: 1, code: 'def validate_samples(s):\n    return s', name: 'validate_samples' }, language: 'python' }, 10_000, lang),
  language: lang,
});

test('review language is part of the cache key: zh / en / bilingual are separate requests', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = svc(url);
    fake.tokens = ['`validate_samples` ', '返回输入。'];
    const zh = await s.run(req('zh-CN'));
    fake.tokens = ['`validate_samples` ', 'returns its input.'];
    const en = await s.run(req('en'));
    fake.tokens = ['## 中文\n返回输入。\n\n## English\nReturns its input.'];
    const bi = await s.run(req('bilingual'));
    assert.deepEqual([zh.language, en.language, bi.language], ['zh-CN', 'en', 'bilingual']);
    assert.equal(s.inferenceRequests, 3);
    assert.equal(fake.chatRequests.length, 3, 'bilingual is ONE request');
    assert.match(fake.chatRequests[0].messages[0].content, /简体中文/);
    const again = await s.run(req('zh-CN'));
    assert.equal(again.cached, true);
    assert.equal(s.inferenceRequests, 3);
  } finally {
    await fake.stop();
  }
});

test('translate: streams, keeps the original, caches, and switching versions makes no requests', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = svc(url);
    fake.tokens = ['`validate_samples()` ', 'returns the list; raises ', '`ValidationError`.'];
    const r = await s.run(req('en'));
    const original = r.text;

    fake.tokens = ['`validate_samples()` ', '返回列表；', '抛出 `ValidationError`。'];
    fake.chunkDelayMs = 5;
    const partial: string[] = [];
    const sub = s.onDidChange((st) => {
      const tr = st.current?.translations['zh-CN'];
      if (tr?.status === 'streaming' && tr.text) partial.push(tr.text);
    });
    const tr = await s.translate(r.id, 'zh-CN');
    sub.dispose();
    assert.equal(tr?.status, 'done');
    assert.equal(tr?.text, '`validate_samples()` 返回列表；抛出 `ValidationError`。');
    assert.equal(tr?.codeSpansPreserved, true);
    assert.ok(partial.length > 0, 'translation streamed');
    const body = fake.chatRequests.at(-1);
    assert.match(body.messages[0].content, /Simplified Chinese/);
    assert.equal(body.messages[1].content, original, 'translates the original text');

    const requests = fake.chatRequests.length;
    const inferences = s.inferenceRequests;
    const current = () => s.getState().history.find((h) => h.id === r.id)!;
    assert.equal(current().text, original, 'original preserved');
    assert.ok(s.showVersion(r.id, 'original'));
    assert.ok(s.showVersion(r.id, 'zh-CN'));
    assert.ok(s.showVersion(r.id, 'bilingual'));
    assert.equal(s.showVersion(r.id, 'en'), false, 'no cached English translation of an English original');
    await s.translate(r.id, 'zh-CN'); // already translated → just shows it
    assert.equal(fake.chatRequests.length, requests, 'switching cached versions: no model request');
    assert.equal(s.inferenceRequests, inferences);
    assert.equal(current().view, 'zh-CN');

    // Same original + model + target in another result → translation cache hit.
    const r2 = await s.run(req('en')); // cached review result (same prompt)
    const tr2 = await s.translate(r2.id, 'zh-CN');
    assert.equal(tr2?.cached, true);
    assert.equal(fake.chatRequests.length, requests);

    // Same language → nothing to do.
    assert.equal(await s.translate(r.id, 'en'), undefined);
    assert.equal(fake.chatRequests.length, requests);
  } finally {
    await fake.stop();
  }
});

test('translate: cancellation, model switch, and code-span warning', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = svc(url);
    fake.tokens = ['Use `load_data`.'];
    const r = await s.run(req('en'));
    fake.tokens = Array.from({ length: 200 }, (_, i) => `字${i}`);
    fake.chunkDelayMs = 15;
    const running = s.translate(r.id, 'zh-CN');
    await new Promise<void>((res) => {
      const sub = s.onDidChange((st) => {
        if (st.current?.translations['zh-CN']?.text) {
          sub.dispose();
          res();
        }
      });
    });
    assert.ok(s.cancel());
    const cancelled = await running;
    assert.equal(cancelled?.status, 'cancelled');
    const after = s.getState().history.find((h) => h.id === r.id)!;
    assert.equal(after.translations['zh-CN'], undefined, 'partial translation not kept');
    assert.equal(after.view, 'original');
    assert.equal(after.text, 'Use `load_data`.');

    // Different model → different cache key → new translation; mangled code span flagged.
    fake.chunkDelayMs = 0;
    fake.tokens = ['使用 `加载数据`。'];
    s.selectModel('llama3:8b');
    const tr = await s.translate(r.id, 'zh-CN');
    assert.equal(tr?.model, 'llama3:8b');
    assert.equal(tr?.codeSpansPreserved, false);
  } finally {
    await fake.stop();
  }
});

test('translation needs an explicit call: disabled reviewer refuses, no requests', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = svc(url);
    const r = await s.run(req('en'));
    const off = svc(url, false);
    await assert.rejects(off.translate(r.id, 'zh-CN'), /completed results|disabled/);
    assert.equal(fake.chatRequests.length, 1);
  } finally {
    await fake.stop();
  }
});

test('resolveStrings covers all keys for each language', () => {
  for (const lang of ['zh-CN', 'en', 'bilingual'] as const) {
    assert.equal(Object.keys(resolveStrings(lang)).length, Object.keys(STRINGS).length);
  }
});
