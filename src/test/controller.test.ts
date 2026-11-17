import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentController, strictApprovalPolicy } from '../controller/AgentController';
import { EventRecorder, MemoryHistoryStorage } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { DEMO_SCENARIO } from '../adapters/demoScenario';
import { ControllerSnapshot } from '../controller/AgentController';

function setup(opts: { strict?: boolean } = {}) {
  const storage = new MemoryHistoryStorage();
  const recorder = new EventRecorder(storage);
  const adapter = new MockAgentAdapter(DEMO_SCENARIO, { durationScale: 0 });
  const controller = new AgentController(adapter, recorder, {
    stepDelayMs: () => 0,
    workspaceRoot: () => '/ws',
    approvalPolicy: opts.strict ? () => strictApprovalPolicy : undefined,
  });
  return { storage, recorder, controller };
}

/** Resolve once the controller reaches a state matching `predicate`. */
function waitFor(controller: AgentController, predicate: (s: ControllerSnapshot) => boolean): Promise<ControllerSnapshot> {
  return new Promise((resolve) => {
    const now = controller.getSnapshot();
    if (predicate(now)) {
      resolve(now);
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

const awaitingApproval = (s: ControllerSnapshot) => !!s.awaitingApprovalFor;

test('approved demo runs all steps, tests pass, change approved', async () => {
  const { recorder, controller } = setup();
  const taskId = controller.start('demo');
  const s = await waitFor(controller, awaitingApproval);
  const pending = recorder.getOperation(s.awaitingApprovalFor!)!;
  assert.equal(pending.operationType, 'Edit');
  assert.equal(pending.status, 'Proposed');
  assert.equal(pending.functionName, 'validate_samples');
  assert.ok(controller.approve(pending.operationId));
  await controller.whenIdle();

  const ops = recorder.getOperations(taskId);
  assert.deepEqual(
    ops.map((o) => o.operationType),
    ['Read', 'Analyze', 'Read', 'Analyze', 'Edit', 'Test', 'Summary'],
  );
  assert.deepEqual(ops.map((o) => o.sequenceNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(ops.every((o) => o.simulated && o.taskId === taskId));
  assert.equal(new Set(ops.map((o) => o.operationId)).size, ops.length, 'operation IDs are unique');
  assert.equal(ops[4].status, 'Completed');
  assert.ok(ops[4].history.some((h) => h.actor === 'user' && h.note === 'Approved by user'));

  const testOp = ops[5];
  assert.equal(testOp.status, 'Completed');
  assert.equal(testOp.command?.command, 'python -m pytest tests/test_validation.py -v');
  assert.equal(testOp.command?.workingDirectory, '/ws');
  assert.equal(testOp.command?.simulated, true);
  assert.equal(testOp.command?.exitCode, 0);
  assert.equal(testOp.exitCode, 0);
  assert.match(testOp.command?.stdout ?? '', /SIMULATED OUTPUT/);
  assert.match(testOp.command?.stdout ?? '', /5 passed/);
  assert.ok(testOp.command?.startedAt && testOp.command?.finishedAt);

  const change = recorder.getChange(ops[4].associatedChangeId!)!;
  assert.equal(change.decision, 'Approved');
  const task = recorder.getTask(taskId)!;
  assert.equal(task.status, 'Completed');
  assert.match(task.summary ?? '', /SIMULATED/);
  assert.equal(controller.getSnapshot().taskStatus, 'Completed');
});

test('rejected edit is not executed and later test reflects original code', async () => {
  const { recorder, controller } = setup();
  const taskId = controller.start('demo');
  const s = await waitFor(controller, awaitingApproval);
  assert.ok(controller.reject(s.awaitingApprovalFor!, 'too broad'));
  await controller.whenIdle();
  const ops = recorder.getOperations(taskId);
  const edit = ops.find((o) => o.operationType === 'Edit')!;
  assert.equal(edit.status, 'Rejected');
  assert.ok(!edit.history.some((h) => h.status === 'Running'), 'rejected op never ran');
  assert.equal(recorder.getChange(edit.associatedChangeId!)!.decision, 'Rejected');
  assert.equal(recorder.getChange(edit.associatedChangeId!)!.decisionReason, 'too broad');
  const testOp = ops.find((o) => o.operationType === 'Test')!;
  assert.equal(testOp.status, 'Failed');
  assert.equal(testOp.command?.exitCode, 1);
  assert.match(testOp.command?.stdout ?? '', /3 failed, 2 passed/);
});

test('approve/reject only accept the operation that is actually pending', async () => {
  const { controller } = setup();
  controller.start('demo');
  assert.equal(controller.approve('op-does-not-exist'), false);
  const s = await waitFor(controller, awaitingApproval);
  assert.equal(controller.approve('op-wrong'), false);
  assert.equal(controller.reject('op-wrong'), false);
  assert.ok(controller.approve(s.awaitingApprovalFor!));
  assert.equal(controller.approve(s.awaitingApprovalFor!), false, 'second decision ignored');
  await controller.whenIdle();
  assert.equal(controller.approve(s.awaitingApprovalFor!), false, 'no decisions after completion');
});

test('pause stops dispatch; resume continues', async () => {
  const { recorder, controller } = setup();
  const taskId = controller.start('demo');
  assert.ok(controller.pause());
  assert.equal(controller.pause(), false, 'already paused');
  // Give the loop plenty of turns: nothing beyond the in-flight op may start.
  await new Promise((r) => setTimeout(r, 50));
  const countWhilePaused = recorder.getOperations(taskId).length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(recorder.getOperations(taskId).length, countWhilePaused);
  assert.ok(countWhilePaused <= 1);
  assert.equal(controller.getSnapshot().paused, true);
  assert.equal(controller.getSnapshot().taskStatus, 'Running');

  assert.ok(controller.resume());
  assert.equal(controller.resume(), false, 'not paused anymore');
  const s = await waitFor(controller, awaitingApproval);
  controller.approve(s.awaitingApprovalFor!);
  await controller.whenIdle();
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
});

test('approval while paused waits for resume before executing', async () => {
  const { recorder, controller } = setup();
  controller.start('demo');
  const s = await waitFor(controller, awaitingApproval);
  controller.pause();
  assert.ok(controller.approve(s.awaitingApprovalFor!));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(recorder.getOperation(s.awaitingApprovalFor!)!.status, 'Proposed', 'not executed while paused');
  controller.resume();
  await controller.whenIdle();
  assert.equal(recorder.getOperation(s.awaitingApprovalFor!)!.status, 'Completed');
});

test('stop while awaiting approval cancels it and prevents remaining operations', async () => {
  const { recorder, controller } = setup();
  const taskId = controller.start('demo');
  const s = await waitFor(controller, awaitingApproval);
  assert.ok(controller.stop());
  assert.equal(controller.stop(), false, 'already stopping');
  await controller.whenIdle();
  const ops = recorder.getOperations(taskId);
  const edit = recorder.getOperation(s.awaitingApprovalFor!)!;
  assert.equal(edit.status, 'Cancelled');
  assert.equal(recorder.getChange(edit.associatedChangeId!)!.decision, 'Cancelled');
  assert.ok(!ops.some((o) => o.operationType === 'Test'), 'test step never dispatched');
  assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
  assert.equal(controller.getSnapshot().taskStatus, 'Stopped');
  assert.equal(controller.approve(edit.operationId), false);
  assert.equal(controller.pause(), false);
});

test('stop while paused ends the task', async () => {
  const { recorder, controller } = setup();
  const taskId = controller.start('demo');
  controller.pause();
  await new Promise((r) => setTimeout(r, 20));
  controller.stop();
  await controller.whenIdle();
  assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
  assert.equal(controller.getSnapshot().paused, false);
});

test('stop aborts a running operation', async () => {
  const recorder = new EventRecorder();
  const adapter = new MockAgentAdapter(DEMO_SCENARIO, { durationScale: 100 }); // 40s+ first step
  const controller = new AgentController(adapter, recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' });
  const taskId = controller.start('demo');
  await waitFor(controller, (s) => !!s.currentOperationId && recorder.getOperation(s.currentOperationId)?.status === 'Running');
  controller.stop();
  await controller.whenIdle();
  const ops = recorder.getOperations(taskId).filter((o) => o.operationType !== 'Summary');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, 'Cancelled');
});

test('strict policy gates commands too; rejecting skips execution', async () => {
  const { recorder, controller } = setup({ strict: true });
  const taskId = controller.start('demo');
  let s = await waitFor(controller, awaitingApproval);
  controller.approve(s.awaitingApprovalFor!); // the edit
  s = await waitFor(controller, (x) => !!x.awaitingApprovalFor && x.awaitingApprovalFor !== s.awaitingApprovalFor);
  const testOp = recorder.getOperation(s.awaitingApprovalFor!)!;
  assert.equal(testOp.operationType, 'Test');
  controller.reject(testOp.operationId);
  await controller.whenIdle();
  const after = recorder.getOperation(testOp.operationId)!;
  assert.equal(after.status, 'Rejected');
  assert.equal(after.command?.status, 'NotRun');
  assert.equal(after.command?.stdout, undefined);
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
});

test('cannot start a second task while one is running', async () => {
  const { controller } = setup();
  controller.start('demo');
  assert.throws(() => controller.start('again'));
  controller.stop();
  await controller.whenIdle();
  assert.doesNotThrow(() => controller.start('again'));
  controller.stop();
  await controller.whenIdle();
});
