#!/usr/bin/env node
// REAL local-model language test (opt-in; uses local GPU/RAM, no cloud).
//   npm run test:ollama:i18n            (default model qwen3:8b)
//   VAW_OLLAMA_MODEL=gpt-oss:20b npm run test:ollama:i18n
const fs = require('node:fs');
const path = require('node:path');
const { ReviewService } = require('../out/reviewer/ReviewService');
const { explainFunctionPrompt, codeSpans } = require('../out/reviewer/prompts');
const { listFunctionRanges } = require('../out/navigation/symbolSearch');
const { referencedModuleDefinitions } = require('../out/analysis/staticAnalysis');

const model = process.env.VAW_OLLAMA_MODEL || 'qwen3:8b';
const src = fs.readFileSync(path.resolve(__dirname, '..', 'demo-workspace', 'validation.py'), 'utf8');
const fn = listFunctionRanges(src, 'python').find((f) => f.name === 'validate_samples');
const code = src.split(/\r?\n/).slice(fn.startLine, fn.endLine + 1).join('\n');
const cjk = (s) => (s.match(/[一-鿿]/g) || []).length / Math.max(1, s.replace(/\s/g, '').length);

const s = new ReviewService({
  enabled: () => true,
  endpoint: () => process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434',
  allowRemote: () => false,
  preferredModel: () => model,
  thinking: () => 'off',
  contextWindow: () => 8192,
});
const req = (lang) => ({
  kind: 'explain',
  title: `explain (${lang})`,
  subject: {},
  language: lang,
  ...explainFunctionPrompt({ fn: { filePath: 'validation.py', startLine: fn.startLine + 1, code, name: 'validate_samples' }, language: 'python', moduleDefs: referencedModuleDefinitions(src, code, 'python') }, 12000, lang),
});

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  await s.refreshModels();
  if (!s.getState().models.some((m) => m.name === model)) {
    console.log(`${model} is not installed (never downloaded); skipping.`);
    process.exit(2);
  }
  s.selectModel(model);
  console.log(`model: ${model}`);

  const zh = await s.run(req('zh-CN'));
  check('Chinese explanation is written in Chinese', zh.status === 'done' && cjk(zh.text) > 0.3, `CJK ratio ${cjk(zh.text).toFixed(2)}, ${zh.durationMs} ms`);
  check('Chinese explanation keeps identifiers', /validate_samples/.test(zh.text) && /sample_id/.test(zh.text));
  console.log('   > ' + zh.text.replace(/\s+/g, ' ').slice(0, 160));

  const en = await s.run(req('en'));
  check('English explanation is written in English', en.status === 'done' && cjk(en.text) < 0.02, `CJK ratio ${cjk(en.text).toFixed(2)}, ${en.durationMs} ms`);
  console.log('   > ' + en.text.replace(/\s+/g, ' ').slice(0, 160));

  const before = s.inferenceRequests;
  const bi = await s.run(req('bilingual'));
  check('bilingual explanation from ONE request has both sections', bi.status === 'done' && s.inferenceRequests === before + 1 && /##\s*中文/.test(bi.text) && /##\s*English/i.test(bi.text), `${bi.durationMs} ms`);

  const tr = await s.translate(en.id, 'zh-CN');
  check('English review translated to Chinese', tr?.status === 'done' && cjk(tr.text) > 0.2, `CJK ratio ${cjk(tr?.text || '').toFixed(2)}`);
  const spans = codeSpans(en.text);
  const kept = spans.filter((x) => (tr?.text || '').includes(x));
  check('code spans preserved in translation', tr?.codeSpansPreserved === true, `${kept.length}/${spans.length} spans kept`);
  check('original text preserved', s.getState().history.find((h) => h.id === en.id).text === en.text);
  console.log('   > ' + (tr?.text || '').replace(/\s+/g, ' ').slice(0, 160));

  const n = s.inferenceRequests;
  s.showVersion(en.id, 'original');
  s.showVersion(en.id, 'zh-CN');
  s.showVersion(en.id, 'bilingual');
  await s.translate(en.id, 'zh-CN');
  check('switching cached versions makes no model request', s.inferenceRequests === n);

  // Cancel a translation mid-stream (Chinese → English of the bilingual-free zh result).
  const running = s.translate(zh.id, 'en');
  await new Promise((resolve) => {
    const sub = s.onDidChange((st) => {
      if (st.current?.translations?.en?.text) {
        sub.dispose();
        resolve();
      }
    });
  });
  const t0 = Date.now();
  s.cancel();
  const c = await running;
  check('translation can be cancelled', c?.status === 'cancelled', `stopped ${Date.now() - t0} ms after cancel`);

  const ok = checks.every((x) => x.ok);
  console.log(`\n${checks.filter((x) => x.ok).length}/${checks.length} checks passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
