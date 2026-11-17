import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeAuthFromEnv, ClaudeAuthentication, ClaudeLoginStatus } from './ClaudeCodeAdapter';

export type ClaudeAuthMode = 'auto' | 'subscription' | 'api';
export interface ClaudeRuntime { executable?: string; env: NodeJS.ProcessEnv; authentication: ClaudeAuthentication }

export function locateClaude(configured?: string, userDir = os.homedir()): string | undefined {
  if (configured) return fs.existsSync(configured) && !/\.(cmd|bat|ps1)$/i.test(configured) ? configured : undefined;
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates: Array<{ version: string; file: string }> = [];
  for (const profile of ['.vscode', '.vscode-insiders']) {
    const directory = path.join(userDir, profile, 'extensions');
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!name.startsWith('anthropic.claude-code-')) continue;
        const file = path.join(directory, name, 'resources', 'native-binary', executable);
        if (fs.existsSync(file)) candidates.push({ version: name.slice('anthropic.claude-code-'.length), file });
      }
    } catch { /* Profile not installed. */ }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (candidates[0]) return candidates[0].file;
  return [path.join(userDir, '.local', 'bin', executable), ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, executable)))].find((file) => fs.existsSync(file));
}

/** Only child-process environment changes; user credentials/settings are never read or rewritten. */
export function claudeEnvironment(env: NodeJS.ProcessEnv, mode: ClaudeAuthMode): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) if (/^(VSCODE_|ELECTRON_)/i.test(key) || key === 'CLAUDECODE') delete copy[key];
  if (mode === 'subscription') {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD']) delete copy[key];
  }
  return copy;
}

/** The official CLI reports safe metadata; raw output and account identity are not retained. */
export async function claudeLoginStatus(executable: string, env: NodeJS.ProcessEnv): Promise<ClaudeLoginStatus> {
  try {
    const { stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], { env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const status = JSON.parse(stdout);
    return { loggedIn: status.loggedIn === true, authMethod: typeof status.authMethod === 'string' ? status.authMethod : undefined, subscriptionType: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined, apiProvider: typeof status.apiProvider === 'string' ? status.apiProvider : undefined };
  } catch { return { loggedIn: false }; }
}

export async function resolveClaudeRuntime(env: NodeJS.ProcessEnv, configured?: string, mode: ClaudeAuthMode = 'auto'): Promise<ClaudeRuntime> {
  let childEnv = claudeEnvironment(env, mode);
  const executable = locateClaude(configured);
  let authentication = claudeAuthFromEnv(childEnv);
  if (!authentication.ok && mode !== 'api' && executable) authentication = claudeAuthFromEnv(childEnv, await claudeLoginStatus(executable, childEnv));
  if (authentication.kind === 'subscription' && mode === 'auto' && executable) {
    childEnv = claudeEnvironment(env, 'subscription');
    authentication = claudeAuthFromEnv(childEnv, await claudeLoginStatus(executable, childEnv));
  }
  if (mode === 'subscription' && authentication.kind !== 'subscription') authentication = { ok: false, reason: '请先在官方 Claude Code 中登录订阅账号（claude auth login），然后重新检查。 / Sign in to your subscription through official Claude Code, then re-check providers.' };
  if (!executable) authentication = { ok: false, reason: 'Official Claude Code executable not found. Install the Claude Code VS Code extension or set visualAgent.claude.executablePath.' };
  return { executable, env: childEnv, authentication };
}
