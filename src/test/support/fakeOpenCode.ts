import { OpenCodeConnection } from '../../agents/opencode/OpenCodeServer';

type Ev = { type: string; properties: any };

/**
 * In-memory OpenCode server. Event shapes are copied from a real trace
 * (opencode-ai 1.19.6 + Ollama qwen3:8b, disposable repo).
 */
export class FakeOpenCode implements OpenCodeConnection {
  readonly version = '1.19.6-fake';
  sessionId = 'ses_fake1';
  requests: Array<{ method: string; route: string; body?: any }> = [];
  replies: Array<{ id: string; reply: string; message?: string }> = [];
  closed = false;
  private listener: ((e: Ev) => void) | undefined;
  private exitListeners: Array<(d: string) => void> = [];
  private permissionWaiters = new Map<string, (reply: string) => void>();
  /** Runs for each prompt_async (index = turn number). */
  turns: Array<(s: FakeOpenCode) => Promise<void>> = [];
  private turn = 0;
  aborted = false;
  directory?: string;

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    this.requests.push({ method, route, body });
    if (method === 'GET' && route === `/session/${this.sessionId}`) return { id: this.sessionId, directory: this.directory } as T;
    if (method === 'POST' && route === '/session') {
      return { id: this.sessionId } as T;
    }
    const perm = /^\/permission\/([^/]+)\/reply$/.exec(route);
    if (perm) {
      const b = body as { reply: string; message?: string };
      this.replies.push({ id: perm[1], ...b });
      this.permissionWaiters.get(perm[1])?.(b.reply);
      return true as T;
    }
    if (route.endsWith('/prompt_async')) {
      const script = this.turns[this.turn++];
      setTimeout(() => void (script ?? (async (s: FakeOpenCode) => s.idle()))(this), 0);
      return undefined as T;
    }
    if (route.endsWith('/abort')) {
      this.aborted = true;
      this.emit({ type: 'session.error', properties: { sessionID: this.sessionId, error: { name: 'MessageAbortedError', data: {} } } });
      this.idle();
      return true as T;
    }
    return undefined as T;
  }

  subscribe(onEvent: (e: Ev) => void, signal: AbortSignal): Promise<void> {
    this.listener = onEvent;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  onExit(l: (d: string) => void): void {
    this.exitListeners.push(l);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  crash(detail = 'opencode exited (code 1)'): void {
    this.exitListeners.forEach((l) => l(detail));
  }

  // ------------------------------------------------------- scripting helpers

  emit(e: Ev): void {
    this.listener?.(e);
  }
  assistant(id = 'msg_a1', model = 'qwen3:8b', provider = 'ollama'): void {
    this.emit({ type: 'message.updated', properties: { sessionID: this.sessionId, info: { id, role: 'assistant', modelID: model, providerID: provider, sessionID: this.sessionId } } });
  }
  user(id = 'msg_u1'): void {
    this.emit({ type: 'message.updated', properties: { sessionID: this.sessionId, info: { id, role: 'user', sessionID: this.sessionId } } });
  }
  tool(callID: string, tool: string, status: 'pending' | 'running' | 'completed' | 'error', input: any, extra: any = {}): void {
    this.emit({
      type: 'message.part.updated',
      properties: { sessionID: this.sessionId, time: Date.now(), part: { id: `prt_${callID}`, sessionID: this.sessionId, messageID: 'msg_a1', type: 'tool', callID, tool, state: { status, input, ...extra } } },
    });
  }
  text(id: string, text: string, messageID = 'msg_a1'): void {
    this.emit({ type: 'message.part.updated', properties: { sessionID: this.sessionId, time: Date.now(), part: { id, sessionID: this.sessionId, messageID, type: 'text', text } } });
  }
  /** Emit permission.asked and wait for the client's reply. */
  permission(id: string, permission: string, callID: string, metadata: any, patterns: string[] = []): Promise<string> {
    return new Promise((resolve) => {
      this.permissionWaiters.set(id, resolve);
      this.emit({ type: 'permission.asked', properties: { id, sessionID: this.sessionId, permission, patterns, metadata, always: [], tool: { messageID: 'msg_a1', callID } } });
    });
  }
  idle(): void {
    this.emit({ type: 'session.idle', properties: { sessionID: this.sessionId } });
  }
}
