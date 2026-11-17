import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeEnvironment, locateClaude } from '../agents/claude/claudeRuntime';

test('subscription child env removes API/cloud/proxy overrides without changing the user environment', () => {
  const original = { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDECODE: '1', VSCODE_TEST: '1', PATH: 'keep' };
  const child = claudeEnvironment(original, 'subscription');
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.ANTHROPIC_BASE_URL, undefined);
  assert.equal(child.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(child.CLAUDECODE, undefined);
  assert.equal(child.PATH, 'keep');
  assert.equal(original.ANTHROPIC_API_KEY, 'secret');
  assert.equal(claudeEnvironment(original, 'auto').ANTHROPIC_API_KEY, 'secret');
});

test('Claude locator finds newest official extension binary and respects explicit executable selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-claude-locator-'));
  try {
    const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const install = (version: string) => {
      const dir = path.join(root, '.vscode', 'extensions', `anthropic.claude-code-${version}`, 'resources', 'native-binary');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, executable); fs.writeFileSync(file, ''); return file;
    };
    install('2.1.9'); const latest = install('2.1.326');
    assert.equal(locateClaude(undefined, root), latest);
    assert.equal(locateClaude(latest, root), latest);
    assert.equal(locateClaude(path.join(root, 'missing.exe'), root), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
