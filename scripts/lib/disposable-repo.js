// Creates a throwaway git repository (outside this project) seeded with the
// demo fixture, for real-agent tests. Never touches demo-workspace/ itself.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE = path.resolve(__dirname, '..', '..', 'demo-workspace');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function createDisposableRepo(prefix = 'vaw-codex-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.cpSync(FIXTURE, dir, {
    recursive: true,
    filter: (src) => !/(__pycache__|\.pytest_cache)/.test(src),
  });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Visual Agent Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return {
    dir,
    /** `git status --porcelain` (empty string = clean). Includes untracked files. */
    status: () => git(dir, 'status', '--porcelain', '--untracked-files=all'),
    diff: () => git(dir, 'diff'),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 250 }),
  };
}

module.exports = { createDisposableRepo };
