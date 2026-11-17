import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventRecorder, MemoryHistoryStorage } from '../recorder/EventRecorder';
import { redactSecrets } from '../recorder/redaction';

const base = { source: 'mock', simulated: true, requiresApproval: false } as const;

test('assigns per-task sequence numbers, unique IDs, and audit trail', () => {
  const r = new EventRecorder();
  const t1 = r.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  const t2 = r.startTask({ description: 'b', source: 'mock', adapterName: 'Mock', simulated: true });
  const a1 = r.recordOperation(t1.taskId, { ...base, operationType: 'Read', description: 'x' });
  const b1 = r.recordOperation(t2.taskId, { ...base, operationType: 'Read', description: 'y' });
  const a2 = r.recordOperation(t1.taskId, { ...base, operationType: 'Analyze', description: 'z' });
  assert.deepEqual([a1.sequenceNumber, a2.sequenceNumber, b1.sequenceNumber], [1, 2, 1]);
  assert.notEqual(a1.operationId, a2.operationId);
  r.updateOperation(a1.operationId, { status: 'Running' });
  const done = r.updateOperation(a1.operationId, { status: 'Completed' }, { actor: 'agent' });
  assert.deepEqual(done.history.map((h) => h.status), ['Proposed', 'Running', 'Completed']);
  assert.deepEqual(r.getTasks().map((t) => t.taskId), [t2.taskId, t1.taskId], 'newest first');
});

test('terminal statuses are final', () => {
  const r = new EventRecorder();
  const t = r.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  const op = r.recordOperation(t.taskId, { ...base, operationType: 'Edit', description: 'x' });
  r.updateOperation(op.operationId, { status: 'Rejected' }, { actor: 'user' });
  assert.throws(() => r.updateOperation(op.operationId, { status: 'Running' }));
});

test('returned objects are copies (UI cannot mutate state)', () => {
  const r = new EventRecorder();
  const t = r.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  const op = r.recordOperation(t.taskId, { ...base, operationType: 'Read', description: 'x' });
  op.status = 'Completed';
  assert.equal(r.getOperation(op.operationId)!.status, 'Proposed');
});

test('redacts secrets in descriptions, commands and output', () => {
  const r = new EventRecorder();
  const t = r.startTask({ description: 'deploy', source: 'mock', adapterName: 'Mock', simulated: true });
  const op = r.recordOperation(t.taskId, {
    ...base,
    operationType: 'Execute',
    description: 'call with api_key=abc123secret',
    command: {
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://user:hunter2@example.com',
      workingDirectory: '/ws',
      simulated: true,
      status: 'Pending',
    },
  });
  assert.doesNotMatch(op.description, /abc123secret/);
  assert.doesNotMatch(op.command!.command, /abcdefghijklmnop|hunter2/);
  const updated = r.updateOperation(op.operationId, {
    status: 'Running',
    command: { stdout: 'token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa\nok' },
  });
  assert.doesNotMatch(updated.command!.stdout!, /ghp_/);
  assert.match(updated.command!.stdout!, /ok/);
  assert.equal(redactSecrets('nothing here'), 'nothing here');
});

test('truncates oversized output', () => {
  const r = new EventRecorder(undefined, { maxFieldChars: 100 });
  const t = r.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  const op = r.recordOperation(t.taskId, {
    ...base,
    operationType: 'Execute',
    description: 'x',
    command: { command: 'x', workingDirectory: '.', simulated: true, status: 'Pending' },
  });
  const u = r.updateOperation(op.operationId, { command: { stdout: 'a'.repeat(1000) } });
  assert.ok(u.command!.stdout!.length < 200);
  assert.match(u.command!.stdout!, /truncated 900 characters/);
});

test('persists history and marks interrupted work on reload', () => {
  const storage = new MemoryHistoryStorage();
  const r1 = new EventRecorder(storage);
  const t = r1.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  const op = r1.recordOperation(t.taskId, { ...base, operationType: 'Read', description: 'x' });
  r1.updateOperation(op.operationId, { status: 'Running' });
  r1.recordChange({ changeId: 'c1', taskId: t.taskId, operationId: op.operationId, filePath: 'f.py' });

  const r2 = new EventRecorder(storage);
  assert.equal(r2.getTask(t.taskId)!.status, 'Stopped');
  const reloaded = r2.getOperation(op.operationId)!;
  assert.equal(reloaded.status, 'Cancelled');
  assert.match(reloaded.history.at(-1)!.note!, /Interrupted/);
  assert.equal(r2.getChange('c1')!.decision, 'Cancelled');
  // Sequence numbers continue after reload.
  const next = r2.recordOperation(t.taskId, { ...base, operationType: 'Read', description: 'y' });
  assert.equal(next.sequenceNumber, 2);
});

test('persisted history never contains change source text', () => {
  const storage = new MemoryHistoryStorage();
  const r = new EventRecorder(storage);
  const t = r.startTask({ description: 'a', source: 'mock', adapterName: 'Mock', simulated: true });
  r.recordChange({ changeId: 'c1', taskId: t.taskId, operationId: 'op', filePath: 'f.py', functionName: 'fn' });
  const json = JSON.stringify(storage.data);
  assert.ok(!('replacementText' in storage.data!.changes[0]));
  assert.doesNotMatch(json, /def /);
});

test('prunes oldest finished tasks beyond maxTasks', () => {
  const r = new EventRecorder(undefined, { maxTasks: 2 });
  const ids = [1, 2, 3].map((i) => {
    const t = r.startTask({ description: `t${i}`, source: 'mock', adapterName: 'Mock', simulated: true });
    r.recordOperation(t.taskId, { ...base, operationType: 'Read', description: 'x' });
    r.finishTask(t.taskId, 'Completed');
    return t.taskId;
  });
  assert.deepEqual(r.getTasks().map((t) => t.taskId), [ids[2], ids[1]]);
  assert.equal(r.getOperations(ids[0]).length, 0);
});
