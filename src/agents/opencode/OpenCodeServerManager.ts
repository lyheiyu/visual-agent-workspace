import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  authHeader,
  freePort,
  httpConnection,
  killProcessTree,
  newServerPassword,
  OpenCodeConnection,
  OpenCodeConnector,
  OpenCodeLaunch,
  probeHealth,
  processAlive,
  ServerEndpoint,
  serverKey,
  spawnServer,
  verifyServerConfig,
} from './OpenCodeServer';

/**
 * Lifecycle of the local OpenCode server (one per VS Code window).
 *
 * - Started automatically when a local-agent task needs it; tasks never wait
 *   on a server that is not answering /global/health with our credentials.
 * - Reused while healthy and the settings (model, profile, limits) are the
 *   same; never two servers for the same settings.
 * - Owned: only a process this manager started (recorded with its PID, port
 *   and a random password) is ever stopped. A recorded process is re-adopted
 *   after an extension restart only if it answers with that password.
 * - Monitored: an unexpected exit or 3 failed health checks → Error, then an
 *   automatic restart (at most 3 within 5 minutes); Restart is always manual-able.
 * - No model requests: only /global/health and /config are called here.
 */

export type ServerState = 'Stopped' | 'Starting' | 'Running' | 'Error';

export interface ServerStatus {
  state: ServerState;
  /** Human-readable detail (error, reason for stopping, …). */
  message?: string;
  pid?: number;
  port?: number;
  version?: string;
  /** Re-adopted from an earlier extension session (no process handle). */
  adopted?: boolean;
  startedAt?: string;
  model?: string;
  profile?: string;
  /** Active connections (tasks using the server). */
  connections: number;
  restarts: number;
}

interface Record {
  pid: number;
  port: number;
  password: string;
  key: string;
  executable: string;
  model: string;
  profile: string;
  startedAt: string;
  version?: string;
}

interface Current {
  rec: Record;
  ep: ServerEndpoint;
  child?: ChildProcess;
  stopping: boolean;
  healthFails: number;
}

interface Lease {
  exitListeners: Array<(detail: string) => void>;
}

export interface ServerManagerOptions {
  /** Where the owned server is recorded (extension storage). */
  stateFile: string;
  log: (line: string) => void;
  /** Stop the server after this long without connections. 0 = keep running. Default 15 min. */
  idleStopMs?: number;
  healthIntervalMs?: number;
  readyTimeoutMs?: number;
  maxAutoRestarts?: number;
}

const AUTO_RESTART_WINDOW_MS = 5 * 60_000;

export class OpenCodeServerManager {
  private current: Current | undefined;
  private readonly leases = new Set<Lease>();
  private queue: Promise<unknown> = Promise.resolve();
  private statusValue: ServerStatus = { state: 'Stopped', connections: 0, restarts: 0 };
  private readonly listeners = new Set<(s: ServerStatus) => void>();
  private lastLaunch: OpenCodeLaunch | undefined;
  private autoRestarts: number[] = [];
  private healthTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly opts: ServerManagerOptions) {}

  /** Use as the OpenCode adapter's connector. */
  readonly connector: OpenCodeConnector = (l) => this.connect(l);

  status(): ServerStatus {
    return { ...this.statusValue, connections: this.leases.size };
  }

  onStatus(listener: (s: ServerStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The settings of the last server request (for Restart / Start without a task). */
  hasLaunch(): boolean {
    return !!this.lastLaunch;
  }

  /** Ensure a healthy server for these settings, then hand out a connection (a lease). */
  async connect(l: OpenCodeLaunch): Promise<OpenCodeConnection> {
    const cur = await this.ensure(l);
    const lease: Lease = { exitListeners: [] };
    this.leases.add(lease);
    this.clearIdle();
    this.emit();
    let released = false;
    return httpConnection(cur.ep, l.workspaceRoot, cur.rec.version, {
      onExit: (f) => lease.exitListeners.push(f),
      close: async () => {
        if (released) return;
        released = true;
        this.leases.delete(lease);
        this.scheduleIdle();
        this.emit();
      },
    });
  }

  /** Start (or reuse / re-adopt) a server for these settings. Serialized. */
  ensure(l: OpenCodeLaunch): Promise<Current> {
    return this.serialize(() => this.ensureNow(l));
  }

  /** Stop the owned server and start it again with the last settings. */
  restart(reason = 'restart requested'): Promise<void> {
    return this.serialize(async () => {
      if (!this.lastLaunch) throw new Error('There are no local-agent settings yet. Start a local-agent task first; the server then starts automatically.');
      this.autoRestarts = [];
      await this.stopNow(reason);
      await this.startNow(this.lastLaunch);
    });
  }

  /** Stop the server if this manager owns it. Connections in use fail with `reason`. */
  stop(reason = 'stopped by the user'): Promise<void> {
    return this.serialize(() => this.stopNow(reason));
  }

  /** Extension deactivation: stop the owned server synchronously. */
  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    if (this.healthTimer) clearInterval(this.healthTimer);
    const cur = this.current;
    if (!cur) return;
    cur.stopping = true;
    this.current = undefined;
    // Synchronous here: our own child if it is still running; an adopted one only while the record still names it.
    const ours = cur.child ? cur.child.exitCode === null && cur.child.signalCode === null : this.readRecord()?.pid === cur.rec.pid && this.readRecord()?.password === cur.rec.password && processAlive(cur.rec.pid);
    if (!ours) return;
    this.opts.log(`[opencode] stopping server pid ${cur.rec.pid} (extension shutting down)`);
    killProcessTree(cur.rec.pid);
    this.removeRecord(cur.rec.pid);
  }

  /** Only a process this manager can still prove it owns is ever stopped (PIDs can be reused). */
  private async owned(cur: Current): Promise<boolean> {
    if (cur.child) return cur.child.exitCode === null && cur.child.signalCode === null;
    return processAlive(cur.rec.pid) && !!(await probeHealth(cur.ep, 2000));
  }

  // ------------------------------------------------------------ internals

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setStatus(next: Partial<ServerStatus> & { state: ServerState }): void {
    this.statusValue = { connections: this.leases.size, restarts: this.statusValue.restarts, ...next };
    this.emit();
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        /* listener errors must not affect the server */
      }
    }
  }

  private runningStatus(cur: Current, adopted: boolean): void {
    this.setStatus({ state: 'Running', pid: cur.rec.pid, port: cur.rec.port, version: cur.rec.version, adopted, startedAt: cur.rec.startedAt, model: cur.rec.model, profile: cur.rec.profile });
  }

  private async ensureNow(l: OpenCodeLaunch): Promise<Current> {
    if (this.disposed) throw new Error('The extension is shutting down.');
    const key = serverKey(l);
    this.lastLaunch = l;
    if (this.current) {
      const cur = this.current;
      if (cur.rec.key === key && (await probeHealth(cur.ep))) {
        this.opts.log(`[opencode] reusing running server pid ${cur.rec.pid} on port ${cur.rec.port}`);
        return cur;
      }
      if (cur.rec.key !== key && this.leases.size) {
        throw new Error('The OpenCode server is in use by another local-agent session with different settings. Finish that session first.');
      }
      await this.stopNow(cur.rec.key !== key ? 'settings changed (model, profile or limits)' : 'not responding');
    }
    const adopted = await this.tryAdopt(key, l);
    if (adopted) return adopted;
    return this.startNow(l);
  }

  /** Re-use the server this extension started in an earlier session (e.g. after a reload or a crashed extension host). */
  private async tryAdopt(key: string, l: OpenCodeLaunch): Promise<Current | undefined> {
    const rec = this.readRecord();
    if (!rec) return undefined;
    const ep: ServerEndpoint = { base: `http://127.0.0.1:${rec.port}`, auth: authHeader(rec.password) };
    if (!processAlive(rec.pid)) {
      this.opts.log(`[opencode] recorded server pid ${rec.pid} is no longer running`);
      this.removeRecord(rec.pid);
      return undefined;
    }
    const health = await probeHealth(ep);
    if (!health) {
      // Not answering with our password: the PID may belong to another program now. Never stop it.
      this.opts.log(`[opencode] recorded pid ${rec.pid} does not answer on port ${rec.port} with this extension's credentials; leaving it alone`);
      this.removeRecord(rec.pid);
      return undefined;
    }
    if (rec.key !== key || (await verifyServerConfig(ep, l))) {
      // It is ours (it knows the password) but runs other settings: replace it.
      this.opts.log(`[opencode] stopping the earlier server pid ${rec.pid}: its settings differ`);
      killProcessTree(rec.pid);
      await this.waitGone(rec.pid, ep);
      this.removeRecord(rec.pid);
      return undefined;
    }
    rec.version = health.version ?? rec.version;
    const cur: Current = { rec, ep, stopping: false, healthFails: 0 };
    this.current = cur;
    this.opts.log(`[opencode] re-adopted server pid ${rec.pid} on port ${rec.port} (started ${rec.startedAt}) instead of starting a duplicate`);
    this.runningStatus(cur, true);
    this.startHealthChecks();
    return cur;
  }

  private async startNow(l: OpenCodeLaunch, attempt = 1): Promise<Current> {
    if (!fs.existsSync(l.executable)) {
      const message = `OpenCode executable not found: ${l.executable}. Install it (npm install -g opencode-ai) or set visualAgent.local.opencodePath.`;
      this.setStatus({ state: 'Error', message });
      throw new Error(message);
    }
    this.setStatus({ state: 'Starting', model: l.model, profile: l.profile, message: attempt > 1 ? `retry ${attempt}` : undefined });
    const port = await freePort();
    const password = newServerPassword();
    const t0 = Date.now();
    const child = spawnServer(l, port, password);
    const startedAt = new Date().toISOString();
    let tail = '';
    let spawnError: string | undefined;
    child.once('error', (e) => (spawnError = e.message));
    const onOutput = (d: Buffer) => {
      const text = String(d).replace(/\x1b\[[0-9;]*m/g, '');
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) this.opts.log(`[opencode:${child.pid ?? '?'}] ${line.trim().slice(0, 300)}`);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    if (!child.pid) {
      await new Promise((r) => setTimeout(r, 50));
      const message = `Could not start OpenCode (${l.executable}): ${spawnError ?? 'no process id'}`;
      this.setStatus({ state: 'Error', message });
      throw new Error(message);
    }
    const rec: Record = { pid: child.pid, port, password, key: serverKey(l), executable: l.executable, model: l.model, profile: l.profile, startedAt };
    const ep: ServerEndpoint = { base: `http://127.0.0.1:${port}`, auth: authHeader(password) };
    this.writeRecord(rec); // recorded before it is ready, so a crashed extension host can still find and stop it
    this.opts.log(`[opencode] starting ${path.basename(l.executable)} serve on 127.0.0.1:${port} (pid ${child.pid}, model ${l.model}, profile ${l.profile})`);
    const deadline = t0 + (this.opts.readyTimeoutMs ?? 30_000);
    let health: { version?: string } | undefined;
    while (!(health = await probeHealth(ep, 1000))) {
      if (child.exitCode !== null || child.signalCode !== null || spawnError) {
        this.removeRecord(rec.pid);
        const detail = (spawnError ?? tail.trim().slice(-500)) || `exit code ${child.exitCode}`;
        // A port taken between choosing and binding: try once more on another port.
        if (attempt === 1 && /ServeError|EADDRINUSE|address already in use/i.test(detail)) return this.startNow(l, 2);
        const message = `OpenCode server exited during startup: ${detail}`;
        this.setStatus({ state: 'Error', message });
        this.opts.log(`[opencode] ${message}`);
        throw new Error(message);
      }
      if (Date.now() > deadline) {
        killProcessTree(child.pid);
        this.removeRecord(rec.pid);
        const message = `OpenCode server did not become ready within ${Math.round((this.opts.readyTimeoutMs ?? 30_000) / 1000)} s.${tail ? ` Output: ${tail.trim().slice(-300)}` : ''}`;
        this.setStatus({ state: 'Error', message });
        this.opts.log(`[opencode] ${message}`);
        throw new Error(message);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const mismatch = await verifyServerConfig(ep, l);
    if (mismatch) {
      killProcessTree(child.pid);
      this.removeRecord(rec.pid);
      const message = `OpenCode did not load the local-only configuration (${mismatch}); it was stopped.`;
      this.setStatus({ state: 'Error', message });
      throw new Error(message);
    }
    rec.version = health.version;
    this.writeRecord(rec);
    const cur: Current = { rec, ep, child, stopping: false, healthFails: 0 };
    this.current = cur;
    child.once('exit', (code, sig) => this.onExit(cur, `exit code ${code ?? 'null'}${sig ? `, ${sig}` : ''}${tail.trim() ? `: ${tail.trim().slice(-300)}` : ''}`));
    this.opts.log(`[opencode] ready in ${Date.now() - t0} ms (OpenCode ${health.version ?? '?'}, pid ${child.pid})`);
    this.runningStatus(cur, false);
    this.startHealthChecks();
    return cur;
  }

  private async stopNow(reason: string): Promise<void> {
    this.clearIdle();
    const cur = this.current;
    if (!cur) {
      if (this.statusValue.state !== 'Stopped') this.setStatus({ state: 'Stopped', message: reason });
      return;
    }
    cur.stopping = true;
    this.current = undefined;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.failLeases(`The local OpenCode server was stopped (${reason}).`);
    if (await this.owned(cur)) {
      this.opts.log(`[opencode] stopping server pid ${cur.rec.pid} (${reason})`);
      killProcessTree(cur.rec.pid);
      await this.waitGone(cur.rec.pid, cur.ep);
    } else {
      this.opts.log(`[opencode] server pid ${cur.rec.pid} is already gone or no longer ours; nothing to stop`);
    }
    this.removeRecord(cur.rec.pid);
    this.setStatus({ state: 'Stopped', message: reason });
  }

  private onExit(cur: Current, detail: string): void {
    if (cur.stopping || this.current !== cur) return;
    this.current = undefined;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.removeRecord(cur.rec.pid);
    const message = `OpenCode server stopped unexpectedly (${detail}).`;
    this.opts.log(`[opencode] ${message}`);
    this.failLeases(`${message} It is being restarted; send your message again to continue the same session.`);
    this.setStatus({ state: 'Error', message, model: cur.rec.model, profile: cur.rec.profile });
    this.autoRecover();
  }

  private autoRecover(): void {
    if (this.disposed || !this.lastLaunch) return;
    const now = Date.now();
    this.autoRestarts = this.autoRestarts.filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
    const max = this.opts.maxAutoRestarts ?? 3;
    if (this.autoRestarts.length >= max) {
      const message = `${this.statusValue.message ?? 'OpenCode server failed'} Automatic restart stopped after ${max} attempts in 5 minutes; use "Restart OpenCode server".`;
      this.opts.log(`[opencode] ${message}`);
      this.setStatus({ ...this.statusValue, state: 'Error', message });
      return;
    }
    this.autoRestarts.push(now);
    const launch = this.lastLaunch;
    this.opts.log(`[opencode] restarting automatically (attempt ${this.autoRestarts.length}/${max})`);
    this.statusValue = { ...this.statusValue, restarts: this.statusValue.restarts + 1 };
    void this.serialize(async () => {
      if (this.current || this.disposed) return;
      await this.startNow(launch);
    }).catch((err) => this.opts.log(`[opencode] automatic restart failed: ${(err as Error).message}`));
  }

  private failLeases(detail: string): void {
    for (const lease of this.leases) for (const f of lease.exitListeners.splice(0)) f(detail);
  }

  private startHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const interval = this.opts.healthIntervalMs ?? 5000;
    this.healthTimer = setInterval(() => void this.healthCheck(), interval);
    this.healthTimer.unref?.();
  }

  private async healthCheck(): Promise<void> {
    const cur = this.current;
    if (!cur || cur.stopping) return;
    const ok = await probeHealth(cur.ep, 3000);
    if (this.current !== cur) return;
    if (ok) {
      cur.healthFails = 0;
      return;
    }
    cur.healthFails++;
    this.opts.log(`[opencode] health check failed (${cur.healthFails}/3) for pid ${cur.rec.pid}`);
    if (cur.healthFails < 3) return;
    if (cur.child && cur.child.exitCode === null && cur.child.signalCode === null) {
      // Hung: stop our own child; its exit handler reports and recovers.
      this.opts.log(`[opencode] pid ${cur.rec.pid} is not responding; stopping it`);
      killProcessTree(cur.rec.pid);
      return;
    }
    this.onExit(cur, processAlive(cur.rec.pid) ? 'not responding to health checks' : 'process is gone');
  }

  private scheduleIdle(): void {
    this.clearIdle();
    const ms = this.opts.idleStopMs ?? 15 * 60_000;
    if (!ms || this.leases.size || !this.current) return;
    this.idleTimer = setTimeout(() => void this.serialize(async () => {
      if (!this.leases.size && this.current) await this.stopNow(`idle for ${Math.round(ms / 60_000)} min`);
    }), ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async waitGone(pid: number, ep: ServerEndpoint): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (!processAlive(pid) && !(await probeHealth(ep, 300))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.opts.log(`[opencode] pid ${pid} still running 5 s after stopping it`);
  }

  private readRecord(): Record | undefined {
    try {
      const r = JSON.parse(fs.readFileSync(this.opts.stateFile, 'utf8')) as Record;
      return Number.isInteger(r.pid) && Number.isInteger(r.port) && typeof r.password === 'string' && typeof r.key === 'string' ? r : undefined;
    } catch {
      return undefined;
    }
  }

  private writeRecord(rec: Record): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      fs.writeFileSync(this.opts.stateFile, JSON.stringify(rec), { mode: 0o600 });
    } catch (err) {
      this.opts.log(`[opencode] could not record the server: ${(err as Error).message}`);
    }
  }

  private removeRecord(pid: number): void {
    if (this.readRecord()?.pid !== pid) return;
    try {
      fs.rmSync(this.opts.stateFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}
