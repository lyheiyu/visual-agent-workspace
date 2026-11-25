import { createHash, randomUUID } from 'node:crypto';
import { Emitter } from '../util/emitter';
import { ChatMessage, ChatResult, OllamaClient, OllamaError, OllamaModel, thinkParam } from './OllamaClient';
import { codeSpansPreserved, ResponseLanguage, ReviewKind, translatePrompt } from './prompts';
import { formatReviewOutput, ReviewOutputContext } from './reviewOutput';

export type TranslationTarget = 'zh-CN' | 'en';

export interface Translation {
  target: TranslationTarget;
  model: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  text: string;
  error?: string;
  cached: boolean;
  /** Every code span of the original appears unchanged in the translation. */
  codeSpansPreserved?: boolean;
}

export interface ReviewSubject {
  filePath?: string;
  functionName?: string;
  startLine?: number;
  endLine?: number;
  operationId?: string;
  taskId?: string;
}

export interface ReviewRequest {
  kind: ReviewKind;
  title: string;
  subject: ReviewSubject;
  messages: ChatMessage[];
  /** The context that was sent, for display/export. */
  context: string;
  truncated: boolean;
  /** Language the model was asked to answer in. */
  language?: ResponseLanguage;
  /** Explicit re-run: ask the model again instead of returning a cached answer. */
  noCache?: boolean;
  reviewOutput?: ReviewOutputContext;
  /**
   * Several requests for one result (Explain Diff in batches). `call` sends one chat request with the
   * selected model; calls are awaited one after another, never in parallel. Cancellation aborts the
   * running call. `key` identifies the input for the cache (the result is cached only when complete).
   */
  pipeline?: {
    key: string;
    run: (call: (messages: ChatMessage[], label: string, maxOutputTokens?: number) => Promise<ChatResult>) => Promise<{ text: string; incomplete: boolean; cacheable: boolean; context?: string }>;
  };
}

export interface ReviewResult {
  id: string;
  kind: ReviewKind;
  title: string;
  subject: ReviewSubject;
  model: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  text: string;
  thinking: string;
  error?: string;
  cached: boolean;
  startedAt: string;
  finishedAt?: string;
  context: string;
  truncated: boolean;
  language: ResponseLanguage;
  /** Translations of `text`; the original is never modified. */
  translations: Partial<Record<TranslationTarget, Translation>>;
  /** Which version the UI shows: the original or a translation. */
  view: 'original' | TranslationTarget | 'bilingual';
  promptTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Shown while streaming, e.g. "Analysing batch 2 of 4". */
  progress?: string;
  /** Not every part of the input was analysed (shown in the status line). */
  incomplete?: boolean;
  /** Model requests made for this result. */
  requests?: number;
}

export type ConnectionState = 'disabled' | 'unknown' | 'checking' | 'connected' | 'unavailable';

export interface ReviewerState {
  connection: ConnectionState;
  endpoint: string;
  error?: string;
  models: OllamaModel[];
  selectedModel?: string;
  busy: boolean;
  current?: ReviewResult;
  history: ReviewResult[];
}

export interface ReviewServiceOptions {
  enabled: () => boolean;
  endpoint: () => string;
  allowRemote: () => boolean;
  preferredModel: () => string;
  thinking: () => 'off' | 'low' | 'on';
  contextWindow: () => number;
  fetchImpl?: typeof fetch;
  /** Streaming UI updates are coalesced to this interval. */
  updateIntervalMs?: number;
}

/** Preferred defaults, used only if installed. Never required, never downloaded. */
export const PREFERRED_MODELS = ['qwen3:8b'];

/**
 * Local AI Reviewer core. Runs ONLY when `run()` is called by an explicit
 * user action. Read-only: it returns text; it has no access to the
 * filesystem, the agent session or the shell.
 */
export class ReviewService {
  private state: ReviewerState;
  private abort: AbortController | undefined;
  private readonly cache = new Map<string, ReviewResult>();
  private readonly translationCache = new Map<string, Translation>();
  private readonly emitter = new Emitter<ReviewerState>();
  readonly onDidChange = this.emitter.event;
  private pendingEmit: NodeJS.Timeout | undefined;
  /** The result currently being streamed (mutated as tokens arrive). */
  private live: ReviewResult | undefined;
  /** Number of inference requests actually sent (for tests/diagnostics). */
  inferenceRequests = 0;

  constructor(private readonly options: ReviewServiceOptions) {
    this.state = {
      connection: options.enabled() ? 'unknown' : 'disabled',
      endpoint: options.endpoint(),
      models: [],
      busy: false,
      history: [],
    };
  }

  getState(): ReviewerState {
    return { ...this.state, models: [...this.state.models], history: [...this.state.history] };
  }

  /** Discover installed models (GET /api/tags). No inference. */
  async refreshModels(): Promise<void> {
    if (!this.options.enabled()) {
      this.set({ connection: 'disabled', models: [], error: undefined });
      return;
    }
    this.set({ connection: 'checking', endpoint: this.options.endpoint(), error: undefined });
    try {
      const models = await this.client().listModels();
      const names = models.map((m) => m.name);
      const preferred = this.options.preferredModel();
      const selected =
        (this.state.selectedModel && names.includes(this.state.selectedModel) && this.state.selectedModel) ||
        (preferred && names.includes(preferred) ? preferred : undefined) ||
        PREFERRED_MODELS.find((m) => names.includes(m)) ||
        names[0];
      this.set({
        connection: 'connected',
        models,
        selectedModel: selected,
        error: models.length ? undefined : 'Ollama is running but has no models installed (run "ollama pull <model>" yourself).',
      });
    } catch (err) {
      this.set({ connection: 'unavailable', models: [], error: (err as Error).message });
    }
  }

  selectModel(name: string): boolean {
    if (!this.state.models.some((m) => m.name === name)) {
      return false;
    }
    this.set({ selectedModel: name });
    return true;
  }

  private readonly contextLengths = new Map<string, number | undefined>();

  /** The model's trained context length from Ollama metadata (no inference); undefined if unavailable. */
  async modelContextLength(model: string): Promise<number | undefined> {
    if (this.contextLengths.has(model)) return this.contextLengths.get(model);
    let value: number | undefined;
    try {
      value = (await this.client().show(model)).contextLength;
    } catch {
      value = undefined; // older Ollama or no metadata: the configured window is used
    }
    this.contextLengths.set(model, value);
    return value;
  }

  /** Run one review. Rejects if disabled, busy, or no model is selected. */
  async run(req: ReviewRequest): Promise<ReviewResult> {
    if (!this.options.enabled()) {
      throw new Error('The Local AI Reviewer is disabled (visualAgent.reviewer.enabled).');
    }
    if (this.state.busy) {
      throw new Error('A local AI request is already running. Cancel it first.');
    }
    if (this.state.connection !== 'connected') {
      await this.refreshModels();
    }
    const model = this.state.selectedModel;
    if (!model) {
      throw new Error(this.state.error ?? 'No local model is available.');
    }
    const key = cacheKey(model, req, this.options.thinking(), this.options.contextWindow());
    const hit = req.noCache ? undefined : this.cache.get(key);
    if (hit) {
      const cached: ReviewResult = { ...hit, id: randomUUID(), cached: true, subject: req.subject, title: req.title, translations: { ...hit.translations }, view: 'original' };
      this.pushHistory(cached);
      this.set({ current: cached });
      return cached;
    }

    const result: ReviewResult = {
      id: randomUUID(),
      kind: req.kind,
      title: req.title,
      subject: req.subject,
      model,
      status: 'streaming',
      text: '',
      thinking: '',
      cached: false,
      startedAt: new Date().toISOString(),
      context: req.context,
      truncated: req.truncated,
      language: req.language ?? 'en',
      translations: {},
      view: 'original',
    };
    this.abort = new AbortController();
    this.live = result;
    this.set({ busy: true, current: { ...result } });
    const t0 = Date.now();
    try {
      if (req.pipeline) {
        const client = this.client();
        const signal = this.abort.signal;
        const done = await req.pipeline.run(async (messages, label, maxOutputTokens) => {
          signal.throwIfAborted?.();
          result.progress = label;
          result.requests = (result.requests ?? 0) + 1;
          this.set({ current: { ...result } });
          this.inferenceRequests++;
          const out = await client.chat(
            { model, messages, think: thinkParam(model, this.options.thinking()), options: { temperature: 0.2, num_ctx: this.options.contextWindow(), ...(maxOutputTokens ? { num_predict: maxOutputTokens } : {}) } },
            { signal, onDelta: (text, kind) => { if (kind === 'thinking') { result.thinking += text; this.emitSoon(); } } },
          );
          result.promptTokens = (result.promptTokens ?? 0) + (out.promptTokens ?? 0);
          result.outputTokens = (result.outputTokens ?? 0) + (out.outputTokens ?? 0);
          return out;
        });
        result.text = done.text;
        result.incomplete = done.incomplete;
        if (done.context !== undefined) result.context = done.context;
        result.progress = undefined;
        result.status = 'done';
        if (done.cacheable) this.cache.set(key, { ...result, translations: {}, view: 'original' });
        return result;
      }
      this.inferenceRequests++;
      const out = await this.client().chat(
        {
          model,
          messages: req.messages,
          think: thinkParam(model, this.options.thinking()),
          options: { temperature: 0.2, num_ctx: this.options.contextWindow() },
        },
        {
          signal: this.abort.signal,
          onDelta: (text, kind) => {
            if (kind === 'content' && !req.reviewOutput) {
              result.text += text;
            } else if (kind === 'thinking') {
              result.thinking += text;
            } else {
              return;
            }
            this.emitSoon();
          },
        },
      );
      const formatted = req.reviewOutput && formatReviewOutput(out.content, req.reviewOutput, result.language);
      result.text = formatted ? formatted.text : out.content;
      result.thinking = out.thinking;
      result.promptTokens = out.promptTokens;
      result.outputTokens = out.outputTokens;
      result.status = 'done';
      if (!formatted || formatted.cacheable) {
        this.cache.set(key, { ...result, translations: {}, view: 'original' });
      }
      if (this.cache.size > 50) {
        this.cache.delete(this.cache.keys().next().value!);
      }
    } catch (err) {
      const e = err as OllamaError;
      result.progress = undefined;
      result.status = e.kind === 'aborted' || this.abort?.signal.aborted ? 'cancelled' : 'error';
      result.error = e.message;
      if (e.kind === 'unreachable') {
        this.set({ connection: 'unavailable', error: e.message });
      }
    } finally {
      result.durationMs = Date.now() - t0;
      result.finishedAt = new Date().toISOString();
      this.abort = undefined;
      this.live = undefined;
      this.pushHistory(result);
      this.set({ busy: false, current: { ...result } });
    }
    return result;
  }

  /**
   * Translate a previous result with the currently selected local model.
   * Cached by (hash of original text, source language, target, model): a
   * cached translation is shown without any request. The original is kept.
   */
  async translate(resultId: string, target: TranslationTarget): Promise<Translation | undefined> {
    const result = this.findResult(resultId);
    if (!result || result.status !== 'done' || !result.text) {
      throw new Error('Only completed results can be translated.');
    }
    if (result.language === target || result.language === 'bilingual') {
      result.view = 'original';
      this.set({ current: { ...result } });
      return undefined;
    }
    const existing = result.translations[target];
    if (existing?.status === 'done') {
      result.view = target;
      this.set({ current: { ...result } });
      return existing;
    }
    if (!this.options.enabled()) {
      throw new Error('The Local AI Reviewer is disabled (visualAgent.reviewer.enabled).');
    }
    if (this.state.busy) {
      throw new Error('A local AI request is already running. Cancel it first.');
    }
    const model = this.state.selectedModel;
    if (!model) {
      throw new Error(this.state.error ?? 'No local model is available.');
    }
    const key = createHash('sha256').update(JSON.stringify(['translate', result.text, result.language, target, model])).digest('hex');
    const hit = this.translationCache.get(key);
    if (hit) {
      result.translations[target] = { ...hit, cached: true };
      result.view = target;
      this.set({ current: { ...result } });
      return result.translations[target];
    }
    const tr: Translation = { target, model, status: 'streaming', text: '', cached: false };
    result.translations[target] = tr;
    result.view = target;
    this.abort = new AbortController();
    this.live = result;
    this.set({ busy: true, current: { ...result } });
    try {
      this.inferenceRequests++;
      const out = await this.client().chat(
        { model, messages: translatePrompt(result.text, target), think: thinkParam(model, 'off'), options: { temperature: 0, num_ctx: this.options.contextWindow() } },
        {
          signal: this.abort.signal,
          onDelta: (text, kind) => {
            if (kind === 'content') {
              tr.text += text;
              this.emitSoon();
            }
          },
        },
      );
      tr.text = out.content;
      tr.status = 'done';
      tr.codeSpansPreserved = codeSpansPreserved(result.text, tr.text);
      this.translationCache.set(key, { ...tr });
      if (this.translationCache.size > 100) {
        this.translationCache.delete(this.translationCache.keys().next().value!);
      }
    } catch (err) {
      const e = err as OllamaError;
      tr.status = e.kind === 'aborted' ? 'cancelled' : 'error';
      tr.error = e.message;
      // Do not keep a partial translation as the shown version.
      delete result.translations[target];
      result.view = 'original';
    } finally {
      this.abort = undefined;
      this.live = undefined;
      this.set({ busy: false, current: { ...result } });
    }
    return tr;
  }

  /** Show the original, a cached translation, or both (bilingual) — never makes a request. */
  showVersion(resultId: string, view: ReviewResult['view']): boolean {
    const result = this.findResult(resultId);
    if (!result) {
      return false;
    }
    if (view !== 'original' && view !== 'bilingual' && result.translations[view]?.status !== 'done') {
      return false;
    }
    result.view = view;
    this.set({ current: { ...result } });
    return true;
  }

  private findResult(id: string): ReviewResult | undefined {
    return this.state.history.find((h) => h.id === id) ?? (this.state.current?.id === id ? this.state.current : undefined);
  }

  cancel(): boolean {
    if (!this.abort) {
      return false;
    }
    this.abort.abort();
    return true;
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.cancel();
    if (this.pendingEmit) {
      clearTimeout(this.pendingEmit);
    }
    this.emitter.dispose();
  }

  // ------------------------------------------------------------ internals

  private client(): OllamaClient {
    return new OllamaClient(this.options.endpoint(), { allowRemote: this.options.allowRemote(), fetchImpl: this.options.fetchImpl });
  }

  private pushHistory(r: ReviewResult): void {
    this.state.history = [r, ...this.state.history.filter((h) => h.id !== r.id)].slice(0, 20);
  }

  private set(patch: Partial<ReviewerState>): void {
    this.state = { ...this.state, ...patch };
    if (this.pendingEmit) {
      clearTimeout(this.pendingEmit);
      this.pendingEmit = undefined;
    }
    this.emitter.fire(this.getState());
  }

  /** Coalesce token-by-token updates so streaming never floods the UI. */
  private emitSoon(): void {
    if (this.pendingEmit) {
      return;
    }
    this.pendingEmit = setTimeout(() => {
      this.pendingEmit = undefined;
      if (this.live) {
        this.state = { ...this.state, current: { ...this.live } };
      }
      this.emitter.fire(this.getState());
    }, this.options.updateIntervalMs ?? 150);
  }
}

function cacheKey(model: string, req: ReviewRequest, thinking: string, contextWindow: number): string {
  return createHash('sha256')
    .update(JSON.stringify([model, thinking, contextWindow, req.kind, req.language, req.messages, req.reviewOutput?.fingerprint, req.pipeline?.key]))
    .digest('hex');
}
