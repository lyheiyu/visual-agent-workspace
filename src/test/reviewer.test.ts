import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { OllamaClient, OllamaError, thinkParam, validateEndpoint } from '../reviewer/OllamaClient';
import { ReviewService, ReviewServiceOptions, ReviewRequest } from '../reviewer/ReviewService';
import { FakeOllama } from './support/fakeOllama';

function service(endpoint: string, overrides: Partial<ReviewServiceOptions> = {}) {
  return new ReviewService({
    enabled: () => true,
    endpoint: () => endpoint,
    allowRemote: () => false,
    preferredModel: () => '',
    thinking: () => 'off',
    contextWindow: () => 8192,
    updateIntervalMs: 5,
    ...overrides,
  });
}

const request = (text = 'def f(): pass'): ReviewRequest => ({
  kind: 'explain',
  title: 'Explain f()',
  subject: { filePath: 'a.py', functionName: 'f' },
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: text },
  ],
  context: text,
  truncated: false,
});

async function freePortClosed(): Promise<string> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

test('endpoint policy: loopback only unless explicitly allowed', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:11434', false).ok, true);
  assert.equal(validateEndpoint('http://localhost:11434', false).ok, true);
  assert.equal(validateEndpoint('http://[::1]:11434', false).ok, true);
  assert.equal(validateEndpoint('https://api.example.com', false).ok, false);
  assert.equal(validateEndpoint('http://192.168.1.10:11434', false).ok, false);
  assert.equal(validateEndpoint('http://192.168.1.10:11434', true).ok, true);
  assert.equal(validateEndpoint('http://user:pw@127.0.0.1:11434', true).ok, false);
  assert.equal(validateEndpoint('file:///etc/passwd', true).ok, false);
  assert.throws(() => new OllamaClient('https://cloud.example.com'), (e: OllamaError) => e.kind === 'endpoint-not-allowed');
});

test('think parameter: gpt-oss needs a level, others can disable thinking', () => {
  assert.equal(thinkParam('gpt-oss:20b', 'off'), 'low');
  assert.equal(thinkParam('qwen3:8b', 'off'), false);
  assert.equal(thinkParam('qwen3:8b', 'on'), true);
  assert.equal(thinkParam('gpt-oss:20b', 'on'), 'medium');
});

test('model discovery: prefers qwen3:8b when installed, honours the setting, never invents models', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = service(url);
    await s.refreshModels();
    let st = s.getState();
    assert.equal(st.connection, 'connected');
    assert.deepEqual(st.models.map((m) => m.name), ['qwen3:8b', 'gpt-oss:20b', 'llama3:8b']);
    assert.equal(st.selectedModel, 'qwen3:8b');
    assert.equal(st.models[0].parameterSize, '8B');

    const preferred = service(url, { preferredModel: () => 'gpt-oss:20b' });
    await preferred.refreshModels();
    assert.equal(preferred.getState().selectedModel, 'gpt-oss:20b');

    fake.models = ['llama3:8b'];
    const fallback = service(url, { preferredModel: () => 'not-installed:1b' });
    await fallback.refreshModels();
    assert.equal(fallback.getState().selectedModel, 'llama3:8b');
    assert.equal(fallback.selectModel('not-installed:1b'), false, 'cannot select a model that is not installed');

    fake.models = [];
    const none = service(url);
    await none.refreshModels();
    st = none.getState();
    assert.equal(st.selectedModel, undefined);
    assert.match(st.error!, /no models installed/);
    await assert.rejects(none.run(request()), /no models installed/);
    assert.ok(!fake.requests.some((r) => r.includes('/api/pull')), 'never pulls models');
  } finally {
    await fake.stop();
  }
});

test('Ollama offline: state is "unavailable" with a clear message; run rejects without throwing elsewhere', async () => {
  const url = await freePortClosed();
  const s = service(url);
  await s.refreshModels();
  const st = s.getState();
  assert.equal(st.connection, 'unavailable');
  assert.match(st.error!, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:\d+/);
  await assert.rejects(s.run(request()), /Cannot reach Ollama/);
});

test('streaming review: deltas arrive progressively, thinking kept separate, stats recorded', async () => {
  const fake = new FakeOllama();
  fake.thinkingTokens = ['hmm ', 'ok'];
  fake.chunkDelayMs = 10;
  const url = await fake.start();
  try {
    const s = service(url);
    const seen: string[] = [];
    s.onDidChange((st) => st.current?.status === 'streaming' && seen.push(st.current.text));
    const r = await s.run(request());
    assert.equal(r.status, 'done');
    assert.equal(r.text, 'The function validates samples.');
    assert.equal(r.thinking, 'hmm ok');
    assert.equal(r.promptTokens, 42);
    assert.equal(r.outputTokens, 4);
    assert.ok(seen.some((t) => t.length > 0 && t.length < r.text.length), 'partial text was streamed to the UI');
    const body = fake.chatRequests[0];
    assert.equal(body.stream, true);
    assert.equal(body.model, 'qwen3:8b');
    assert.equal(body.think, false);
    assert.equal(body.options.num_ctx, 8192);
  } finally {
    await fake.stop();
  }
});

test('cancellation aborts the HTTP stream and marks the result cancelled', async () => {
  const fake = new FakeOllama();
  fake.tokens = Array.from({ length: 200 }, (_, i) => `t${i} `);
  fake.chunkDelayMs = 20;
  const url = await fake.start();
  try {
    const s = service(url);
    const running = s.run(request());
    await new Promise<void>((resolve) => {
      const sub = s.onDidChange((st) => {
        if (st.current?.text) {
          sub.dispose();
          resolve();
        }
      });
    });
    assert.equal(s.getState().busy, true);
    await assert.rejects(s.run(request('other')), /already running/);
    assert.equal(s.cancel(), true);
    const r = await running;
    assert.equal(r.status, 'cancelled');
    assert.ok(r.text.length > 0 && r.text.length < fake.tokens.join('').length);
    assert.equal(s.getState().busy, false);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(fake.aborted, 1, 'server saw the connection closed');
    assert.equal(s.cancel(), false, 'nothing left to cancel');
  } finally {
    await fake.stop();
  }
});

test('model removed after discovery: clear "not installed" error, no download', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = service(url);
    await s.refreshModels();
    fake.models = ['llama3:8b'];
    const r = await s.run(request());
    assert.equal(r.status, 'error');
    assert.match(r.error!, /not installed in Ollama.*never downloads/);
  } finally {
    await fake.stop();
  }
});

test('results are cached by content hash and model', async () => {
  const fake = new FakeOllama();
  const url = await fake.start();
  try {
    const s = service(url);
    const a = await s.run(request('code A'));
    const b = await s.run(request('code A'));
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.text, a.text);
    assert.equal(s.inferenceRequests, 1);
    await s.run(request('code B'));
    assert.equal(s.inferenceRequests, 2, 'different code → new request');
    s.selectModel('gpt-oss:20b');
    await s.run(request('code A'));
    assert.equal(s.inferenceRequests, 3, 'different model → new request');
    assert.equal(fake.chatRequests.at(-1).think, 'low');
  } finally {
    await fake.stop();
  }
});

test('disabled reviewer makes no HTTP requests at all', async () => {
  const calls: string[] = [];
  const spy = (async (u: string | URL | Request) => {
    calls.push(String(u));
    throw new Error('should not be called');
  }) as typeof fetch;
  const s = service('http://127.0.0.1:11434', { enabled: () => false, fetchImpl: spy });
  await s.refreshModels();
  assert.equal(s.getState().connection, 'disabled');
  await assert.rejects(s.run(request()), /disabled/);
  assert.deepEqual(calls, []);
});
