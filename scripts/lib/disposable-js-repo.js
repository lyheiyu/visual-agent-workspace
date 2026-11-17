// Disposable git repo with a tiny Node project (Python is not required).
// Used by local-agent tests: the agent can read, edit and run `node test.js`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILES = {
  'math.js': `// Small math helpers.

function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, divide };
`,
  'test.js': `const assert = require('node:assert');
const { add, divide } = require('./math');

assert.strictEqual(add(2, 3), 5);
assert.strictEqual(divide(6, 3), 2);
assert.throws(() => divide(1, 0), /division by zero/);
console.log('all tests passed');
`,
  'README.md': '# demo\n\nRun tests with `node test.js`.\n',
  '.env': 'SECRET_TOKEN=do-not-touch\n',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function createDisposableJsRepo(prefix = 'vaw-local-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [f, c] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, f), c);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Visual Agent Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return {
    dir,
    status: () => git(dir, 'status', '--porcelain', '--untracked-files=all'),
    diff: () => git(dir, 'diff'),
    dispose: async () => {
      for (let i = 0; i < 40; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    },
  };
}

module.exports = { createDisposableJsRepo };
