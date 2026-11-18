#!/usr/bin/env node
// REAL local-model check for "Explain Code in Detail" (opt-in; local GPU/RAM, no cloud).
//   npm run test:ollama:explain            (default model qwen3:8b)
//   VAW_OLLAMA_MODEL=gpt-oss:20b npm run test:ollama:explain
// Sends 4–5 requests: line-by-line (中文) for one function, structured (English) for a
// file, and line-by-line for the same file split into parts with a small budget.
const fs = require('node:fs');
const path = require('node:path');
const { ReviewService } = require('../out/reviewer/ReviewService');
const { planChunks, buildExplainPrompt, parseSections, uncoveredCode, importLines, formatSpan } = require('../out/reviewer/explainCode');
const { listFunctionRanges } = require('../out/navigation/symbolSearch');

const model = process.env.VAW_OLLAMA_MODEL || 'qwen3:8b';
const file = path.resolve(__dirname, '..', 'demo-workspace', 'validation.py');
const text = fs.readFileSync(file, 'utf8');
const total = text.split(/\r?\n/).length;
const service = new ReviewService({
  enabled: () => true,
  endpoint: () => process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434',
  allowRemote: () => false,
  preferredModel: () => model,
  thinking: () => 'off',
  contextWindow: () => 8192,
});
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function explain(span, scope, mode, language, maxChunkChars, symbol) {
  const plan = planChunks(text, 'python', span, { maxChunkChars, maxChunks: 8 });
  const parts = [];
  for (const chunk of plan.chunks) {
    const built = buildExplainPrompt({ filePath: 'validation.py', languageId: 'python', scope, mode, text, plan, chunk, totalLines: total, symbol, moduleLines: importLines(text), language });
    const t0 = Date.now();
    const r = await service.run({ kind: 'detail', title: 'explain', subject: {}, language, noCache: true, ...built });
    const sections = parseSections(r.text, chunk);
    parts.push({ chunk, r, sections, gaps: mode === 'lineByLine' ? uncoveredCode(sections, chunk, text) : [], ms: Date.now() - t0 });
  }
  return { plan, parts };
}

(async () => {
  await service.refreshModels();
  if (!service.getState().models.some((m) => m.name === model)) {
    console.log(`${model} is not installed in Ollama (not downloaded automatically). Skipped.`);
    process.exit(0);
  }
  service.selectModel(model);
  console.log(`model: ${model}`);
  const fn = listFunctionRanges(text, 'python').find((f) => f.name === 'validate_samples');
  const fnSpan = { startLine: fn.startLine + 1, endLine: fn.endLine + 1 };

  // 1. Line by line, Chinese, one function.
  const a = await explain(fnSpan, 'symbol', 'lineByLine', 'zh-CN', 10000, { name: 'validate_samples', kind: 'function' });
  const p = a.parts[0];
  const ranged = p.sections.filter((s) => s.startLine);
  console.log(`\n--- line by line (${(p.ms / 1000).toFixed(1)} s) ---\n${p.r.text.slice(0, 1800)}\n`);
  check('line-by-line: completed', p.r.status === 'done', p.r.error);
  check('line-by-line: ≥2 sections with line ranges', ranged.length >= 2, ranged.map((s) => `${s.startLine}-${s.endLine}`).join(', '));
  check('line-by-line: every range lies inside the function', ranged.every((s) => s.rangeValid), formatSpan(fnSpan));
  check('line-by-line: answer is in Chinese', (p.r.text.match(/[一-鿿]/g) || []).length > 40);
  check('line-by-line: claims are labelled', /\[(Fact|Inference|Issue)\]/.test(p.r.text));
  console.log(`  coverage gaps reported: ${p.gaps.map(formatSpan).join(', ') || 'none'}`);

  // 2. Structured, English, whole file (fits one part).
  const b = await explain({ startLine: 1, endLine: total }, 'file', 'structured', 'en', 10000);
  const q = b.parts[0];
  console.log(`\n--- structured (${(q.ms / 1000).toFixed(1)} s) ---\n${q.r.text.slice(0, 1500)}\n`);
  check('structured: one part, not partial', b.plan.chunks.length === 1 && !b.plan.partial);
  check('structured: ≥5 of the 7 sections', q.sections.filter((s) => s.title).length >= 5, q.sections.map((s) => s.title).join(' | '));
  check('structured: cites line numbers', /Lines? \d+/i.test(q.r.text));

  // 3. Same file split into parts with a tiny budget (syntax-aware chunking against a real model).
  const c = await explain({ startLine: 1, endLine: total }, 'file', 'lineByLine', 'en', 450);
  console.log(`\nparts: ${c.plan.chunks.map((x) => formatSpan(x)).join(' | ')}`);
  check('chunked: split into ≥2 parts at definition boundaries', c.plan.chunks.length >= 2);
  for (const part of c.parts) {
    const rs = part.sections.filter((s) => s.startLine);
    check(`chunked part ${formatSpan(part.chunk)}: ranges stay inside the part`, part.r.status === 'done' && rs.length > 0 && rs.every((s) => s.rangeValid), rs.map((s) => `${s.startLine}-${s.endLine}${s.rangeValid ? '' : '✗'}`).join(', '));
  }
  console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed (${service.inferenceRequests} local requests)`);
  service.dispose();
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
