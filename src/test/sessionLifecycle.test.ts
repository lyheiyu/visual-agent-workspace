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
function adapter(fake: FakeOpenCode, resumeSessionId?: string) {
  return new OpenCodeAdapter({ resumeSessionId, connector: async () => fake, launch: { executable: 'fixture', homeDir: root, ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
}
function controller(r: EventRecorder) { return new AgentController(new MockAgentAdapter(), r, { stepDelayMs: () => 0, workspaceRoot: () => root }); }
async function ready(c: AgentController) {
  const end = Date.now() + 3000;
  while (!c.getSnapshot().awaitingInput && c.isActive && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.getSnapshot().awaitingInput, true);
}

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
