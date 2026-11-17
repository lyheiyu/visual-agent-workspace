import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findVSCodeCodex, locateCodex } from '../adapters/codex/codexLocator';

test('Codex discovery picks the newest installed extension with a binary; explicit path wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-locator-'));
  try {
    const install = (version: string, binary: boolean) => {
      const dir = path.join(root, '.vscode', 'extensions', `openai.chatgpt-${version}-win32-x64`, 'bin', 'windows-x86_64');
      fs.mkdirSync(dir, { recursive: true });
      const exe = path.join(dir, 'codex.exe');
      if (binary) fs.writeFileSync(exe, '');
      return exe;
    };
    install('26.9.0', true);
    const latest = install('26.11.0', true);
    install('26.12.0', false);
    assert.equal(findVSCodeCodex(root, 'win32', 'x64'), latest);
    assert.equal(findVSCodeCodex(root, 'win32', 'arm64'), undefined);
    assert.equal(locateCodex(latest)?.source, 'setting');
    assert.equal(locateCodex(latest)?.executable, latest);
    assert.equal(locateCodex(path.join(root, 'missing.exe')), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
