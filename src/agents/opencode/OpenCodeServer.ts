import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { SENSITIVE_PATH } from '../toolMapping';

/** One OpenCode server connection (real process or test fake). */
export interface OpenCodeConnection {
  readonly version?: string;
  request<T = unknown>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', route: string, body?: unknown): Promise<T>;
  /** SSE event stream; resolves when the stream ends. */
  subscribe(onEvent: (ev: { type: string; properties: any }) => void, signal: AbortSignal): Promise<void>;
  onExit(listener: (detail: string) => void): void;
  close(): Promise<void>;
}

export interface OpenCodeLaunch {
  executable: string;
  /** Private XDG home for OpenCode state (never the user's ~/.config/opencode). */
  homeDir: string;
  workspaceRoot: string;
  ollamaBaseUrl: string;
  model: string;
  contextLimit: number;
  outputLimit: number;
  profile: 'read-only' | 'approved-write';
}

export type OpenCodeConnector = (launch: OpenCodeLaunch) => Promise<OpenCodeConnection>;

/** Find the native OpenCode binary (no shell shims). */
export function locateOpenCode(configured?: string, extensionRoot?: string): string | undefined {
  if (configured) {
    return fs.existsSync(configured) && !/\.(cmd|bat|ps1)$/i.test(configured) ? configured : undefined;
  }
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const candidates: string[] = [];
  if (extensionRoot) {
    candidates.push(path.join(extensionRoot, 'node_modules', 'opencode-ai', 'bin', exe));
  }
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === 'win32', // fixed arguments only
    }).trim();
    candidates.push(path.join(root, 'opencode-ai', 'bin', exe));
  } catch {
    /* npm unavailable */
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, exe));
    }
  }
  if (process.env.HOME || process.env.USERPROFILE) {
    candidates.push(path.join(process.env.HOME ?? process.env.USERPROFILE!, '.opencode', 'bin', exe));
  }
  return candidates.find((c) => fs.existsSync(c));
}

/**
 * Inline OpenCode config. Local-only: every provider except Ollama is
 * disabled, and the small/title model is pinned to the selected local model
 * (OpenCode would otherwise default to its own cloud models).
 */
export function buildOpenCodeConfig(l: Pick<OpenCodeLaunch, 'ollamaBaseUrl' | 'model' | 'contextLimit' | 'outputLimit' | 'profile'>): Record<string, unknown> {
  const sensitive: Record<string, 'deny'> = {};
  for (const p of ['*.env', '*.env.*', '.env', '.env.*', '*/.env', '*.pem', '*.key', '*.p12', '*.pfx', '*id_rsa*', '*id_ed25519*', '.git', '.git/*', '*/.git/*', '*.npmrc', '*.netrc', '*.pypirc']) {
    sensitive[p] = 'deny';
  }
  const write = l.profile === 'approved-write';
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    enabled_providers: ['ollama'],
    disabled_providers: ['opencode'],
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL: `${l.ollamaBaseUrl.replace(/\/+$/, '')}/v1` },
        models: { [l.model]: { name: l.model, tool_call: true, limit: { context: l.contextLimit, output: l.outputLimit } } },
      },
    },
    model: `ollama/${l.model}`,
    small_model: `ollama/${l.model}`,
    permission: {
      read: { '*': 'allow', ...sensitive },
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: write ? { '*': 'ask', ...sensitive } : 'deny',
      bash: write ? 'ask' : 'deny',
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      question: 'deny',
      skill: 'deny',
      doom_loop: 'deny',
      todowrite: 'allow',
    },
  };
}

export function isSensitiveRelative(rel: string): boolean {
  return SENSITIVE_PATH.test(rel.replace(/\\/g, '/'));
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Production connector: a dedicated `opencode serve` on loopback, isolated home, no shell. */
export const startOpenCodeServer: OpenCodeConnector = async (l) => {
  fs.mkdirSync(l.homeDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_|OPENCODE_)/i.test(k)) {
      delete env[k];
    }
  }
  Object.assign(env, {
    XDG_CONFIG_HOME: path.join(l.homeDir, 'config'),
    XDG_DATA_HOME: path.join(l.homeDir, 'data'),
    XDG_CACHE_HOME: path.join(l.homeDir, 'cache'),
    XDG_STATE_HOME: path.join(l.homeDir, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeConfig(l)),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  });
  const port = await freePort();
  const child = spawn(l.executable, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--pure'], {
    cwd: l.workspaceRoot,
    env,
    shell: false,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-4000)));
  const exitListeners: Array<(d: string) => void> = [];
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, sig) => {
      exitListeners.forEach((f) => f(`opencode exited (code ${code ?? 'null'}${sig ? `, ${sig}` : ''})${stderr ? `: ${stderr.trim().slice(-500)}` : ''}`));
      resolve();
    });
    child.once('error', (e) => {
      exitListeners.forEach((f) => f(`opencode failed to start: ${e.message}`));
      resolve();
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited during startup: ${stderr.trim().slice(-500)}`);
    }
    try {
      const r = await fetch(`${base}/global/health`);
      if (r.ok) {
        break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 30_000) {
      child.kill();
      throw new Error('OpenCode server did not become ready within 30 s.');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return httpConnection(base, l.workspaceRoot, child, exited, exitListeners);
};

function httpConnection(
  base: string,
  directory: string,
  child: ChildProcess,
  exited: Promise<void>,
  exitListeners: Array<(d: string) => void>,
): OpenCodeConnection {
  const q = (route: string) => `${base}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}`;
  return {
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      const r = await fetch(q(route), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        throw new Error(`OpenCode ${method} ${route} → ${r.status}: ${text.slice(0, 300)}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async subscribe(onEvent, signal) {
      const r = await fetch(q('/event'), { signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            return;
          }
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (data) {
              try {
                onEvent(JSON.parse(data));
              } catch {
                /* ignore malformed event */
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          throw err;
        }
      }
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    async close() {
      if (child.exitCode === null) {
        child.kill();
      }
      let t: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => (t = setTimeout(r, 5000)))]);
      clearTimeout(t);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}
