#!/usr/bin/env node
// Runs src/test/integration in a VS Code Extension Development Host.
//
// - By default, @vscode/test-electron downloads an isolated VS Code build into
//   .vscode-test/. Set VSCODE_EXECUTABLE to use an installed VS Code instead.
// - VS Code is spawned directly (no shell) because test-electron's Windows
//   shell spawn breaks on paths containing spaces.
// - Throwaway user-data/extensions dirs keep the developer's profile untouched.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');

async function main() {
  const exe =
    process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable'));

  // When launched from inside VS Code (integrated terminal, AI agents running
  // in an extension host) the parent's VSCODE_* / ELECTRON_* variables leak
  // into the child and break its startup (e.g. ELECTRON_RUN_AS_NODE).
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(key)) delete env[key];
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-it-'));
  env.VAW_TEST_TEMP_DIR = tmp; // Project fixtures are removed after VS Code releases directory watchers.
  const workspaceFile = path.join(tmp, 'integration.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: path.join(root, 'demo-workspace') }], settings: {} }));
  const args = [
    workspaceFile,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'out', 'test', 'integration', 'index.js')}`,
    `--user-data-dir=${path.join(tmp, 'user-data')}`,
    `--extensions-dir=${path.join(tmp, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-sandbox',
    '--disable-gpu',
  ];
  console.log(`Launching ${exe}`);
  const code = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: 'inherit', shell: false });
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) || !path.basename(tmp).startsWith('vaw-it-')) {
    throw new Error('Refusing cleanup outside the generated integration test directory.');
  }
  // Windows can retain extension-host log handles briefly after the main process exits.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
