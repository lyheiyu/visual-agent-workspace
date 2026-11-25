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
import { CODEX_ADD_CONTENT_CASE } from './support/shellFixtures';

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

/** Codex sessions are multi-turn: wait until the turn ended (or the task did), then end the session. */
async function settle(controller: AgentController): Promise<void> {
  const s = await waitFor(controller, (x) => x.awaitingInput || x.taskStatus !== 'Running');
  if (controller.isActive && s.awaitingInput) await controller.endSession();
  await controller.whenIdle();
}

test('Codex steering delivers image input alongside attached text', async () => {
  const { server, controller, adapter } = setup('observe', async () => {});
  controller.start('Wait', adapter);
  const deadline = Date.now() + 3000;
  while (!server.received.some((m) => m.method === 'turn/start') && Date.now() < deadline) await tick();
  await tick();
  await controller.steer('Look', [{ name: 'screen.png', mime: 'image/png', data: 'aW1hZ2U=' }]);
  const input = server.received.find((m) => m.method === 'turn/steer')!.params.input;
  assert.equal(input[1].type, 'image');
  assert.equal(input[1].url, 'data:image/png;base64,aW1hZ2U=');
  server.completeTurn('completed'); await settle(controller);
});

test('observe profile: handshake, isolation-safe thread params, observed-only command', async () => {
  const { server, recorder, controller, adapter } = setup('observe', async (s) => {
    s.itemStarted(commandItem(ROOT));
    s.notify('item/commandExecution/outputDelta', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-1', delta: 'x' });
    s.itemCompleted(commandItem(ROOT, { status: 'completed', exitCode: 0, aggregatedOutput: 'def validate_samples', durationMs: 12 }));
    s.itemCompleted({ type: 'agentMessage', id: 'msg-1', text: 'validate_samples() only checks sample_id.\nMore.' });
    s.completeTurn('completed');
  });
  const taskId = controller.start('Explain validate_samples()', adapter);
  await settle(controller);

  assert.deepEqual(server.sentMethods(), ['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start']);
  const threadStart = server.received.find((m) => m.method === 'thread/start')!.params;
  assert.equal(threadStart.sandbox, 'read-only');
  assert.equal(threadStart.approvalPolicy, 'on-request');
  assert.equal(threadStart.ephemeral, false, 'stored by Codex so the conversation can resume this thread');
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
  await settle(controller);
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
  await settle(controller);

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
  await settle(controller);
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
  await settle(controller);
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
  await settle(controller);
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
  await settle(controller);
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
  await settle(controller);
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
  await settle(controller);
  const task = recorder.getTask(taskId)!;
  assert.equal(task.status, 'Failed');
  assert.match(task.summary!, /exited unexpectedly/);
  assert.equal(recorder.getOperations(taskId).find((o) => o.externalId === 'exec-z')!.status, 'Cancelled');
});

test('mock demo still works after Codex tasks (adapter is per task)', async () => {
  const { recorder, controller, adapter } = setup('observe');
  controller.start('codex', adapter);
  await settle(controller);
  const demo = controller.start('demo', new MockAgentAdapter(undefined, { durationScale: 0 }));
  assert.equal(controller.getSnapshot().capabilities.pause, true);
  const s = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  controller.approve(s.awaitingApprovalFor!);
  await settle(controller);
  assert.equal(recorder.getTask(demo)!.status, 'Completed');
  assert.ok(recorder.getOperations(demo).every((o) => o.enforcement === 'controller'));
});

test('declined Codex proposals: the reason / feedback reaches Codex via turn/steer, and delivery is recorded', async () => {
  const replies: unknown[] = [];
  const { server, recorder, controller, adapter } = setup('approve-edits', async (s) => {
    s.itemStarted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-1' }));
    replies.push((await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-1' })).result);
    await tick(40); // the turn is still active while the reason is sent
    s.itemCompleted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-1', status: 'declined' }));
    s.completeTurn('completed');
  });
  const taskId = controller.start('t', adapter);
  const snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  controller.reject(snap.awaitingApprovalFor!, 'Regenerate requested by the user. Feedback: keep the public signature.');
  await settle(controller);
  assert.deepEqual(replies, [{ decision: 'decline' }], 'the approval reply itself has no message field');
  const steer = server.received.find((m) => m.method === 'turn/steer')!;
  assert.ok(steer, 'reason sent as a steer');
  assert.equal(steer.params.expectedTurnId, 'turn-1');
  assert.match(steer.params.input[0].text, /declined your proposed file change[\s\S]*Feedback: keep the public signature/);
  const delivered = recorder.getOperations(taskId).find((o) => o.operationType === 'Instruct' && /decline reason/.test(o.description))!;
  assert.equal(delivered.status, 'Completed');
  assert.match(delivered.resultSummary!, /Delivered/);
});

test('declined Codex proposal after the turn ended: recorded as NOT delivered (never silently dropped)', async () => {
  const { server, recorder, controller, adapter } = setup('approve-commands', async (s) => {
    s.itemStarted(commandItem(ROOT, { id: 'exec-x', command: 'rm -rf build' }));
    await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-x' });
    s.completeTurn('completed');
  });
  server.handlers['turn/steer'] = () => {
    throw Object.assign(new Error('no active turn'), { code: -32600 });
  };
  const taskId = controller.start('t', adapter);
  const snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  controller.reject(snap.awaitingApprovalFor!, 'not needed');
  await settle(controller);
  await tick(20);
  const op = recorder.getOperations(taskId).find((o) => o.operationType === 'Instruct' && /decline reason/.test(o.description));
  assert.ok(op, 'delivery attempt is visible');
  assert.equal(op!.status === 'Failed' || op!.status === 'Cancelled', true, op!.status);
  if (op!.status === 'Failed') assert.match(op!.resultSummary!, /NOT delivered/);
});

test('shell source writes: the Add-Content case is blocked before the user is asked; patches and test/build commands still go to the user', async () => {
  const replies: Array<{ step: string; result: unknown }> = [];
  const { server, recorder, controller, adapter, changes } = setup('approve-edits', async (s) => {
    // 1. The supplied case: an explicit shell write of style.css.
    s.itemStarted(commandItem(ROOT, { id: 'exec-w', command: CODEX_ADD_CONTENT_CASE, commandActions: [{ type: 'unknown', command: CODEX_ADD_CONTENT_CASE }] }));
    replies.push({ step: 'write', result: (await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'exec-w', reason: '是否允许写入 style.css？' })).result });
    await tick(40); // the turn is still active while the block reason is delivered
    s.itemCompleted(commandItem(ROOT, { id: 'exec-w', status: 'declined', command: CODEX_ADD_CONTENT_CASE, commandActions: [] }));
    // 2. Normal patch: still reviewed and approved by the user.
    s.itemStarted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-ok' }));
    replies.push({ step: 'patch', result: (await s.request('item/fileChange/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: 'p-ok' })).result });
    s.itemCompleted(fileChangeItem(path.join(ROOT, 'validation.py'), { id: 'p-ok', status: 'completed' }));
    // 3. Tests and builds: command approval, with the "may generate files" note.
    for (const [id, command] of [['exec-t', 'npm test'], ['exec-b', 'npm run build']]) {
      s.itemStarted(commandItem(ROOT, { id, command, commandActions: [{ type: 'unknown', command }] }));
      replies.push({ step: id, result: (await s.request('item/commandExecution/requestApproval', { threadId: s.threadId, turnId: s.turnId, itemId: id })).result });
      s.itemCompleted(commandItem(ROOT, { id, command, status: 'completed', exitCode: 0, aggregatedOutput: 'ok', commandActions: [] }));
    }
    s.completeTurn('completed');
  });
  const taskId = controller.start('Match the dashboard palette', adapter);

  // The first thing the user is asked about is the patch: the shell write never reached them.
  let snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor);
  const patch = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(patch.operationType, 'Edit');
  assert.equal(changes.length, 1, 'the patch diff is available before approval');
  assert.match(changes[0].unifiedDiff ?? '', /\+# reviewed/);
  assert.ok(controller.approve(patch.operationId));

  for (const command of ['npm test', 'npm run build']) {
    snap = await waitFor(controller, (x) => !!x.awaitingApprovalFor && recorder.getOperation(x.awaitingApprovalFor)!.command?.command === command);
    const op = recorder.getOperation(snap.awaitingApprovalFor!)!;
    assert.match(op.history.map((h) => h.note).join(' '), /may create or change files[\s\S]*No diff is available before it runs/, command);
    assert.ok(controller.approve(op.operationId));
  }
  await settle(controller);

  assert.deepEqual(replies, [
    { step: 'write', result: { decision: 'decline' } },
    { step: 'patch', result: { decision: 'accept' } },
    { step: 'exec-t', result: { decision: 'accept' } },
    { step: 'exec-b', result: { decision: 'accept' } },
  ]);
  const ops = recorder.getOperations(taskId);
  const blocked = ops.find((o) => o.externalId === 'exec-w')!;
  assert.equal(blocked.status, 'Rejected');
  assert.equal(blocked.command?.status, 'NotRun', 'never executed');
  assert.ok(!blocked.history.some((h) => h.actor === 'user'), 'decided without asking the user');
  assert.match(blocked.history.at(-1)!.note!, /Blocked before execution: the command writes files through the shell \(Add-Content → web\/style\.css\)/);
  const steer = server.received.find((m) => m.method === 'turn/steer')!;
  assert.ok(steer, 'the agent is told why, in the same turn');
  assert.equal(steer.params.expectedTurnId, 'turn-1');
  assert.match(steer.params.input[0].text, /^Blocked before execution by Visual Agent Workspace[\s\S]*Resubmit the change with your file edit \/ patch tool/);
  assert.doesNotMatch(steer.params.input[0].text, /The user declined/);
  const delivered = ops.find((o) => o.operationType === 'Instruct')!;
  assert.match(delivered.description, /Send block reason to Codex/);
  assert.match(delivered.resultSummary!, /Delivered/);
  // Agents are told up front to use the patch tool.
  assert.match(server.received.find((m) => m.method === 'thread/start')!.params.developerInstructions, /file edit \/ patch tool[\s\S]*blocked before they run/);
});

test('read-only Codex profiles get no edit instructions (they decline edits anyway)', async () => {
  const { server, controller, adapter } = setup('observe', async (s) => s.completeTurn('completed'));
  controller.start('x', adapter);
  await settle(controller);
  assert.equal(server.received.find((m) => m.method === 'thread/start')!.params.developerInstructions, undefined);
});
