import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const TRIPLES: Record<string, Record<string, [string, string]>> = {
  win32: { x64: ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'], arm64: ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'] },
  darwin: { x64: ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'], arm64: ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'] },
  linux: { x64: ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'], arm64: ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'] },
};

export interface CodexLocation {
  executable: string;
  /** Extra PATH entries the npm launcher normally adds (bundled rg etc.). */
  extraPath: string[];
  source: 'setting' | 'vscode-extension' | 'npm-global' | 'path';
}

/**
 * Find the native Codex binary so it can be spawned WITHOUT a shell.
 * (On Windows the npm shim is a .cmd file, which would require shell:true.)
 */
export function locateCodex(configuredPath?: string): CodexLocation | undefined {
  if (configuredPath) {
    return fs.existsSync(configuredPath) && !/\.(cmd|bat|ps1)$/i.test(configuredPath)
      ? { executable: configuredPath, extraPath: [], source: 'setting' }
      : undefined;
  }
  const entry = TRIPLES[process.platform]?.[process.arch];
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  // Prefer the runtime shipped with the current Codex VS Code extension.
  // A global npm installation can lag behind its model catalog.
  const bundled = findVSCodeCodex(os.homedir());
  if (bundled) {
    return { executable: bundled, extraPath: [], source: 'vscode-extension' };
  }
  for (const root of npmGlobalRoots()) {
    if (!entry) {
      break;
    }
    const [pkg, triple] = entry;
    for (const pkgDir of [path.join(root, '@openai', 'codex', 'node_modules', pkg), path.join(root, pkg)]) {
      const vendor = path.join(pkgDir, 'vendor', triple);
      const exe = path.join(vendor, 'bin', exeName);
      if (fs.existsSync(exe)) {
        const extra = path.join(vendor, 'codex-path');
        return { executable: exe, extraPath: fs.existsSync(extra) ? [extra] : [], source: 'npm-global' };
      }
    }
  }
  // Native binary directly on PATH (e.g. Homebrew / standalone install).
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const exe = path.join(dir, exeName);
    if (dir && fs.existsSync(exe)) {
      return { executable: exe, extraPath: [], source: 'path' };
    }
  }
  return undefined;
}

/** Find the newest installed Codex extension with a native binary. */
export function findVSCodeCodex(userDir: string, platform = process.platform, arch = process.arch): string | undefined {
  const target = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) return undefined;
  const candidates: Array<{ version: string; executable: string }> = [];
  for (const profile of ['.vscode', '.vscode-insiders']) {
    const root = path.join(userDir, profile, 'extensions');
    try {
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith('openai.chatgpt-')) continue;
        const executable = path.join(root, name, 'bin', target, platform === 'win32' ? 'codex.exe' : 'codex');
        if (fs.existsSync(executable)) candidates.push({ version: name.slice('openai.chatgpt-'.length), executable });
      }
    } catch { /* VS Code profile not installed or not readable. */ }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0]?.executable;
}

function npmGlobalRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules');
  try {
    const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === 'win32', // fixed arguments only, no user input
    }).trim();
    if (out) {
      roots.unshift(out);
    }
  } catch {
    /* npm not available */
  }
  return [...new Set(roots)];
}

/** Environment for the Codex child: inherit, minus VS Code/Electron internals. */
export function codexEnvironment(location: CodexLocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(key)) {
      delete env[key];
    }
  }
  if (location.extraPath.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [...location.extraPath, env[key] ?? ''].join(path.delimiter);
  }
  return env;
}
