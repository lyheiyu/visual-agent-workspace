const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const JSZip = require('jszip');
const manifest = require('../package.json');
const filename = process.argv[2] || path.resolve(__dirname, `../artifacts/${manifest.name}-${manifest.version}.vsix`);
(async () => {
  const bytes = fs.readFileSync(filename);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  assert.ok(zip.file('extension/out/extension.js'));
  assert.ok(zip.file('extension/media/conversation.js'));
  for (const f of ['markdownView.js', 'explain.js', 'explain.css']) assert.ok(zip.file('extension/media/' + f), f);
  assert.ok(zip.file('extension/out/references/ReferenceNavigator.js') && zip.file('extension/out/reviewer/ExplainController.js'));
  assert.ok(zip.file('extension/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
  assert.ok(!names.some((name) => /(^|\/)(\.git|\.vscode|\.vscode-test|artifacts|src|tests?)(\/|$)/.test(name)));
  assert.ok(!names.some((name) => /\.(exe|vsix)$|(^|\/)\.env(?:\.|$)|auth\.json|credentials\.json/i.test(name)));
  const packaged = JSON.parse(await zip.file('extension/package.json').async('string'));
  assert.equal(packaged.version, manifest.version);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-vsix-check-'));
  try {
    for (const name of names) {
      const entry = zip.files[name];
      if (entry.dir || !name.startsWith('extension/')) continue;
      const target = path.resolve(temporary, name);
      assert.ok(target.startsWith(temporary + path.sep), 'archive paths stay inside the verification directory');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async('nodebuffer'));
    }
    const sdk = await import(pathToFileURL(path.join(temporary, 'extension/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).href);
    assert.equal(typeof sdk.query, 'function', 'packaged SDK loads without its excluded native binary');
  } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  const hash = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(path.dirname(filename), 'SHA256SUMS.txt'), `${hash}  ${path.basename(filename)}\n`);
  console.log(`PASS: v${manifest.version}; ${(bytes.length / 1024 / 1024).toFixed(2)} MiB; no source/cache/credentials/native executable; packaged SDK imports successfully.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
