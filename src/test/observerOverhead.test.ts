import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AgentController } from '../controller/AgentController';
import { EventRecorder, MemoryHistoryStorage } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { CodexAppServerAdapter } from '../adapters/codex/CodexAppServerAdapter';
import { CodexRpcClient } from '../adapters/codex/CodexRpcClient';
import { getProfile } from '../adapters/codex/profiles';
import { ReviewService } from '../reviewer/ReviewService';
import { commandItem, FakeCodexServer, fileChangeItem } from './support/fakeCodex';

const ROOT = path.resolve(__dirname, '..', '..', 'demo-workspace');

/**
 * Layer A must make zero LLM requests: the only messages sent to Codex are
 * the session handshake and the user's own turn, and the local reviewer is
 * never called during observation.
 */
test('observation sends no extra requests to the agent and none to Ollama', async () => {
  const ollamaCalls: string[] = [];
  const reviewer = new ReviewService({
    enabled: () => true,
    endpoint: () => 'http://127.0.0.1:11434',
    allowRemote: () => false,
    preferredModel: () => '',
    thinking: () => 'off',
    contextWindow: () => 8192,
    fetchImpl: (async (u: string) => {
      ollamaCalls.push(String(u));
      throw new Error('no');
    }) as unknown as typeof fetch,
  });
  const server = new FakeCodexServer();
  server.onTurnStarted = async (s) => {
    for (let i = 0; i < 50; i++) {
      s.itemStarted(commandItem(ROOT, { id: `e${i}` }));
      s.itemCompleted(commandItem(ROOT, { id: `e${i}`, status: 'completed', exitCode: 0, aggregatedOutput: 'x' }));
    }
    s.itemStarted(fileChangeItem(path.join(ROOT, 'validation.py')));
    s.itemCompleted(fileChangeItem(path.join(ROOT, 'validation.py'), { status: 'completed' }));
    s.itemCompleted({ type: 'agentMessage', id: 'm', text: 'done' });
    s.completeTurn('completed');
  };
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => ROOT });
  controller.start('task', new CodexAppServerAdapter({ connector: () => new CodexRpcClient(server), profile: getProfile('observe') }));
  await controller.whenIdle();
  // Also a full mock demo.
  controller.start('demo', new MockAgentAdapter(undefined, { durationScale: 0 }));
  await new Promise<void>((r) => {
    const sub = controller.onDidChangeState((s) => {
      if (s.awaitingApprovalFor) {
        sub.dispose();
        controller.approve(s.awaitingApprovalFor);
        r();
      }
    });
  });
  await controller.whenIdle();

  const clientRequests = server.received.filter((m) => m.method).map((m) => m.method);
  assert.deepEqual(clientRequests, ['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start'], 'exactly one turn: the user task; no observer prompts');
  assert.equal(server.received.filter((m) => m.method === 'turn/start').length, 1);
  assert.deepEqual(ollamaCalls, [], 'local reviewer untouched during observation');
  assert.equal(reviewer.inferenceRequests, 0);
  assert.ok(recorder.getOperations().length > 50, "all events were recorded");
});

/** Measures actual event-processing cost; prints the numbers. */
test('event-processing overhead (measured)', async () => {
  const N = 2000;
  const server = new FakeCodexServer();
  let t0 = 0;
  let t1 = 0;
  server.onTurnStarted = async (s) => {
    t0 = performance.now();
    for (let i = 0; i < N; i++) {
      s.itemStarted(commandItem(ROOT, { id: `c${i}` }));
      s.notify('item/commandExecution/outputDelta', { threadId: s.threadId, turnId: s.turnId, itemId: `c${i}`, delta: 'x' });
      s.itemCompleted(commandItem(ROOT, { id: `c${i}`, status: 'completed', exitCode: 0, aggregatedOutput: 'out '.repeat(50) }));
    }
    t1 = performance.now();
    s.completeTurn('completed');
  };
  // Persistence as configured in the extension (debounced) vs every event.
  const debounced = new MemoryHistoryStorage();
  let saves = 0;
  const save = debounced.save.bind(debounced);
  debounced.save = (h) => {
    saves++;
    save(h);
  };
  const recorder = new EventRecorder(debounced, { persistDebounceMs: 750 });
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => ROOT });
  const heapBefore = process.memoryUsage().heapUsed;
  controller.start('perf', new CodexAppServerAdapter({ connector: () => new CodexRpcClient(server), profile: getProfile('observe') }));
  await controller.whenIdle();
  const events = N * 3;
  const ms = t1 - t0;
  recorder.flush();
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(
    `    [measured] ${events} Codex notifications (${N} commands) processed synchronously in ${ms.toFixed(1)} ms ` +
      `= ${((ms * 1000) / events).toFixed(1)} µs/event; persistence writes: ${saves} (debounced 750 ms); ` +
      `heap delta ≈ ${((heapAfter - heapBefore) / 1e6).toFixed(1)} MB for ${recorder.getOperations().length} operations`,
  );
  assert.equal(recorder.getOperations().filter((o) => o.command).length, N);
  assert.ok(saves <= 3, 'persistence is coalesced, not per event');
  assert.ok(ms / events < 2, 'regression guard: < 2 ms per event');
});

test('bounded memory: oldest finished operations are compacted beyond the per-task cap', () => {
  const recorder = new EventRecorder(undefined, { maxOperationsPerTask: 100 });
  const t = recorder.startTask({ description: 'x', source: 'codex', adapterName: 'Codex', simulated: false });
  for (let i = 0; i < 150; i++) {
    const op = recorder.recordOperation(t.taskId, {
      source: 'codex',
      simulated: false,
      requiresApproval: false,
      operationType: 'Execute',
      description: `c${i}`,
      command: { command: 'x', workingDirectory: '.', simulated: false, status: 'Pending' },
    });
    recorder.updateOperation(op.operationId, { status: 'Completed', command: { stdout: 'y'.repeat(5000) } });
  }
  const ops = recorder.getOperations(t.taskId);
  assert.equal(ops.length, 150, 'timeline keeps every operation');
  assert.match(ops[0].command!.stdout!, /compacted/);
  assert.equal(ops[149].command!.stdout!.length, 5000, 'recent output intact');
});
