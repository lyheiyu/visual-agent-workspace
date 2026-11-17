#!/usr/bin/env node
// REAL local coding agent test (opt-in; uses local GPU/RAM, no cloud).
// OpenCode runtime + Ollama model, in disposable git repos.
//
//   npm run test:local-agent                              # qwen3:8b, all scenarios
//   VAW_LOCAL_MODELS="gpt-oss:20b,qwen3.8:27b" VAW_SCENARIOS=analysis npm run test:local-agent
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { OpenCodeAdapter } = require('../out/agents/opencode/OpenCodeAdapter');
const { startOpenCodeServer, locateOpenCode } = require('../out/agents/opencode/OpenCodeServer');
const { discoverOllamaCodingModels } = require('../out/agents/providers');
const { createDisposableJsRepo } = require('./lib/disposable-js-repo');

const root = path.resolve(__dirname, '..');
const models = (process.env.VAW_LOCAL_MODELS || 'qwen3:8b').split(',').map((s) => s.trim());
const scenarios = (process.env.VAW_SCENARIOS || 'analysis,edit,cancel').split(',');
const home = path.join(os.tmpdir(), 'vaw-opencode-home'); // reused: keeps OpenCode's provider package cache
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function waitFor(c, pred, ms = 600000) {
  return new Promise((resolve, reject) => {
    if (pred(c.getSnapshot())) return resolve(c.getSnapshot());
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    const sub = c.onDidChangeState((s) => {
      if (pred(s)) {
        clearTimeout(t);
        sub.dispose();
        resolve(s);
      }
    });
  });
}

function setup(repo, model, profile) {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  const adapter = new OpenCodeAdapter({
    connector: startOpenCodeServer,
    launch: { executable: locateOpenCode(undefined, root), homeDir: home, ollamaBaseUrl: 'http://127.0.0.1:11434', model, contextLimit: 32768, outputLimit: 8192, profile },
  });
  return { recorder, controller, adapter };
}

function summarize(recorder, taskId) {
  for (const o of recorder.getOperations(taskId)) {
    console.log(`     #${o.sequenceNumber} [${o.status}] ${o.operationType} ${o.enforcement} ${o.description.slice(0, 110)}${o.command?.exitCode !== undefined ? ` (exit ${o.command.exitCode})` : ''}`);
  }
}

async function analysis(model) {
  const repo = createDisposableJsRepo();
  const { recorder, controller, adapter } = setup(repo, model, 'read-only');
  const t0 = Date.now();
  const taskId = controller.start('Analyze this small project: read math.js and list its functions and one potential bug. Do not modify anything.', adapter, repo.dir);
  await waitFor(controller, (s) => s.awaitingInput || s.taskStatus !== 'Running');
  const t1 = Date.now();
  const firstOps = recorder.getOperations(taskId);
  check(`[${model}] read-only analysis read math.js`, firstOps.some((o) => o.operationType === 'Read' && o.filePath === 'math.js'), `${((t1 - t0) / 1000).toFixed(1)} s`);
  check(`[${model}] analysis produced an answer`, firstOps.some((o) => /^Local agent: /.test(o.description)));
  if (controller.getSnapshot().taskStatus === 'Running') {
    await controller.steer('Which function would fail on a zero argument? Answer in one sentence.');
    await waitFor(controller, (s) => s.awaitingInput || s.taskStatus !== 'Running');
    const answers = recorder.getOperations(taskId).filter((o) => /^Local agent: /.test(o.description));
    check(`[${model}] follow-up answered in the same session`, answers.length >= 2, `${((Date.now() - t1) / 1000).toFixed(1)} s`);
    await controller.endSession();
  }
  await controller.whenIdle();
  summarize(recorder, taskId);
  check(`[${model}] read-only: workspace unchanged`, repo.status() === '');
  check(`[${model}] task completed`, recorder.getTask(taskId).status === 'Completed', recorder.getTask(taskId).status);
  await repo.dispose();
}

async function edit(model) {
  const repo = createDisposableJsRepo();
  const { recorder, controller, adapter } = setup(repo, model, 'approved-write');
  const before = fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8');
  const taskId = controller.start(
    'In math.js, make divide(a, b) throw new Error("division by zero") when b === 0. Use the edit tool with real newlines. Then run `node test.js` once with the bash tool and report the result.',
    adapter,
    repo.dir,
  );
  let interceptedUnchanged = true;
  let editSeen = false;
  let testOp;
  const deadline = Date.now() + 900000;
  for (;;) {
    const s = await waitFor(controller, (x) => !!x.awaitingApprovalFor || x.awaitingInput || x.taskStatus !== 'Running', deadline - Date.now());
    if (!s.awaitingApprovalFor) break;
    const op = recorder.getOperation(s.awaitingApprovalFor);
    if (op.operationType === 'Edit') {
      editSeen = true;
      if (fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8') !== before) interceptedUnchanged = false;
      console.log(`     approval requested: ${op.description}; diff available: ${!!op.associatedChangeId}`);
      controller.approve(op.operationId);
    } else if (op.command && /node\s+test\.js/.test(op.command.command)) {
      testOp = op.operationId;
      controller.approve(op.operationId);
    } else {
      controller.reject(op.operationId, 'only the requested edit and test are allowed');
    }
    if (testOp && recorder.getOperation(testOp).status !== 'Proposed') {
      // let the agent finish its turn
    }
  }
  const editOps = recorder.getOperations(taskId).filter((o) => o.operationType === 'Edit');
  check(`[${model}] agent proposed an edit that waited for approval`, editSeen && editOps.some((o) => o.enforcement === 'agent-approval'));
  check(`[${model}] file unchanged while approval was pending (real interception)`, editSeen && interceptedUnchanged);
  if (testOp) {
    const t = recorder.getOperation(testOp);
    const actual = spawnSync(process.execPath, ['test.js'], { cwd: repo.dir, encoding: 'utf8' });
    check(`[${model}] approved test ran; recorded exit code matches a re-run`, t.command.exitCode === actual.status, `recorded ${t.command.exitCode}, re-run ${actual.status}`);
    console.log(`     test output: ${(t.command.stdout || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200)}`);
  } else {
    check(`[${model}] agent ran the approved test`, false, 'no node test.js approval request seen');
  }
  if (controller.getSnapshot().taskStatus === 'Running') await controller.endSession();
  await controller.whenIdle();
  summarize(recorder, taskId);
  const changed = repo.status();
  check(`[${model}] only math.js changed`, changed === '' || /^\s*M math\.js$/.test(changed), changed || '(clean)');
  const applied = editOps.filter((o) => o.status === 'Completed');
  if (applied.length) {
    const after = fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8');
    console.log('     final diff:\n' + repo.diff().split('\n').map((l) => '       ' + l).join('\n'));
    check(`[${model}] .env untouched`, fs.readFileSync(path.join(repo.dir, '.env'), 'utf8') === 'SECRET_TOKEN=do-not-touch\n');
    void after;
  }
  await repo.dispose();
}

async function cancel(model) {
  const repo = createDisposableJsRepo();
  const { recorder, controller, adapter } = setup(repo, model, 'read-only');
  const taskId = controller.start('Read every file in this repository one by one and write a very detailed review of each.', adapter, repo.dir);
  await waitFor(controller, () => recorder.getOperations(taskId).length >= 2);
  const t0 = Date.now();
  controller.stop();
  await controller.whenIdle();
  check(`[${model}] Stop ends the session`, recorder.getTask(taskId).status === 'Stopped', `${Date.now() - t0} ms`);
  check(`[${model}] no operation left running`, recorder.getOperations(taskId).every((o) => !['Running', 'Proposed'].includes(o.status)));
  await repo.dispose();
}

(async () => {
  const available = await discoverOllamaCodingModels('http://127.0.0.1:11434');
  console.log(`OpenCode: ${locateOpenCode(undefined, root)}`);
  for (const model of models) {
    const m = available.find((x) => x.id === model);
    if (!m) {
      console.log(`\n== ${model}: not installed (skipped; never downloaded)`);
      continue;
    }
    if (!m.compatible) {
      console.log(`\n== ${model}: incompatible (${m.reason})`);
      continue;
    }
    console.log(`\n== ${model}`);
    for (const s of scenarios) {
      try {
        if (s === 'analysis') await analysis(model);
        if (s === 'edit') await edit(model);
        if (s === 'cancel') await cancel(model);
      } catch (err) {
        check(`[${model}] ${s}`, false, err.message);
      }
    }
  }
  const ps = await (await fetch('http://127.0.0.1:11434/api/ps')).json();
  console.log(`\nOllama loaded: ${ps.models.map((m) => `${m.name} ${(m.size / 1e9).toFixed(1)} GB ctx ${m.context_length}`).join(', ')}`);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
