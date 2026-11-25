#!/usr/bin/env node
// Manual UI check: opens a real Extension Development Host (visible window)
// with a fixture multi-file proposal and waits until `<dir>/done` exists.
// Drive it with the real mouse/keyboard (or scripts/lib/ui-driver.ps1).
//   node scripts/run-ui-check.js <dir>
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');

async function main() {
  const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-ui-ctl-')));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['ready', 'done', 'state.jsonl', 'summary.json']) fs.rmSync(path.join(dir, f), { force: true });
  const exe = process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable'));
  const env = { ...process.env, VAW_UI_DIR: dir };
  for (const key of Object.keys(env)) if (/^(VSCODE_|ELECTRON_)/i.test(key)) delete env[key];
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-ui-project-')));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text); };
  w('src/math.js', 'export function divide(a, b) {\n  return a / b;\n}\n');
  w('src/format.js', 'export const money = (n) => n.toFixed(2);\n');
  w('src/strings.js', 'export const upper = (s) => s.toUpperCase();\n');
  w('legacy.js', '// old entry point\nmodule.exports = {};\n');
  for (const a of [['init', '-q'], ['config', 'user.email', 'ui@example.invalid'], ['config', 'user.name', 'UI check'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) execFileSync('git', a, { cwd: project });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-ui-host-'));
  console.log(`UI project: ${project}\nControl dir: ${dir}`);
  const args = [project, `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'out', 'test', 'ui-check', 'index.js')}`, `--user-data-dir=${path.join(tmp, 'user-data')}`, `--extensions-dir=${path.join(tmp, 'extensions')}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'];
  const code = await new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: 'inherit', shell: false });
    child.on('error', (error) => { console.error(`UI host failed to launch: ${error.message}`); resolve(1); });
    child.on('exit', (c, signal) => {
      console.log(`UI host exited: code=${c}, signal=${signal ?? 'none'}`);
      resolve(c ?? 1);
    });
  });
  console.log(`\ngit status of the UI project:\n${execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: project, encoding: 'utf8' }) || '(clean)'}`);
  process.exit(code);
}
main().catch((e) => { console.error(e); process.exit(1); });
