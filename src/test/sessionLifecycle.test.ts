import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventRecorder, PersistedHistory } from '../recorder/EventRecorder';
import { AgentController } from '../controller/AgentController';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { OpenCodeAdapter } from '../agents/opencode/OpenCodeAdapter';
import { FakeOpenCode } from './support/fakeOpenCode';
import { buildActivityViewModel } from '../ui/viewModel';

const root = path.join(os.tmpdir(), 'vaw-session-contract');

test('OpenCode usage includes cache and reasoning once per completed message', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant('usage');
    const event = { type: 'message.updated', properties: { sessionID: s.sessionId, info: {
      id: 'usage', role: 'assistant', time: { completed: Date.now() },
      tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 7, write: 1 } },
    } } };
    s.emit(event); s.emit(event); s.idle();
  }];
  const r = new EventRecorder(); const c = controller(r);
  const usage: unknown[] = [];
  c.onDidSessionEvent((event) => { if (event.kind === 'usage') usage.push(event.usage); });
  c.start('Explain code', adapter(fake), root);
  await ready(c);
  assert.deepEqual(usage, [{ inputTokens: 18, outputTokens: 5, cachedInputTokens: 7 }]);
  await c.endSession(); await c.whenIdle();
});

test('a correction that leaves the test failing still reports unresolved work', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant(); s.tool('bad-test', 'bash', 'completed', { command: 'node test.js' }, { metadata: { exit: 1 } }); s.idle();
  }, async (s) => { s.assistant('correction'); s.text('claim', 'Done'); s.idle(); }];
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Fix the code', adapter(fake), root);
  await ready(c);
  assert.equal(fake.requests.filter((request) => request.route.endsWith('/prompt_async')).length, 2);
  assert.ok(r.getOperations(id).some((op) => op.status === 'Failed' && op.resultSummary?.includes('Failing test: node test.js')));
  await c.endSession(); await c.whenIdle();
});

test('a real failing test result requests one correction through the existing session and preserves follow-up read-only scope', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [
    async (s) => { s.assistant(); s.tool('failed-test', 'bash', 'completed', { command: 'node test.js' }, { metadata: { exit: 1 } }); s.idle(); },
    async (s) => { s.assistant('correction'); s.tool('passed-test', 'bash', 'completed', { command: 'node test.js' }, { metadata: { exit: 0 } }); s.idle(); },
    async (s) => { s.assistant('followup'); s.idle(); },
  ];
  const r = new EventRecorder();
  const c = controller(r);
  c.start('Fix code and run tests', adapter(fake), root);
  await ready(c);
  const prompts = fake.requests.filter((request) => request.route.endsWith('/prompt_async'));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].body.parts[0].text, /Recorded failing test: node test.js/);
  await c.steer('Only explain. Do not change files.');
  await ready(c);
  assert.equal(fake.requests.filter((request) => request.route.endsWith('/prompt_async')).length, 3);
  await c.endSession(); await c.whenIdle();
});

test('a corrected edit and passing rerun resolve earlier failures even when descriptive arguments change', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant();
    s.tool('test-bad', 'bash', 'completed', { command: 'node test.js', description: 'reproduce' }, { metadata: { exit: 1 } });
    s.tool('edit-bad', 'edit', 'error', { filePath: 'math.js', oldString: 'missing', newString: 'fixed' }, { error: 'not found' });
    s.tool('edit-good', 'edit', 'completed', { filePath: 'math.js', oldString: 'real target', newString: 'fixed' });
    s.tool('test-good', 'bash', 'completed', { command: 'node test.js', description: 'verify fix' }, { metadata: { exit: 0 } });
    s.idle();
  }];
  const r = new EventRecorder();
  const c = controller(r);
  const id = c.start('Fix code', adapter(fake), root);
  await ready(c);
  assert.ok(!r.getOperations(id).some((op) => op.description === 'Local task has unresolved work'));
  await c.endSession(); await c.whenIdle();
});

test('three identical failed actions stop execution while preserving the native session', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant();
    for (let i = 0; i < 3; i++) {
      s.tool('failed-' + i, 'edit', 'error', { filePath: 'math.js', oldString: 'missing', newString: 'fixed' }, { error: 'target not found' });
    }
  }];
  const r = new EventRecorder();
  const c = controller(r);
  const id = c.start('Fix the utility', adapter(fake), root);
  await c.whenIdle();
  assert.equal(fake.aborted, true);
  assert.equal(r.getTask(id)?.session?.id, fake.sessionId);
  assert.equal(r.getTask(id)?.status, 'Failed');
  assert.ok(r.getOperations(id).some((op) => op.description === 'Repeated unsuccessful local action'));
});

test('a completion message cannot hide pending todos and failed tool results', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant();
    s.tool('todo', 'todowrite', 'completed', { todos: [{ content: 'Document behavior in README', status: 'pending' }] });
    s.tool('broken', 'edit', 'error', { filePath: 'README.md', oldString: 'missing', newString: 'text' }, { error: 'target not found' });
    s.text('claim', 'Everything is complete.');
    s.idle();
  }, async (s) => { s.assistant('next'); s.idle(); }];
  const r = new EventRecorder();
  const c = controller(r);
  const id = c.start('Fix code and document it', adapter(fake), root);
  await ready(c);
  assert.ok(r.getOperations(id).some((op) => op.status === 'Failed' && op.resultSummary?.includes('Document behavior in README')));
  await c.steer('Continue pending work');
  await ready(c);
  const system = fake.requests.filter((request) => request.route.endsWith('/prompt_async'))[1].body.system;
  assert.match(system, /Fix code and document it/);
  assert.match(system, /Document behavior in README/);
  await c.endSession(); await c.whenIdle();
});

test('runaway native model steps stop the turn without discarding its session', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    for (let i = 0; i < 49; i++) {
      const event = { type: 'message.part.updated', properties: { sessionID: s.sessionId, part: { type: 'step-start', id: 'step-' + i } } };
      s.emit(event);
      s.emit(event);
    }
  }];
  const r = new EventRecorder();
  const c = controller(r);
  const id = c.start('Fix the utility', adapter(fake), root);
  await c.whenIdle();
  assert.equal(fake.aborted, true);
  assert.equal(r.getTask(id)?.session?.id, fake.sessionId);
  assert.equal(r.getTask(id)?.status, 'Failed');
  assert.equal(r.getOperations(id).filter((op) => op.description === 'Local agent step limit reached').length, 1);
});
function adapter(fake: FakeOpenCode, resumeSessionId?: string) {
  return new OpenCodeAdapter({ resumeSessionId, connector: async () => fake, launch: { executable: 'fixture', homeDir: root, ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
}
function controller(r: EventRecorder) { return new AgentController(new MockAgentAdapter(), r, { stepDelayMs: () => 0, workspaceRoot: () => root }); }
async function ready(c: AgentController) {
  const end = Date.now() + 3000;
  while (!c.getSnapshot().awaitingInput && c.isActive && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.getSnapshot().awaitingInput, true);
}

test('local follow-ups deliver text and image bytes as native OpenCode parts', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => s.idle(), async (s) => s.idle()];
  const r = new EventRecorder(); const c = controller(r);
  c.start('Hello', adapter(fake), root); await ready(c);
  await c.steer('See attachments', [{ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('attached notes').toString('base64') }, { name: 'screen.png', mime: 'image/png', data: 'aW1hZ2U=' }]);
  await ready(c);
  const body = fake.requests.filter((request) => request.route.endsWith('/prompt_async'))[1].body;
  assert.match(body.parts[0].text, /attached notes/);
  assert.deepEqual(body.parts[1], { type: 'file', mime: 'image/png', filename: 'screen.png', url: 'data:image/png;base64,aW1hZ2U=' });
  await c.endSession(); await c.whenIdle();
});

test('native local session survives recorder reload and new runtime, keeping one conversation and per-turn results', async () => {
  let saved: PersistedHistory | undefined;
  const storage = { load: () => saved, save: (h: PersistedHistory) => { saved = structuredClone(h); } };
  const first = new FakeOpenCode();
  first.directory = root;
  first.turns = [async (s) => { s.assistant(); s.text('answer1', 'I explained divide().'); s.idle(); s.idle(); }];
  let recorder = new EventRecorder(storage);
  let c = controller(recorder);
  const id = c.start('Explain divide()', adapter(first), root);
  await ready(c);
  assert.equal(recorder.getTask(id)!.turns?.length, 1, 'duplicate idle never creates duplicate results');
  assert.equal(recorder.getTask(id)!.turns![0].status, 'Completed');
  assert.match(recorder.getTask(id)!.turns![0].report!, /No recorded file edits/);
  const view = buildActivityViewModel(recorder, c.getSnapshot(), { follow: true, language: 'en' });
  assert.equal(view.header.statusLabel, 'Turn complete · waiting for input');
  assert.equal(view.header.currentOperation, undefined);
  const n = first.requests.length;
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(first.requests.length, n, 'idle does not generate background requests');
  const session = recorder.getTask(id)!.session!;
  await c.endSession(); await c.whenIdle(); recorder.dispose();

  recorder = new EventRecorder(storage);
  c = controller(recorder);
  const second = new FakeOpenCode(); second.directory = root;
  second.turns = [async (s) => { s.assistant(); s.text('answer2', 'The previous function was divide().'); s.idle(); }];
  assert.equal(c.start('What did you explain?', adapter(second, session.id), root, { taskId: id, userMessage: 'What did you explain?' }), id);
  await ready(c);
  assert.ok(second.requests.some((r) => r.method === 'GET' && r.route === `/session/${session.id}`));
  assert.ok(!second.requests.some((r) => r.method === 'POST' && r.route === '/session'), 'native resume never creates a replacement session');
  assert.equal(second.requests.find((r) => r.route.endsWith('/prompt_async'))!.body.parts[0].text, 'What did you explain?', 'only the new instruction is sent, not transcript replay');
  assert.equal(recorder.getTasks().length, 1);
  assert.equal(recorder.getTask(id)!.turns?.length, 2);
  assert.equal(recorder.getTask(id)!.messages?.length, 4);
  await c.endSession(); await c.whenIdle();
});

test('resuming a session in a different project fails before prompting and never silently replaces it', async () => {
  const fake = new FakeOpenCode(); fake.directory = path.join(root, 'other-project');
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Continue', adapter(fake, fake.sessionId), root);
  await c.whenIdle();
  assert.equal(r.getTask(id)!.status, 'Failed');
  assert.match(r.getTask(id)!.turns![0].report!, /does not match/);
  assert.equal(fake.requests.filter((request) => request.route.endsWith('/prompt_async')).length, 0);
});

test('approval blocks the turn; completed test results are visible before ending the session; no extra inference', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant();
    s.tool('test', 'bash', 'running', { command: 'node test.js' });
    const decision = await s.permission('perm-test', 'bash', 'test', { command: 'node test.js' });
    assert.equal(decision, 'once');
    s.tool('test', 'bash', 'completed', { command: 'node test.js' }, { output: 'passed', metadata: { exit: 0 } });
    s.text('answer', 'Tests passed.'); s.idle();
  }];
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Run tests', adapter(fake), root);
  while (!c.getSnapshot().awaitingApprovalFor) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(r.getTask(id)!.turns![0].status, 'Running');
  await assert.rejects(c.steer('Another request'), /current turn/);
  await assert.rejects(c.endSession(), /still working/);
  c.approve(c.getSnapshot().awaitingApprovalFor!);
  await ready(c);
  assert.equal(r.getTask(id)!.status, 'Running', 'session remains open');
  assert.match(r.getTask(id)!.turns![0].report!, /node test\.js: Completed, exit 0/);
  assert.equal(fake.requests.filter((request) => request.route.endsWith('/prompt_async')).length, 1);
  const old = r.startTask({ description: 'Older finished conversation', source: 'local', adapterName: 'Local', simulated: false });
  r.finishTask(old.taskId, 'Completed');
  const history = buildActivityViewModel(r, c.getSnapshot(), { follow: false, selectedTaskId: old.taskId, language: 'en' });
  assert.equal(history.header.statusLabel, 'Completed');
  assert.equal(history.controls.canStop, false);
  await c.endSession(); await c.whenIdle();
});

test('stop interrupts a round and reload never changes an unfinished turn into completed', async () => {
  let saved: PersistedHistory | undefined;
  const r = new EventRecorder({ load: () => undefined, save: (h) => { saved = structuredClone(h); } });
  const c = controller(r); const fake = new FakeOpenCode();
  fake.turns = [async () => {}];
  const id = c.start('Work', adapter(fake), root);
  await new Promise((resolve) => setTimeout(resolve, 10));
  c.stop(); await c.whenIdle();
  assert.equal(r.getTask(id)!.turns![0].status, 'Stopped');
  const interrupted = new EventRecorder();
  const t = interrupted.startTask({ description: 'Unfinished', source: 'local', adapterName: 'Local', simulated: false });
  interrupted.startTurn(t.taskId);
  const data = { version: 1 as const, tasks: interrupted.getTasks(), operations: [], changes: [] };
  const reload = new EventRecorder({ load: () => data, save: () => {} });
  assert.equal(reload.getTask(t.taskId)!.turns![0].status, 'Stopped');
  assert.ok(saved);
});

test('thinking-only generation reaching the output limit is reported as failure, without persisting reasoning', async () => {
  const fake = new FakeOpenCode();
  let thinkingLabel = '';
  fake.turns = [async (s) => {
    s.assistant('long-answer');
    s.emit({ type: 'message.part.updated', properties: { sessionID: s.sessionId, part: { id: 'reasoning-part', messageID: 'long-answer', type: 'reasoning', text: 'PRIVATE_REASONING_DO_NOT_STORE' } } });
    thinkingLabel = buildActivityViewModel(r, c.getSnapshot(), { follow: false, language: 'en' }).header.statusLabel;
    s.emit({ type: 'message.part.delta', properties: { sessionID: s.sessionId, partID: 'reasoning-part', field: 'text', delta: ' more reasoning' } });
    const complete = { type: 'message.updated', properties: { sessionID: s.sessionId, info: { id: 'long-answer', role: 'assistant', modelID: 'qwen3:8b', providerID: 'ollama', finish: 'length' } } };
    s.emit(complete); s.emit(complete); s.idle();
  }];
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Create a game', adapter(fake), root);
  await ready(c);
  assert.match(thinkingLabel, /reasoning/);
  const turn = r.getTask(id)!.turns![0];
  assert.equal(turn.failedOperations, 1, 'a duplicate final event must not duplicate the warning');
  assert.match(turn.report!, /output limit/);
  assert.match(turn.report!, /No recorded file edits/);
  assert.ok(!JSON.stringify(r.exportHistory()).includes('PRIVATE_REASONING_DO_NOT_STORE'));
  assert.equal(c.getSnapshot().progress, undefined, 'idle clears thinking status');
  await c.endSession(); await c.whenIdle();
});

test('failed outside-project writes plus successful echo do not produce an unqualified completed report', async () => {
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => {
    s.assistant();
    s.tool('wrong-path', 'write', 'error', { filePath: path.join(os.tmpdir(), 'outside-game', 'resource.js'), content: 'export const resources = {};' }, { error: 'external_directory denied' });
    s.tool('only-echo', 'bash', 'completed', { command: 'echo generated files' }, { metadata: { exit: 0, output: 'generated files' } });
    s.idle();
  }];
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Create game files', adapter(fake), root);
  await ready(c);
  const report = r.getTask(id)!.turns![0].report!;
  assert.match(report, /Finished with failed operations/);
  assert.match(report, /resource\.js: Failed/);
  assert.match(report, /external_directory denied/);
  assert.match(report, /echo generated files: Completed, exit 0/);
  const prompt = fake.requests.find((request) => request.route.endsWith('/prompt_async'))!.body;
  assert.ok(prompt.system.includes(JSON.stringify(root)));
  await c.endSession(); await c.whenIdle();
});

test('a failed approval response ends the runtime with a visible error instead of silently hanging', async () => {
  const fake = new FakeOpenCode();
  const request = fake.request.bind(fake);
  fake.request = async (method, route, body) => {
    if (route.includes('/permission/')) throw new Error('Test connection closed');
    return request(method, route, body);
  };
  fake.turns = [async (s) => {
    s.assistant(); s.tool('write', 'write', 'running', { filePath: path.join(root, 'index.html'), content: '<html></html>' });
    void s.permission('write-permission', 'edit', 'write', { filepath: path.join(root, 'index.html') });
  }];
  const r = new EventRecorder(); const c = controller(r);
  const id = c.start('Create index.html', adapter(fake), root);
  while (!c.getSnapshot().awaitingApprovalFor) await new Promise((resolve) => setTimeout(resolve, 5));
  c.approve(c.getSnapshot().awaitingApprovalFor!);
  await c.whenIdle();
  assert.equal(r.getTask(id)!.status, 'Failed');
  assert.match(r.getTask(id)!.summary!, /Permission reply could not be confirmed/);
});
