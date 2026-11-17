#!/usr/bin/env node
// Runs the REAL Codex end-to-end suite (src/test/codex-integration) in an
// Extension Development Host whose workspace is a disposable git repo.
// Uses your Codex login and quota.
//
//   npm run test:codex                    # read-only suite
//   VAW_CODEX_SUITE=edits npm run test:codex
//   VAW_CODEX_SUITE=all   npm run test:codex
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { createDisposableRepo } = require('./lib/disposable-repo');

const root = path.resolve(__dirname, '..');

async function main() {
  const exe = process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable'));
  const env = { ...process.env, VAW_CODEX_SUITE: process.env.VAW_CODEX_SUITE || 'readonly' };
  for (const key of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(key)) delete env[key];
  }
  const repo = createDisposableRepo('vaw-codex-it-');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-codex-host-'));
  console.log(`Disposable repo: ${repo.dir}\nSuite: ${env.VAW_CODEX_SUITE}`);
  const args = [
    repo.dir,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'codex-integration', 'index.js')}`,
    `--user-data-dir=${path.join(tmp, 'user-data')}`,
    `--extensions-dir=${path.join(tmp, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
  ];
  const code = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: 'inherit', shell: false });
    child.on('error', (e) => (console.error(e), resolve(1)));
    child.on('exit', (c) => resolve(c ?? 1));
  });
  console.log(`\nFinal git status of the disposable repo:\n${repo.status() || '(clean)'}`);
  const diff = repo.diff();
  if (diff) console.log(diff);
  for (const dir of [tmp, repo.dir]) {
    for (let i = 0; i < 40; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
