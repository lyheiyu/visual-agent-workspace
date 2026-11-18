#!/usr/bin/env node
// REAL-runtime acceptance (opt-in; local GPU/RAM, no cloud):
//   npm run test:acceptance                 (VAW_ACCEPT_MODEL=qwen3:8b by default)
// Real VS Code Extension Development Host + real OpenCode + real local Ollama,
// in a disposable git project (never demo-workspace). Writes a JSON report to
// artifacts/manual-acceptance/acceptance-report.json.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { createDisposableJsRepo } = require('./lib/disposable-js-repo');

const root = path.resolve(__dirname, '..');

async function main() {
  const exe = process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/i.test(key)) delete env[key];
  const repo = createDisposableJsRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-accept-'));
  const report = path.join(root, 'artifacts', 'manual-acceptance', 'acceptance-report.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  env.VAW_ACCEPT_REPORT = report;
  const workspaceFile = path.join(tmp, 'acceptance.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: repo.dir }], settings: {} }));
  const args = [
    workspaceFile,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'acceptance', 'index.js')}`,
    `--user-data-dir=${path.join(tmp, 'user-data')}`,
    `--extensions-dir=${path.join(tmp, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
  ];
  console.log(`Acceptance project: ${repo.dir}`);
  const code = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: 'inherit', shell: false });
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  console.log(`\nFinal git status of the disposable project:\n${repo.status() || '(clean)'}\n${repo.diff()}`);
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await repo.dispose();
  console.log(`Report: ${report}`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
