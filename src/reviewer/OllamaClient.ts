/**
 * Minimal Ollama HTTP client (https://github.com/ollama/ollama/blob/main/docs/api.md).
 * Uses only: GET /api/version, GET /api/tags, POST /api/chat (streaming NDJSON).
 * Never pulls/deletes models and never changes Ollama configuration.
 */

export type OllamaErrorKind = 'endpoint-not-allowed' | 'unreachable' | 'http' | 'model-not-found' | 'aborted' | 'protocol';

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface OllamaModel {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  family?: string;
  quantization?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** false = disable thinking where supported; 'low' etc. for models that need a level (gpt-oss). */
  think?: boolean | 'low' | 'medium' | 'high';
  options?: { temperature?: number; num_ctx?: number; num_predict?: number };
}

export interface ChatResult {
  content: string;
  thinking: string;
  promptTokens?: number;
  outputTokens?: number;
  totalDurationMs?: number;
}

type FetchLike = typeof fetch;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Only http(s) on loopback is allowed unless remote endpoints are explicitly enabled. */
export function validateEndpoint(endpoint: string, allowRemote: boolean): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: `Invalid Ollama endpoint: ${endpoint}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol ${url.protocol} (use http or https).` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Credentials in the Ollama endpoint URL are not allowed.' };
  }
  if (!LOOPBACK.has(url.hostname) && !allowRemote) {
    return {
      ok: false,
      reason: `"${url.hostname}" is not a local address. Code is only sent to a local Ollama by default (enable visualAgent.reviewer.allowRemoteEndpoint to override).`,
    };
  }
  return { ok: true, url };
}

export class OllamaClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    endpoint: string,
    options: { allowRemote?: boolean; fetchImpl?: FetchLike } = {},
  ) {
    const v = validateEndpoint(endpoint, !!options.allowRemote);
    if (!v.ok) {
      throw new OllamaError('endpoint-not-allowed', v.reason);
    }
    this.base = v.url.toString().replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get endpoint(): string {
    return this.base;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const res = await this.get('/api/version', signal);
    return String((res as { version?: string }).version ?? 'unknown');
  }

  async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    const res = (await this.get('/api/tags', signal)) as { models?: Array<Record<string, any>> };
    if (!Array.isArray(res.models)) {
      throw new OllamaError('protocol', 'Unexpected /api/tags response.');
    }
    return res.models
      .map((m) => ({
        name: String(m.name ?? m.model ?? ''),
        sizeBytes: typeof m.size === 'number' ? m.size : undefined,
        parameterSize: m.details?.parameter_size,
        family: m.details?.family,
        quantization: m.details?.quantization_level,
      }))
      .filter((m) => m.name);
  }

  /** Streaming chat. `onDelta` receives content and thinking tokens as they arrive. */
  async chat(
    req: ChatRequest,
    opts: { signal?: AbortSignal; onDelta?: (text: string, kind: 'content' | 'thinking') => void } = {},
  ): Promise<ChatResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...req, stream: true }),
        signal: opts.signal,
      });
    } catch (err) {
      throw this.wrap(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = safeError(body) ?? `HTTP ${res.status}`;
      if (res.status === 404 || /not found/i.test(msg)) {
        throw new OllamaError('model-not-found', `Model "${req.model}" is not installed in Ollama (${msg}). Visual Agent never downloads models.`);
      }
      throw new OllamaError('http', `Ollama returned ${res.status}: ${msg}`);
    }
    if (!res.body) {
      throw new OllamaError('protocol', 'Ollama returned no response body.');
    }
    const result: ChatResult = { content: '', thinking: '' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            this.consume(line, result, opts.onDelta);
          }
        }
      }
      if (buffer.trim()) {
        this.consume(buffer.trim(), result, opts.onDelta);
      }
    } catch (err) {
      throw this.wrap(err);
    } finally {
      reader.releaseLock?.();
    }
    return result;
  }

  // ------------------------------------------------------------ internals

  private consume(line: string, result: ChatResult, onDelta?: (t: string, k: 'content' | 'thinking') => void): void {
    let chunk: any;
    try {
      chunk = JSON.parse(line);
    } catch {
      throw new OllamaError('protocol', `Unparseable stream chunk: ${line.slice(0, 120)}`);
    }
    if (chunk.error) {
      throw new OllamaError(/not found/i.test(chunk.error) ? 'model-not-found' : 'http', String(chunk.error));
    }
    const thinking = chunk.message?.thinking;
    if (typeof thinking === 'string' && thinking) {
      result.thinking += thinking;
      onDelta?.(thinking, 'thinking');
    }
    const content = chunk.message?.content;
    if (typeof content === 'string' && content) {
      result.content += content;
      onDelta?.(content, 'content');
    }
    if (chunk.done) {
      result.promptTokens = chunk.prompt_eval_count;
      result.outputTokens = chunk.eval_count;
      result.totalDurationMs = typeof chunk.total_duration === 'number' ? Math.round(chunk.total_duration / 1e6) : undefined;
    }
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { signal: signal ?? AbortSignal.timeout(5000) });
    } catch (err) {
      throw this.wrap(err);
    }
    if (!res.ok) {
      throw new OllamaError('http', `Ollama returned ${res.status} for ${path}`);
    }
    try {
      return await res.json();
    } catch {
      throw new OllamaError('protocol', `Ollama returned invalid JSON for ${path}`);
    }
  }

  private wrap(err: unknown): OllamaError {
    if (err instanceof OllamaError) {
      return err;
    }
    const e = err as { name?: string; message?: string; cause?: { code?: string } };
    if (e?.name === 'AbortError') {
      return new OllamaError('aborted', 'The local AI request was cancelled.');
    }
    if (e?.name === 'TimeoutError') {
      return new OllamaError('unreachable', `Ollama at ${this.base} did not respond in time.`);
    }
    const code = e?.cause?.code;
    return new OllamaError('unreachable', `Cannot reach Ollama at ${this.base}${code ? ` (${code})` : ''}. Is it running?`);
  }
}

function safeError(body: string): string | undefined {
  try {
    const j = JSON.parse(body);
    return typeof j.error === 'string' ? j.error : undefined;
  } catch {
    return body.slice(0, 200) || undefined;
  }
}

/** Thinking setting → API value. gpt-oss cannot disable reasoning; it takes a level. */
export function thinkParam(model: string, mode: 'off' | 'low' | 'on'): ChatRequest['think'] {
  const needsLevel = /gpt-oss/i.test(model);
  if (mode === 'off') {
    return needsLevel ? 'low' : false;
  }
  if (mode === 'low') {
    return needsLevel ? 'low' : true;
  }
  return needsLevel ? 'medium' : true;
}
