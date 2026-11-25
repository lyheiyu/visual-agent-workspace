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
const scenarios = (process.env.VAW_SCENARIOS || 'analysis,edit,recovery,cancel').split(',');
const home = path.join(os.tmpdir(), 'vaw-opencode-home'); // reused: keeps OpenCode's provider package cache
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function waitFor(c, pred, ms = 600000) {
  return new Promise((resolve, reject) => {
    if (pred(c.getSnapshot())) return resolve(c.getSnapshot());
    const t = setTimeout(() => { sub.dispose(); reject(new Error('timeout')); }, ms);
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
    const session = recorder.getTask(taskId).session?.id;
    const oversized = { name: 'large.txt', mime: 'text/plain', data: Buffer.from('context '.repeat(12000)).toString('base64') };
    let refused = false;
    try { await controller.steer('Consider this attachment.', [oversized]); }
    catch (error) { refused = /context budget/.test(error.message); }
    check(`[${model}] oversized input rejected without ending the session`, refused && controller.getSnapshot().awaitingInput && recorder.getTask(taskId).session?.id === session);
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
  // Live preview of a change still being generated (display only).
  let previews = 0;
  let previewMax = 0;
  const previewSub = controller.onDidChangeState((x) => {
    if (x.preview) {
      previews++;
      previewMax = Math.max(previewMax, x.preview.characters);
    }
  });
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
  previewSub.dispose();
  console.log(`     live preview updates: ${previews} (max ${previewMax} chars)`);
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

async function recovery(model) {
  const repo = createDisposableJsRepo();
  const { recorder, controller, adapter } = setup(repo, model, 'approved-write');
  const taskId = controller.start(
    'First run node test.js to reproduce the failing test. Then fix divide in math.js so zero throws Error("division by zero"). ' +
    'Read math.js before editing it. Then read README.md and use its actual text to document that behavior with the edit tool. ' +
    'Confirm both edit calls succeeded, then run node test.js again and verify it passes.',
    adapter, repo.dir,
  );
  try {
    const deadline = Date.now() + 240000;
    for (;;) {
      const state = await waitFor(controller, (s) => !!s.awaitingApprovalFor || s.awaitingInput || s.taskStatus !== 'Running', deadline - Date.now());
      if (!state.awaitingApprovalFor) break;
      const op = recorder.getOperation(state.awaitingApprovalFor);
      const allowed = op.operationType === 'Edit'
        ? ['math.js', 'README.md'].includes(op.filePath) && !!op.associatedChangeId
        : /^node\s+test\.js$/i.test(op.command?.command.trim() ?? '');
      if (allowed) controller.approve(op.operationId);
      else controller.reject(op.operationId, 'Only math.js, README.md and node test.js are in scope.');
    }
    const ops = recorder.getOperations(taskId);
    const failed = ops.findIndex((o) => o.command?.exitCode > 0);
    const fixed = ops.findIndex((o, i) => i > failed && o.operationType === 'Edit' && o.filePath === 'math.js' && o.status === 'Completed');
    check(`[${model}] failed test → edit → passing test`, failed >= 0 && fixed > failed && ops.slice(fixed + 1).some((o) => o.command?.exitCode === 0));
    check(`[${model}] real edits in both files`, /math\.js/.test(repo.status()) && /README\.md/.test(repo.status()) && spawnSync(process.execPath, ['test.js'], { cwd: repo.dir }).status === 0);
    summarize(recorder, taskId);
  } finally {
    if (controller.isActive) controller.stop();
    await controller.whenIdle();
    await repo.dispose();
  }
}

async function compaction(model) {
  const repo = createDisposableJsRepo();
  fs.writeFileSync(path.join(repo.dir, 'reference.txt'), Array.from({ length: 1800 }, (_, i) => 'Reference line ' + i + ': preserve the original divide requirement and pending documentation.').join('\n'));
  const { recorder, controller } = setup(repo, model, 'read-only');
  const events = [];
  const adapter = new OpenCodeAdapter({
    connector: async (launch) => {
      const connection = await startOpenCodeServer(launch);
      return {
        ...connection,
        subscribe: (listener, signal) => connection.subscribe((event) => {
          if (/compact/i.test(event.type) || event.properties?.info?.summary) events.push(event.type);
          listener(event);
        }, signal),
      };
    },
    launch: { executable: locateOpenCode(undefined, root), homeDir: home, ollamaBaseUrl: 'http://127.0.0.1:11434', model, contextLimit: 8192, outputLimit: 2048, profile: 'read-only' },
  });
  const id = controller.start('Remember requirement marker KEEP-DIVIDE-719 and pending task to document divide. Read reference.txt with the read tool, then explain math.js briefly. Do not edit files.', adapter, repo.dir);
  try {
    await waitFor(controller, (s) => s.awaitingInput || s.taskStatus !== 'Running', 120000);
    check(`[${model}] automatic compaction observed`, events.length > 0, events.join(', '));
    if (controller.getSnapshot().awaitingInput) {
      await controller.steer('What exact requirement marker and pending task did I give you?');
      await waitFor(controller, (s) => s.awaitingInput || s.taskStatus !== 'Running', 90000);
      const answer = recorder.getOperations(id).filter((op) => /^Local agent:/.test(op.description)).at(-1)?.resultSummary ?? '';
      check(`[${model}] requirements survive long-context continuation`, answer.includes('KEEP-DIVIDE-719') && /document/i.test(answer), answer.slice(0, 180));
    }
    summarize(recorder, id);
  } finally {
    if (controller.isActive) controller.stop();
    await controller.whenIdle();
    await repo.dispose();
  }
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
        if (s === 'recovery') await recovery(model);
        if (s === 'compaction') await compaction(model);
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
