import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { Emitter } from '../../util/emitter';
import { RequestId, RpcMessage, RpcNotification, RpcRequest, RpcResponse } from './protocol';

/** A bidirectional line transport (stdio in production, in-memory in tests). */
export interface LineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (info: { code: number | null; detail: string }) => void): void;
  close(): void;
  /** Resolves once the underlying process (if any) has exited. */
  whenExited?(timeoutMs: number): Promise<void>;
}

export type ServerRequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * JSON-RPC client for `codex app-server`.
 *
 * - Correlates responses to requests by id.
 * - Routes server→client requests (approvals etc.) to a single handler and
 *   ALWAYS answers them; a handler error becomes a JSON-RPC error response
 *   so Codex never waits forever.
 * - Never throws on malformed or unknown messages; they are reported via
 *   `onProtocolNote`.
 */
export class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    RequestId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string }
  >();
  private requestHandler: ServerRequestHandler | undefined;
  private closed = false;

  private readonly notificationEmitter = new Emitter<RpcNotification>();
  readonly onNotification = this.notificationEmitter.event;
  private readonly closeEmitter = new Emitter<{ code: number | null; detail: string }>();
  readonly onClose = this.closeEmitter.event;
  private readonly noteEmitter = new Emitter<string>();
  readonly onProtocolNote = this.noteEmitter.event;
  /** Raw traffic tap, for trace recording. */
  private readonly trafficEmitter = new Emitter<{ direction: 'in' | 'out'; message: RpcMessage }>();
  readonly onTraffic = this.trafficEmitter.event;

  constructor(private readonly transport: LineTransport) {
    transport.onLine((line) => this.receive(line));
    transport.onClose((info) => this.handleClose(info));
  }

  setRequestHandler(handler: ServerRequestHandler): void {
    this.requestHandler = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Codex app-server is not running (calling ${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry = { resolve: resolve as (v: unknown) => void, reject, method, timer: undefined as NodeJS.Timeout | undefined };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex request ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.write({ method, params });
    }
  }

  /** Close the connection and wait (bounded) for the server process to exit. */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.closed) {
      this.transport.close();
      this.handleClose({ code: null, detail: 'closed by client' });
    }
    await this.transport.whenExited?.(timeoutMs);
  }

  // ------------------------------------------------------------ internals

  private write(message: RpcMessage): void {
    this.trafficEmitter.fire({ direction: 'out', message });
    this.transport.send(JSON.stringify(message));
  }

  private receive(line: string): void {
    if (!line.trim()) {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.noteEmitter.fire(`Ignoring non-JSON line from Codex: ${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object') {
      return;
    }
    this.trafficEmitter.fire({ direction: 'in', message: msg as unknown as RpcMessage });
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    const hasMethod = typeof msg.method === 'string';

    if (hasId && hasMethod) {
      void this.answerServerRequest(msg as unknown as RpcRequest);
    } else if (hasMethod) {
      this.notificationEmitter.fire(msg as unknown as RpcNotification);
    } else if (hasId) {
      this.settle(msg as unknown as RpcResponse);
    } else {
      this.noteEmitter.fire('Ignoring message without id or method');
    }
  }

  private settle(res: RpcResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) {
      this.noteEmitter.fire(`Response for unknown request id ${String(res.id)}`);
      return;
    }
    this.pending.delete(res.id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    if (res.error) {
      entry.reject(new RpcError(`${entry.method}: ${res.error.message}`, res.error.code, res.error.data));
    } else {
      entry.resolve(res.result);
    }
  }

  private async answerServerRequest(req: RpcRequest): Promise<void> {
    try {
      if (!this.requestHandler) {
        throw new RpcError(`No handler for ${req.method}`, -32601);
      }
      const result = await this.requestHandler(req.method, req.params, req.id);
      if (!this.closed) {
        this.write({ id: req.id, result } as RpcResponse);
      }
    } catch (err) {
      if (!this.closed) {
        const code = err instanceof RpcError ? err.code : -32603;
        this.write({ id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    }
  }

  private handleClose(info: { code: number | null; detail: string }): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(new Error(`Codex app-server exited (${info.detail}) during ${entry.method}`));
    }
    this.pending.clear();
    this.closeEmitter.fire(info);
  }
}

/**
 * Spawns `codex app-server` over stdio. No shell is used, so arguments are
 * never re-parsed. stderr is kept (tail only) for diagnostics.
 */
export class StdioTransport implements LineTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly exited: Promise<void>;
  private stderrTail = '';
  private lineListeners: Array<(line: string) => void> = [];
  private closeListeners: Array<(info: { code: number | null; detail: string }) => void> = [];

  constructor(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        this.lineListeners.forEach((l) => l(line));
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    const done = (code: number | null, detail: string) =>
      this.closeListeners.forEach((l) => l({ code, detail: `${detail}${this.stderrTail ? `; stderr: ${this.stderrTail.trim().slice(-800)}` : ''}` }));
    this.child.on('error', (err) => done(null, `spawn error: ${err.message}`));
    this.child.on('exit', (code, signal) => done(code, `exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  send(line: string): void {
    if (this.child.stdin.writable) {
      this.child.stdin.write(line + '\n');
    }
  }
  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }
  onClose(listener: (info: { code: number | null; detail: string }) => void): void {
    this.closeListeners.push(listener);
  }
  async whenExited(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (this.child.exitCode === null) {
      this.child.kill();
    }
  }
}
