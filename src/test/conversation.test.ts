import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventRecorder, PersistedHistory, mergeHistory } from '../recorder/EventRecorder';
import { conversation, conversationDocument, continuationContext } from '../recorder/conversation';

test('conversation survives recorder reload, redacts secrets, retains project/model, and clears with history', () => {
  let saved: PersistedHistory | undefined;
  const storage = { load: () => saved, save: (value: PersistedHistory) => { saved = JSON.parse(JSON.stringify(value)); } };
  const r = new EventRecorder(storage);
  const t = r.startTask({ description: 'Explain divide', source: 'local', adapterName: 'Local agent', simulated: false });
  r.recordMessage(t.taskId, 'user', 'Please inspect; token=super-secret-value');
  r.recordMessage(t.taskId, 'assistant', 'The function divides two numbers.');
  r.setLaunch(t.taskId, { provider: 'local', model: 'qwen3:8b', profile: 'read-only', workspaceRoot: 'C:\\projects\\example' });
  r.dispose();
  const reloaded = new EventRecorder(storage);
  const task = reloaded.getTask(t.taskId)!;
  assert.equal(task.messages?.length, 2);
  assert.equal(task.status, 'Stopped', 'reload never silently restarts a task');
  assert.equal(task.launch?.model, 'qwen3:8b');
  const doc = conversationDocument(task, []);
  assert.match(doc, /The function divides/);
  assert.match(doc, /REDACTED/);
  assert.ok(!doc.includes('super-secret-value'));
  const seed = continuationContext(task, []);
  assert.match(seed, /new session/);
  assert.match(seed, /prior approvals do not authorize/);
  assert.match(seed, /The function divides/);
  reloaded.clear();
  assert.equal(reloaded.getTasks().length, 0);
  assert.equal(saved?.tasks.length, 0);
});

test('old operation histories recover assistant replies and follow-ups, excluding tools and reasoning', () => {
  const r = new EventRecorder();
  const task = r.startTask({ description: 'Inspect math', source: 'codex', adapterName: 'Codex', simulated: false });
  const reply = r.recordOperation(task.taskId, { source: 'codex', simulated: false, operationType: 'Analyze', description: 'Codex: It divides.', requiresApproval: false });
  r.updateOperation(reply.operationId, { status: 'Running' });
  r.updateOperation(reply.operationId, { status: 'Completed', resultSummary: 'It divides.' });
  r.recordOperation(task.taskId, { source: 'codex', simulated: false, operationType: 'Analyze', description: 'Reasoning: internal', requiresApproval: false });
  const messages = conversation(task, r.getOperations(task.taskId));
  assert.deepEqual(messages.map((m) => m.text), ['Inspect math', 'It divides.']);
  const context = continuationContext(task, r.getOperations(task.taskId));
  assert.match(context, /recent_operations/);
});

test('conversation storage and continuation are bounded with visible truncation', () => {
  const r = new EventRecorder(undefined, { maxFieldChars: 500 });
  const task = r.startTask({ description: 'x', source: 'local', adapterName: 'Local', simulated: false });
  for (let i = 0; i < 205; i++) r.recordMessage(task.taskId, 'user', `${i}:` + 'a'.repeat(1000));
  const saved = r.getTask(task.taskId)!;
  assert.equal(saved.messages?.length, 200);
  assert.match(saved.messages![0].text, /truncated/);
  const context = continuationContext(saved, []);
  assert.ok(context.length < 32000);
  assert.match(context, /Earlier transcript truncated/);
});

test('workspace transition carries retained messages, native session and results without losing destination history', () => {
  const source = new EventRecorder();
  const task = source.startTask({ description: 'Source conversation', source: 'local', adapterName: 'Local', simulated: false, workspaceRoot: '/source' });
  source.recordMessage(task.taskId, 'user', 'Remember this');
  source.setSession(task.taskId, { provider: 'local', id: 'ses_original' });
  source.startTurn(task.taskId); source.finishTurn(task.taskId, 'Completed'); source.finishTask(task.taskId, 'Completed');
  const destination = new EventRecorder();
  destination.startTask({ description: 'Destination conversation', source: 'local', adapterName: 'Local', simulated: false });
  const snapshot = source.exportHistory();
  snapshot.tasks[0].description = 'Updated source title';
  assert.equal(source.getTask(task.taskId)!.description, 'Source conversation', 'export is an immutable snapshot');
  const merged = mergeHistory(destination.exportHistory(), snapshot);
  const restored = new EventRecorder({ load: () => merged, save: () => {} });
  assert.equal(restored.getTasks().length, 2);
  assert.equal(restored.getTask(task.taskId)!.session?.id, 'ses_original');
  assert.equal(restored.getTask(task.taskId)!.messages![0].text, 'Remember this');
  assert.equal(restored.getTask(task.taskId)!.turns![0].status, 'Completed');
  assert.equal(mergeHistory(merged, snapshot).tasks.length, 2, 'retrying a transfer does not duplicate conversations');
});
