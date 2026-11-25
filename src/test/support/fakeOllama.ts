import * as http from 'node:http';
import { AddressInfo } from 'node:net';

/** Local stand-in for the Ollama HTTP API (/api/tags, /api/version, /api/chat streaming). */
export class FakeOllama {
  server: http.Server;
  url = '';
  models = ['qwen3:8b', 'gpt-oss:20b', 'llama3:8b'];
  /** Tokens streamed by /api/chat. */
  tokens = ['The ', 'function ', 'validates ', 'samples.'];
  thinkingTokens: string[] = [];
  /** Optional reply builder (e.g. echo line ranges found in the prompt). */
  respond?: (request: any) => string[];
  /** Delay between streamed chunks; Infinity-like values simulate a stuck model. */
  chunkDelayMs = 0;
  chatRequests: any[] = [];
  requests: string[] = [];
  aborted = 0;
  /** /api/show model_info.<arch>.context_length; undefined → /api/show answers 404 (metadata unavailable). */
  contextLength?: number;
  /** Return an error message to fail this chat request with HTTP 500. */
  failWith?: (request: any) => string | undefined;
  /** prompt_eval_count reported for a request (default 42). */
  promptTokens?: (request: any) => number;
  inFlight = 0;
  maxInFlight = 0;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.0.0-fake' }));
      return;
    }
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: this.models.map((name) => ({ name, model: name, size: 1e9, details: { parameter_size: '8B', quantization_level: 'Q4_K_M', family: 'fake' } })) }));
      return;
    }
    if (req.url === '/api/show' && req.method === 'POST') {
      for await (const _ of req) { /* drain */ }
      if (this.contextLength === undefined) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.context_length': this.contextLength } }));
      return;
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      res.on('close', () => this.inFlight--);
      let body = '';
      for await (const c of req) {
        body += c;
      }
      const parsed = JSON.parse(body);
      this.chatRequests.push(parsed);
      if (!this.models.includes(parsed.model)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `model "${parsed.model}" not found, try pulling it first` }));
        return;
      }
      const failure = this.failWith?.(parsed);
      if (failure) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: failure }));
        return;
      }
      res.setHeader('content-type', 'application/x-ndjson');
      let closed = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          closed = true;
          this.aborted++;
        }
      });
      const send = async (obj: unknown) => {
        if (this.chunkDelayMs) {
          await new Promise((r) => setTimeout(r, this.chunkDelayMs));
        }
        if (!closed) {
          res.write(JSON.stringify(obj) + '\n');
        }
      };
      for (const t of this.thinkingTokens) {
        await send({ model: parsed.model, message: { role: 'assistant', content: '', thinking: t }, done: false });
      }
      for (const t of this.respond ? this.respond(parsed) : this.tokens) {
        await send({ model: parsed.model, message: { role: 'assistant', content: t }, done: false });
      }
      if (!closed) {
        await send({ model: parsed.model, message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: this.promptTokens ? this.promptTokens(parsed) : 42, eval_count: this.tokens.length, total_duration: 5e6 });
        res.end();
      }
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }
}
