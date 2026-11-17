#!/usr/bin/env node
// REAL Codex check (opt-in, uses Codex quota: one short read-only turn):
// explicit model + reasoning effort are honoured, and discovery lists them.
//   node scripts/run-codex-model-select.js [model] [effort]
const path = require('node:path');
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { CodexAppServerAdapter, stdioConnector } = require('../out/adapters/codex/CodexAppServerAdapter');
const { CodexRpcClient } = require('../out/adapters/codex/CodexRpcClient');
const { locateCodex } = require('../out/adapters/codex/codexLocator');
const { getProfile } = require('../out/adapters/codex/profiles');
const { discoverCodexModels } = require('../out/agents/providers');
const { createDisposableRepo } = require('./lib/disposable-repo');

(async () => {
  const loc = locateCodex();
  const repo = createDisposableRepo();
  const models = await discoverCodexModels(loc, repo.dir);
  const model = process.argv[2] || models.find((m) => !m.isDefault)?.id || models[0].id;
  const m = models.find((x) => x.id === model);
  const effort = process.argv[3] || (m.efforts.includes('low') ? 'low' : m.efforts[0]);
  console.log(`discovered: ${models.map((x) => x.id).join(', ')}\nselected: ${model} effort=${effort}`);
  const sent = [];
  const connector = (cwd) => {
    const c = stdioConnector(loc)(cwd);
    c.onTraffic(({ direction, message }) => direction === 'out' && message.method && sent.push(message));
    return c;
  };
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  const taskId = controller.start('Reply with exactly the word READY. Do not run any commands.', new CodexAppServerAdapter({ connector, profile: getProfile('observe'), model, effort }), repo.dir);
  await controller.whenIdle();
  const ops = recorder.getOperations(taskId);
  ops.forEach((o) => console.log(`  #${o.sequenceNumber} [${o.status}] ${o.description.slice(0, 120)}`));
  const ts = sent.find((x) => x.method === 'thread/start');
  const tu = sent.find((x) => x.method === 'turn/start');
  const checks = [
    ['thread/start carried the selected model', ts?.params.model === model],
    ['turn/start carried the selected effort', tu?.params.effort === effort],
    ['timeline shows the actual model and effort', new RegExp(`started: ${model.replace(/[.]/g, '\\.')} \\(effort ${effort}\\)`).test(ops[0].description)],
    ['task completed', recorder.getTask(taskId).status === 'Completed'],
    ['workspace unchanged', repo.status() === ''],
  ];
  checks.forEach(([n, ok]) => console.log(`${ok ? '✔' : '✖'} ${n}`));
  await repo.dispose();
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
