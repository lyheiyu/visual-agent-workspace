#!/usr/bin/env node
// REAL local-model test (opt-in): uses your local Ollama and GPU/RAM.
// No cloud requests. Never pulls models: only models already installed are tested.
//
//   npm run test:ollama                       # qwen3:8b, gpt-oss:20b, qwen3.8:27b if installed
//   VAW_OLLAMA_MODELS="qwen3:8b" npm run test:ollama
const fs = require('node:fs');
const path = require('node:path');
const { ReviewService } = require('../out/reviewer/ReviewService');
const { explainFunctionPrompt, reviewChangePrompt } = require('../out/reviewer/prompts');
const { listFunctionRanges, replaceFunction } = require('../out/navigation/symbolSearch');
const { createUnifiedDiff } = require('../out/review/unifiedDiff');
const { referencedModuleDefinitions } = require('../out/analysis/staticAnalysis');
const { PROPOSED_VALIDATE_SAMPLES } = require('../out/adapters/demoScenario');

const endpoint = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
const wanted = (process.env.VAW_OLLAMA_MODELS || 'qwen3:8b,gpt-oss:20b,qwen3.8:27b').split(',').map((s) => s.trim()).filter(Boolean);
const demo = path.resolve(__dirname, '..', 'demo-workspace', 'validation.py');
const source = fs.readFileSync(demo, 'utf8');
const fn = listFunctionRanges(source, 'python').find((f) => f.name === 'validate_samples');
const fnCode = source.split(/\r?\n/).slice(fn.startLine, fn.endLine + 1).join('\n');
const proposed = replaceFunction(source, 'validate_samples', PROPOSED_VALIDATE_SAMPLES, 'python').text;
const pfn = listFunctionRanges(proposed, 'python').find((f) => f.name === 'validate_samples');

function svc(model) {
  return new ReviewService({
    enabled: () => true,
    endpoint: () => endpoint,
    allowRemote: () => false,
    preferredModel: () => model,
    thinking: () => 'off',
    contextWindow: () => 8192,
  });
}

async function timed(s, req) {
  const t0 = Date.now();
  let first;
  const sub = s.onDidChange((st) => {
    if (!first && st.current && (st.current.text || st.current.thinking)) first = Date.now() - t0;
  });
  const r = await s.run(req);
  sub.dispose();
  return { r, firstMs: first, totalMs: Date.now() - t0 };
}

async function main() {
  const probe = svc('');
  await probe.refreshModels();
  const st = probe.getState();
  if (st.connection !== 'connected') {
    console.log(`Ollama not available at ${endpoint}: ${st.error}`);
    process.exit(2);
  }
  const installed = st.models.map((m) => m.name);
  console.log(`Installed models: ${installed.join(', ')}`);
  const results = [];
  for (const model of wanted) {
    if (!installed.includes(model)) {
      console.log(`\n== ${model}: NOT INSTALLED (skipped; never downloaded)`);
      results.push({ model, status: 'not installed' });
      continue;
    }
    console.log(`\n== ${model}`);
    const s = svc(model);
    await s.refreshModels();
    const entry = { model };
    try {
      // 1. Explain function
      const ex = explainFunctionPrompt({ fn: { filePath: 'validation.py', startLine: fn.startLine + 1, code: fnCode, name: 'validate_samples' }, language: 'python', moduleDefs: referencedModuleDefinitions(source, fnCode, 'python') }, 12000);
      const a = await timed(s, { kind: 'explain', title: 'explain', subject: {}, ...ex });
      entry.explain = { status: a.r.status, firstTokenMs: a.firstMs, totalMs: a.totalMs, promptTokens: a.r.promptTokens, outputTokens: a.r.outputTokens, mentionsSampleId: /sample_id/.test(a.r.text), chars: a.r.text.length, thinkingChars: a.r.thinking.length };
      console.log(`  explain: ${a.r.status} first token ${a.firstMs} ms, total ${a.totalMs} ms, ${a.r.outputTokens} tokens`);
      console.log('  > ' + a.r.text.replace(/\s+/g, ' ').slice(0, 300) + (a.r.error ? ` [error: ${a.r.error}]` : ''));

      // 2. Review change (the demo's proposed validate_samples)
      const rv = reviewChangePrompt(
        {
          filePath: 'validation.py',
          functionName: 'validate_samples',
          diff: createUnifiedDiff(source, proposed),
          original: { filePath: 'validation.py', startLine: fn.startLine + 1, code: fnCode },
          modified: { filePath: 'validation.py', startLine: pfn.startLine + 1, code: proposed.split(/\r?\n/).slice(pfn.startLine, pfn.endLine + 1).join('\n') },
          operationRef: 'demo operation #5',
          moduleDefs: referencedModuleDefinitions(proposed, PROPOSED_VALIDATE_SAMPLES, 'python'),
        },
        12000,
      );
      const b = await timed(s, { kind: 'review', title: 'review', subject: {}, ...rv });
      entry.review = { status: b.r.status, firstTokenMs: b.firstMs, totalMs: b.totalMs, outputTokens: b.r.outputTokens, citesLines: /validation\.py:\d+/.test(b.r.text), claimsUndefinedRequiredFields: /REQUIRED_FIELDS[^.\n]*(not|never)\s+(be\s+)?(defined|imported)/i.test(b.r.text), chars: b.r.text.length, text: b.r.text };
      console.log(`  review:  ${b.r.status} first token ${b.firstMs} ms, total ${b.totalMs} ms, cites path:line: ${entry.review.citesLines}, claims REQUIRED_FIELDS undefined: ${entry.review.claimsUndefinedRequiredFields}`);
      console.log('  > ' + b.r.text.replace(/\s+/g, ' ').slice(0, 300) + (b.r.error ? ` [error: ${b.r.error}]` : ''));

      // 3. Cancellation on a real stream (different prompt so it is not cached)
      const long = explainFunctionPrompt({ fn: { filePath: 'validation.py', startLine: 1, code: source + '\n# explain every line in detail', name: undefined }, language: 'python' }, 12000);
      const t0 = Date.now();
      const running = s.run({ kind: 'explain', title: 'cancel', subject: {}, ...long });
      await new Promise((resolve) => {
        const sub = s.onDidChange((x) => {
          if (x.current && (x.current.text || x.current.thinking)) {
            sub.dispose();
            resolve();
          }
        });
      });
      const tCancel = Date.now();
      s.cancel();
      const c = await running;
      entry.cancel = { status: c.status, stoppedWithinMs: Date.now() - tCancel, afterMs: tCancel - t0 };
      console.log(`  cancel:  ${c.status}, stopped ${entry.cancel.stoppedWithinMs} ms after cancel`);
    } catch (err) {
      entry.error = err.message;
      console.log(`  ERROR: ${err.message}`);
    }
    results.push(entry);
  }
  const out = path.join(require('node:os').tmpdir(), 'vaw-ollama-real.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${out}`);
  const ok = results.every((r) => r.status === 'not installed' || (r.explain?.status === 'done' && r.review?.status === 'done' && r.cancel?.status === 'cancelled'));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
