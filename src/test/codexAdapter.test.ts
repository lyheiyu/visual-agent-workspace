import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AgentController, ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { CodexAppServerAdapter } from '../adapters/codex/CodexAppServerAdapter';
import { CodexRpcClient } from '../adapters/codex/CodexRpcClient';
import { CodexProfileId, getProfile } from '../adapters/codex/profiles';
import { ProposedChangeContent } from '../types/events';
import { commandItem, FakeCodexServer, fileChangeItem } from './support/fakeCodex';

const ROOT = path.resolve(__dirname, '..', '..', 'demo-workspace');

function setup(profile: CodexProfileId, script?: (s: FakeCodexServer) => Promise<void>) {
  const server = new FakeCodexServer();
  if (script) {
    server.onTurnStarted = script;
  }
  const recorder = new EventRecorder();
  const logs: string[] = [];
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, {
    stepDelayMs: () => 0,
    workspaceRoot: () => ROOT,
    log: (m) => logs.push(m),
  });
  const changes: ProposedChangeContent[] = [];
  controller.onDidProposeChange((c) => changes.push(c));
  const adapter = new CodexAppServerAdapter({
    connector: () => new CodexRpcClient(server),
    profile: getProfile(profile),
  });
  return { server, recorder, controller, adapter, changes, logs };
}

function waitFor(controller: AgentController, predicate: (s: ControllerSnapshot) => boolean): Promise<ControllerSnapshot> {
  return new Promise((resolve) => {
    if (predicate(controller.getSnapshot())) {
      resolve(controller.getSnapshot());
      return;
    }
    const sub = controller.onDidChangeState((s) => {
      if (predicate(s)) {
        sub.dispose();
        resolve(s);
      }
    });
  });
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('observe profile: handshake, isolation-safe thread params, observed-only command', async () => {
  const { server, recorder, controller, adapter } = setup('observe', async (s) => {
    s.itemStarted(commandItem(ROOT));
    s.notify('item/commandExecution/outputDelta', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-1', delta: 'x' });
    s.itemCompleted(commandItem(ROOT, { status: 'completed', exitCode: 0, aggregatedOutput: 'def validate_samples', durationMs: 12 }));
    s.itemCompleted({ type: 'agentMessage', id: 'msg-1', text: 'validate_samples() only checks sample_id.\nMore.' });
    s.completeTurn('completed');
  });
  const taskId = controller.start('Explain validate_samples()', adapter);
  await controller.whenIdle();

  assert.deepEqual(server.sentMethods(), ['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start']);
  const threadStart = server.received.find((m) => m.method === 'thread/start')!.params;
  assert.equal(threadStart.sandbox, 'read-only');
  assert.equal(threadStart.approvalPolicy, 'on-request');
  assert.equal(threadStart.ephemeral, true);
  assert.equal(threadStart.cwd, ROOT);
  assert.equal(server.received.find((m) => m.method === 'turn/start')!.params.input[0].text, 'Explain validate_samples()');

  const ops = recorder.getOperations(taskId);
  assert.deepEqual(ops.map((o) => o.operationType), ['Analyze', 'Read', 'Analyze', 'Summary']);
  const read = ops[1];
  assert.equal(read.filePath, 'validation.py');
  assert.equal(read.status, 'Completed');
  assert.equal(read.enforcement, 'none', 'observed only');
  assert.equal(read.requiresApproval, false);
  assert.equal(read.simulated, false);
  assert.equal(read.command?.simulated, false);
  assert.equal(read.command?.exitCode, 0);
  assert.equal(read.command?.outputCombined, true);
  assert.match(read.history.find((h) => h.status === 'Running')!.note!, /without having asked/);
  assert.match(ops[2].description, /^Codex: validate_samples\(\) only checks sample_id\.$/);
  assert.match(ops[0].resultSummary!, /sandbox=readOnly/);
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
  assert.equal(server.closed, true, 'app-server process closed at the end of the task');
});

test('boundary check: aborts before any turn if Codex does not confirm read-only', async () => {
  const { server, recorder, controller, adapter } = setup('observe');
  server.threadStartOverride = { sandbox: { type: 'workspaceWrite' } };
  const taskId = controller.start('x', adapter);
  await controller.whenIdle();
  assert.ok(!server.sentMethods().includes('turn/start'));
  assert.equal(recorder.getTask(taskId)!.status, 'Failed');
  assert.match(recorder.getTask(taskId)!.summary!, /did not confirm the requested boundary/);
});

test('approve-commands: approval is intercepted; accept and decline are sent to Codex', async () => {
  const replies: unknown[] = [];
  const { recorder, controller, adapter } = setup('approve-commands', async (s) => {
    s.itemStarted(commandItem(ROOT, { id: 'exec-a' }));
    replies.push((await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-a', kind: 'command' })).result);
    s.itemCompleted(commandItem(ROOT, { id: 'exec-a', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }));
    s.itemStarted(commandItem(ROOT, { id: 'exec-b', command: 'rm -rf build', commandActions: [{ type: 'unknown', command: 'rm -rf build' }] }));
    replies.push((await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-b', reason: 'cleanup' })).result);
    s.itemCompleted(commandItem(ROOT, { id: 'exec-b', status: 'declined', command: 'rm -rf build', commandActions: [] }));
    s.completeTurn('completed');
  });
  const taskId = controller.start('t', adapter);

  let snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  const first = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(first.status, 'Proposed');
  assert.equal(first.enforcement, 'agent-approval');
  assert.equal(first.requiresApproval, true);
  assert.ok(controller.approve(first.operationId));

  snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor && x.awaitingApprovalFor !== first.operationId);
  const second = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(second.description, 'Run: rm -rf build');
  assert.match(second.history.map((h) => h.note).join(' '), /cleanup/);
  assert.ok(controller.reject(second.operationId, 'not needed'));
  await controller.whenIdle();

  assert.deepEqual(replies, [{ decision: 'accept' }, { decision: 'decline' }]);
  const ops = recorder.getOperations(taskId);
  assert.equal(ops.find((o) => o.operationId === first.operationId)!.status, 'Completed');
  const rejected = ops.find((o) => o.operationId === second.operationId)!;
  assert.equal(rejected.status, 'Rejected');
  assert.equal(rejected.command?.status, 'NotRun');
  assert.equal(rejected.history.filter((h) => h.status === 'Rejected').length, 1, 'late "declined" from Codex ignored');
});

test('read-only profiles decline file changes automatically, but the diff is still reviewable', async () => {
  let reply: unknown;
  const file = path.join(ROOT, 'validation.py');
  const { recorder, controller, adapter, changes } = setup('approve-commands', async (s) => {
    s.itemStarted(fileChangeItem(file));
    reply = (await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'patch-1' })).result;
    s.itemCompleted(fileChangeItem(file, { status: 'declined' }));
    s.completeTurn('completed');
  });
  const taskId = controller.start('t', adapter);
  await controller.whenIdle();
  assert.deepEqual(reply, { decision: 'decline' });
  const edit = recorder.getOperations(taskId).find((o) => o.operationType === 'Edit')!;
  assert.equal(edit.status, 'Rejected');
  assert.equal(edit.filePath, 'validation.py');
  // The real hunk appends after summarize(), at module level: no function is claimed.
  assert.equal(edit.functionName, undefined);
  assert.equal(edit.lineNumber, 27);
  assert.equal(edit.description, 'Edit validation.py (+1 −0)');
  assert.match(edit.rationale!, /ENTIRE patch/);
  assert.match(edit.history.at(-1)!.note!, /Declined automatically/);
  assert.equal(recorder.getChange(edit.associatedChangeId!)!.decision, 'Rejected');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].unifiedDiff, '@@ -26 +26,2 @@\n     }\n+# reviewed\n');
  assert.equal(changes[0].changeKind, 'update');
});

test('approve-edits: patches outside the workspace or in .git are declined; inside ones need approval', async () => {
  const replies: unknown[] = [];
  const outsideFile = path.resolve(ROOT, '..', 'package.json');
  const { recorder, controller, adapter } = setup('approve-edits', async (s) => {
    s.itemStarted(fileChangeItem(outsideFile, { id: 'p-out' }));
    replies.push((await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-out' })).result);
    s.itemStarted(fileChangeItem(path.join(ROOT, '.git', 'config'), { id: 'p-git' }));
    replies.push((await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-git' })).result);
    replies.push((await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-unknown' })).result);
    s.itemStarted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-in' }));
    replies.push((await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-in' })).result);
    s.itemCompleted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-in', status: 'completed' }));
    s.completeTurn('completed');
  });
  controller.start('t', adapter);
  const snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  assert.equal(recorder.getOperation(snap.awaitingApprovalFor!)!.externalId, 'p-in');
  controller.approve(snap.awaitingApprovalFor!);
  await controller.whenIdle();
  assert.deepEqual(replies, [{ decision: 'decline' }, { decision: 'decline' }, { decision: 'decline' }, { decision: 'accept' }]);
  const approved = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(approved.status, 'Completed');
  assert.equal(approved.resultSummary, 'Patch applied by Codex.');
  assert.equal(recorder.getChange(approved.associatedChangeId!)!.decision, 'Approved');
});

test('observe profile declines command escalations and permission requests automatically', async () => {
  const replies: unknown[] = [];
  const { controller, adapter, recorder } = setup('observe', async (s) => {
    s.itemStarted(commandItem(ROOT, { id: 'esc' }));
    replies.push((await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'esc', reason: 'needs network' })).result);
    replies.push((await s.request('item/permissions/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'perm', permissions: { network: {} } })).result);
    replies.push((await s.request('item/tool/requestUserInput', { questions: [] })).result);
    s.completeTurn('completed');
  });
  const taskId = controller.start('t', adapter);
  await controller.whenIdle();
  assert.deepEqual(replies, [{ decision: 'decline' }, { permissions: {}, scope: 'turn' }, { answers: {} }]);
  assert.equal(controller.getSnapshot().pendingApprovals.length, 0, 'user was never asked');
  assert.ok(recorder.getOperations(taskId).filter((o) => o.status === 'Rejected').length >= 3);
});

test('Stop sends turn/interrupt and answers a pending approval with "cancel"', async () => {
  let reply: unknown;
  const { server, recorder, controller, adapter } = setup('approve-commands', async (s) => {
    s.itemStarted(commandItem(ROOT, { id: 'exec-x' }));
    reply = (await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-x' })).result;
  });
  const taskId = controller.start('t', adapter);
  const snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  assert.equal(controller.pause(), false, 'Codex has no pause; it is not offered');
  assert.ok(controller.stop());
  await controller.whenIdle();
  assert.deepEqual(reply, { decision: 'cancel' });
  const interrupt = server.received.find((m) => m.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, { threadId: 'thr-1', turnId: 'turn-1' });
  assert.equal(recorder.getOperation(snap.awaitingApprovalFor!)!.status, 'Cancelled');
  assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
});

test('steer: delivered with expectedTurnId and recorded; failures are recorded too', async () => {
  let release!: () => void;
  const { server, recorder, controller, adapter } = setup('observe', async (s) => {
    await new Promise<void>((r) => (release = r));
    s.completeTurn('completed');
  });
  const taskId = controller.start('t', adapter);
  while (!server.sentMethods().includes('turn/start')) {
    await tick();
  }
  await tick(10);
  const op = await controller.steer('Only touch validation.py');
  assert.equal(op.status, 'Completed');
  assert.equal(op.operationType, 'Instruct');
  const steerMsg = server.received.find((m) => m.method === 'turn/steer')!;
  assert.equal(steerMsg.params.expectedTurnId, 'turn-1');
  assert.equal(steerMsg.params.input[0].text, 'Only touch validation.py');

  server.handlers['turn/steer'] = () => {
    throw new Error('expected turn mismatch');
  };
  await assert.rejects(controller.steer('again'), /expected turn mismatch/);
  await assert.rejects(controller.steer('   '), /empty/);
  await assert.rejects(controller.steer('x'.repeat(5000)), /limited/);
  release();
  await controller.whenIdle();
  const instructs = recorder.getOperations(taskId).filter((o) => o.operationType === 'Instruct');
  assert.deepEqual(instructs.map((o) => o.status), ['Completed', 'Failed']);
  await assert.rejects(controller.steer('late'), /No running task/);
});

test('app-server crash mid-turn fails the task and closes open operations', async () => {
  const { recorder, controller, adapter } = setup('observe', async (s) => {
    s.itemStarted(commandItem(ROOT, { id: 'exec-z' }));
    await tick();
    s.crash('exit code 3');
  });
  const taskId = controller.start('t', adapter);
  await controller.whenIdle();
  const task = recorder.getTask(taskId)!;
  assert.equal(task.status, 'Failed');
  assert.match(task.summary!, /exited unexpectedly/);
  assert.equal(recorder.getOperations(taskId).find((o) => o.externalId === 'exec-z')!.status, 'Cancelled');
});

test('mock demo still works after Codex tasks (adapter is per task)', async () => {
  const { recorder, controller, adapter } = setup('observe');
  controller.start('codex', adapter);
  await controller.whenIdle();
  const demo = controller.start('demo', new MockAgentAdapter(undefined, { durationScale: 0 }));
  assert.equal(controller.getSnapshot().capabilities.pause, true);
  const s = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  controller.approve(s.awaitingApprovalFor!);
  await controller.whenIdle();
  assert.equal(recorder.getTask(demo)!.status, 'Completed');
  assert.ok(recorder.getOperations(demo).every((o) => o.enforcement === 'controller'));
});
