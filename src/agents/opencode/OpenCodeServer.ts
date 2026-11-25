import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
  /** Release this connection. A managed server keeps running for reuse; a one-shot server is stopped. */
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
    compaction: { auto: true },
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

// ------------------------------------------------------------------ process helpers (shared by the manager)

/** Everything that determines a server's behaviour. A server is reused only for an identical key. */
export function serverKey(l: OpenCodeLaunch): string {
  return createHash('sha256').update(JSON.stringify([path.resolve(l.executable), path.resolve(l.homeDir), buildOpenCodeConfig(l)])).digest('hex');
}

export function newServerPassword(): string {
  return randomBytes(24).toString('hex');
}

/** HTTP Basic credentials for OPENCODE_SERVER_PASSWORD (user "opencode"). */
export function authHeader(password: string): string {
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

export interface ServerEndpoint {
  base: string;
  /** Authorization header value. */
  auth: string;
}

export function serverEnv(l: OpenCodeLaunch, password: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_|OPENCODE_)/i.test(k)) {
      delete env[k];
    }
  }
  return Object.assign(env, {
    XDG_CONFIG_HOME: path.join(l.homeDir, 'config'),
    XDG_DATA_HOME: path.join(l.homeDir, 'data'),
    XDG_CACHE_HOME: path.join(l.homeDir, 'cache'),
    XDG_STATE_HOME: path.join(l.homeDir, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeConfig(l)),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // Only clients holding this password (this extension) can use the server, even on loopback.
    OPENCODE_SERVER_PASSWORD: password,
  });
}

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export function spawnServer(l: OpenCodeLaunch, port: number, password: string): ChildProcess {
  fs.mkdirSync(l.homeDir, { recursive: true });
  return spawn(l.executable, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--pure'], {
    cwd: l.workspaceRoot && fs.existsSync(l.workspaceRoot) ? l.workspaceRoot : l.homeDir,
    env: serverEnv(l, password),
    shell: false,
    windowsHide: true,
  });
}

/** GET /global/health with our credentials. undefined = not reachable, not ours, or unhealthy. */
export async function probeHealth(ep: ServerEndpoint, timeoutMs = 3000): Promise<{ version?: string } | undefined> {
  try {
    const r = await fetch(`${ep.base}/global/health`, { headers: { authorization: ep.auth }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { healthy?: boolean; version?: string };
    return body?.healthy === false ? undefined : { version: body?.version };
  } catch {
    return undefined;
  }
}

/** The running server really uses our local-only config (model, providers, permission profile). Returns a mismatch, or undefined. */
export async function verifyServerConfig(ep: ServerEndpoint, l: OpenCodeLaunch): Promise<string | undefined> {
  try {
    const r = await fetch(`${ep.base}/config`, { headers: { authorization: ep.auth }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return `GET /config → ${r.status}`;
    const c = (await r.json()) as { model?: string; enabled_providers?: string[]; permission?: { edit?: unknown; bash?: unknown } };
    const want = buildOpenCodeConfig(l) as { model: string; permission: { edit: unknown; bash: unknown } };
    if (c.model !== want.model) return `model is ${c.model}, expected ${want.model}`;
    if (JSON.stringify(c.enabled_providers) !== JSON.stringify(['ollama'])) return `providers are ${JSON.stringify(c.enabled_providers)}, expected only ollama`;
    if (JSON.stringify(c.permission?.edit) !== JSON.stringify(want.permission.edit) || JSON.stringify(c.permission?.bash) !== JSON.stringify(want.permission.bash)) return 'edit/bash permissions differ from the selected profile';
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stop a server process we started, including its child processes (Windows: taskkill /T). */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

/** A connection to an authenticated server. `hooks.close` decides what releasing it means. */
export function httpConnection(
  ep: ServerEndpoint,
  directory: string,
  version: string | undefined,
  hooks: { onExit(listener: (detail: string) => void): void; close(): Promise<void> },
): OpenCodeConnection {
  const q = (route: string) => `${ep.base}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}`;
  return {
    version,
    async request<T>(method: string, route: string, body?: unknown): Promise<T> {
      const r = await fetch(q(route), {
        method,
        signal: AbortSignal.timeout(15000),
        headers: { authorization: ep.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        throw new Error(`OpenCode ${method} ${route} → ${r.status}: ${text.slice(0, 300)}`);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async subscribe(onEvent, signal) {
      const r = await fetch(q('/event'), { signal, headers: { authorization: ep.auth } });
      if (!r.ok || !r.body) throw new Error(`OpenCode event stream → ${r.status}`);
      const reader = r.body.getReader();
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
    onExit: (listener) => hooks.onExit(listener),
    close: () => hooks.close(),
  };
}

/**
 * One-shot connector (standalone scripts): a dedicated `opencode serve` on
 * loopback, isolated home, password-protected, no shell; stopped on close().
 * The extension itself uses OpenCodeServerManager (shared, monitored server).
 */
export const startOpenCodeServer: OpenCodeConnector = async (l) => {
  const port = await freePort();
  const password = newServerPassword();
  const child = spawnServer(l, port, password);
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
  const ep: ServerEndpoint = { base: `http://127.0.0.1:${port}`, auth: authHeader(password) };
  const started = Date.now();
  let health: { version?: string } | undefined;
  while (!(health = await probeHealth(ep, 1000))) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited during startup: ${stderr.trim().slice(-500)}`);
    if (Date.now() - started > 30_000) {
      child.kill();
      throw new Error('OpenCode server did not become ready within 30 s.');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return httpConnection(ep, l.workspaceRoot, health.version, {
    onExit: (f) => exitListeners.push(f),
    async close() {
      if (child.exitCode === null) child.kill();
      let t: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>((r) => (t = setTimeout(r, 5000)))]);
      clearTimeout(t);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  });
};
