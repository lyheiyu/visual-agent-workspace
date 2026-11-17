// Opt-in real check using the user's official Claude subscription, never API-key fallback.
const assert = require('node:assert/strict');
const path = require('node:path');
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { ClaudeCodeAdapter } = require('../out/agents/claude/ClaudeCodeAdapter');
const { resolveClaudeRuntime } = require('../out/agents/claude/claudeRuntime');
const { loadClaudeQuery } = require('../out/agents/claude/claudeSdk');
const { discoverClaudeModels } = require('../out/agents/providers');
const { createDisposableJsRepo } = require('./lib/disposable-js-repo');

async function ready(controller, recorder, id) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = controller.getSnapshot();
    if (state.awaitingInput) return;
    if (!controller.isActive) throw new Error(recorder.getTask(id).summary || 'Claude task ended unexpectedly.');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for Claude subscription turn.');
}
(async () => {
  const runtime = await resolveClaudeRuntime(process.env, undefined, 'subscription');
  assert.equal(runtime.authentication.kind, 'subscription', runtime.authentication.reason);
  const query = await loadClaudeQuery(path.resolve(__dirname, '..'));
  const repo = createDisposableJsRepo('vaw-claude-subscription-');
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  try {
    const models = await discoverClaudeModels(query, repo.dir, runtime.env, runtime.executable);
    const model = models.find((m) => m.id === 'haiku') || models[0];
    assert.ok(model, 'official runtime listed models');
    console.log(`Subscription confirmed by official login; selected ${model.id}.`);
    const id = controller.start('Read math.js and explain divide() in one sentence. Remember our marker AMBER392. Do not edit any files or run commands.', new ClaudeCodeAdapter({ loadQuery: async () => query, model: model.id, effort: model.efforts?.includes('low') ? 'low' : undefined, profile: 'read-only', env: runtime.env, authentication: runtime.authentication, pathToClaudeCodeExecutable: runtime.executable }), repo.dir);
    await ready(controller, recorder, id);
    const operations = recorder.getOperations(id);
    assert.ok(operations.some((op) => /authentication confirmed: Claude subscription/.test(op.description)));
    assert.ok(operations.some((op) => op.operationType === 'Read' && op.filePath === 'math.js'));
    assert.equal(repo.status(), '');
    console.log('PASS: subscription auth checked before prompt; real read and explanation; no files changed.');
    await controller.steer('What was our marker? Reply with just the marker. Do not use tools.');
    await ready(controller, recorder, id);
    assert.match(recorder.getTask(id).messages.at(-1).text, /AMBER392/);
    assert.equal(recorder.getTask(id).turns.length, 2);
    await controller.endSession(); await controller.whenIdle();
    assert.equal(recorder.getTask(id).status, 'Completed');
    assert.equal(repo.status(), '');
    console.log('PASS: same-session follow-up remembers marker; two turn results; normal session close.');
  } finally {
    if (controller.isActive) controller.stop();
    await controller.whenIdle();
    recorder.dispose(); await repo.dispose();
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
