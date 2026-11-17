import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { buildActivityViewModel } from '../ui/viewModel';

test('view model exposes approval controls only for the pending operation', async () => {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, {
    stepDelayMs: () => 0,
    workspaceRoot: () => '/ws',
  });
  const idle = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true });
  assert.equal(idle.header.statusKind, 'idle');
  assert.equal(idle.controls.canStart, true);
  assert.equal(idle.controls.canPause, false);

  controller.start('demo');
  const pendingId = await new Promise<string>((resolve) => {
    const sub = controller.onDidChangeState((s) => {
      if (s.awaitingApprovalFor) {
        sub.dispose();
        resolve(s.awaitingApprovalFor);
      }
    });
  });
  const firstId = recorder.getOperations()[0].operationId;

  const waiting = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true, selectedOperationId: pendingId });
  assert.equal(waiting.header.statusKind, 'waiting');
  assert.equal(waiting.header.simulated, true);
  assert.equal(waiting.controls.canStart, false);
  assert.equal(waiting.controls.canStop, true);
  assert.equal(waiting.selected?.canApprove, true);
  assert.equal(waiting.selected?.canReviewChange, true);
  assert.equal(waiting.operations.filter((o) => o.awaitingApproval).length, 1);

  const other = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: false, selectedOperationId: firstId });
  assert.equal(other.selected?.canApprove, false);
  assert.equal(other.selected?.canReveal, true);
  assert.equal(other.controls.follow, false);

  controller.pause();
  assert.equal(buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true }).header.statusLabel, 'Paused · awaiting your approval');
  controller.stop();
  await controller.whenIdle();
  const stopped = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true, selectedOperationId: pendingId });
  assert.equal(stopped.header.statusKind, 'stopped');
  assert.equal(stopped.selected?.canApprove, false);
  assert.equal(stopped.selected?.status, 'Cancelled');
  assert.equal(stopped.controls.canStart, true);
});

test('observe vs intercept is labelled explicitly', async () => {
  const { explainControl } = await import('../ui/viewModel');
  const recorder = new EventRecorder();
  const t = recorder.startTask({ description: 'x', source: 'codex', adapterName: 'Codex', simulated: false });
  const base = { source: 'codex', simulated: false, requiresApproval: false } as const;
  const observed = recorder.recordOperation(t.taskId, { ...base, operationType: 'Read', description: 'r', enforcement: 'none' });
  const intercepted = recorder.recordOperation(t.taskId, { ...base, operationType: 'Edit', description: 'e', enforcement: 'agent-approval', requiresApproval: true });
  const legacy = recorder.recordOperation(t.taskId, { ...base, operationType: 'Edit', description: 'm', requiresApproval: true });
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' });
  const vm = buildActivityViewModel(recorder, controller.getSnapshot(), { follow: true, selectedTaskId: t.taskId });
  assert.deepEqual(vm.operations.map((o) => o.control), ['OBSERVED', 'INTERCEPTED', 'GATED']);
  assert.match(explainControl(observed), /could not block it/);
  assert.match(explainControl(intercepted), /ENTIRE patch, not individual functions/);
  assert.equal(legacy.enforcement, 'controller', 'v0.1 history defaults to controller-dispatched');
});
