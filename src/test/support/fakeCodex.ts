import { LineTransport } from '../../adapters/codex/CodexRpcClient';

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (params: any) => unknown | Promise<unknown>;

/**
 * In-memory stand-in for `codex app-server`, speaking the same JSONL
 * protocol. Item payload shapes are copied from real traces (codex-cli
 * 0.154.0) recorded against a disposable repository.
 */
export class FakeCodexServer implements LineTransport {
  readonly received: Msg[] = [];
  private lineListener: ((line: string) => void) | undefined;
  private closeListeners: Array<(info: { code: number | null; detail: string }) => void> = [];
  private nextServerId = 0;
  private readonly pendingServerRequests = new Map<number, (res: Msg) => void>();
  closed = false;
  threadId = 'thr-1';
  turnId = 'turn-1';
  /** Overrides for thread/start response fields (to test boundary checks). */
  threadStartOverride: Record<string, unknown> = {};
  handlers: Record<string, Handler> = {};
  /** Runs after turn/start is answered. */
  onTurnStarted: (server: FakeCodexServer) => Promise<void> = async () => this.completeTurn('completed');

  constructor() {
    this.handlers = {
      initialize: () => ({ userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' }),
      'model/list': () => ({ data: [{ model: 'fake-model', hidden: false, isDefault: true }], nextCursor: null }),
      'thread/start': (p) => ({
        thread: { id: this.threadId },
        model: p.model ?? 'fake-model',
        modelProvider: 'openai',
        cwd: p.cwd,
        approvalPolicy: p.approvalPolicy,
        sandbox: p.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite' },
        ...this.threadStartOverride,
      }),
      'turn/start': () => {
        setTimeout(() => void this.onTurnStarted(this).catch(() => undefined), 0);
        return { turn: { id: this.turnId, status: 'inProgress', items: [], error: null } };
      },
      'turn/interrupt': () => {
        setTimeout(() => this.completeTurn('interrupted'), 5);
        return {};
      },
      'turn/steer': (p) => ({ turnId: p.expectedTurnId }),
    };
  }

  // ---------------------------------------------------------- transport

  send(line: string): void {
    const msg = JSON.parse(line) as Msg;
    this.received.push(msg);
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = this.handlers[msg.method];
      void Promise.resolve()
        .then(() => {
          if (!handler) {
            throw Object.assign(new Error(`unknown method ${msg.method}`), { code: -32601 });
          }
          return handler(msg.params);
        })
        .then(
          (result) => this.emit({ id: msg.id, result }),
          (err: any) => this.emit({ id: msg.id, error: { code: err.code ?? -32000, message: err.message } }),
        );
    } else if (msg.id !== undefined && msg.method === undefined) {
      this.pendingServerRequests.get(Number(msg.id))?.(msg);
      this.pendingServerRequests.delete(Number(msg.id));
    }
  }
  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }
  onClose(listener: (info: { code: number | null; detail: string }) => void): void {
    this.closeListeners.push(listener);
  }
  close(): void {
    this.crash('closed by client');
  }

  // -------------------------------------------------------- scripting

  notify(method: string, params: unknown): void {
    this.emit({ method, params });
  }

  /** Send a server→client request and wait for the client's response. */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.pendingServerRequests.set(id, resolve);
      this.emit({ id, method, params });
    });
  }

  itemStarted(item: unknown): void {
    this.notify('item/started', { item, threadId: this.threadId, turnId: this.turnId, startedAtMs: Date.now() });
  }
  itemCompleted(item: unknown): void {
    this.notify('item/completed', { item, threadId: this.threadId, turnId: this.turnId, completedAtMs: Date.now() });
  }
  completeTurn(status: 'completed' | 'interrupted' | 'failed', error: string | null = null): void {
    this.notify('turn/completed', {
      threadId: this.threadId,
      turn: { id: this.turnId, status, items: [], error: error ? { message: error } : null },
    });
  }
  crash(detail = 'crashed'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeListeners.forEach((l) => l({ code: 1, detail }));
  }
  sentMethods(): string[] {
    return this.received.filter((m) => m.method).map((m) => m.method!);
  }

  private emit(msg: Msg): void {
    if (!this.closed) {
      this.lineListener?.(JSON.stringify(msg));
    }
  }
}

// ----------------------------------------------- item builders (real shapes)

export function commandItem(root: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'commandExecution',
    id: 'exec-1',
    command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content validation.py'`,
    cwd: root,
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'read', command: 'Get-Content validation.py', name: 'validation.py', path: 'validation.py' }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides,
  };
}

/** The exact diff shape Codex produced for validation.py in the real probe. */
export function fileChangeItem(filePath: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'fileChange',
    id: 'patch-1',
    changes: [{ path: filePath, kind: { type: 'update', move_path: null }, diff: '@@ -26 +26,2 @@\n     }\n+# reviewed\n' }],
    status: 'inProgress',
    ...overrides,
  };
}
