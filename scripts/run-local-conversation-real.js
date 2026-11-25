// Real single-model acceptance: explain -> edit/approval -> test -> follow-up -> restart/resume.
// Uses Ollama GPU inference in a disposable repository. Never unloads other models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { OpenCodeAdapter } = require('../out/agents/opencode/OpenCodeAdapter');
const { locateOpenCode, startOpenCodeServer } = require('../out/agents/opencode/OpenCodeServer');
const { createDisposableJsRepo } = require('./lib/disposable-js-repo');

const model = process.env.VAW_CONVERSATION_MODEL || 'qwen3:8b';
const endpoint = 'http://127.0.0.1:11434';
const root = path.resolve(__dirname, '..');
let saved;
const storage = { load: () => saved, save: (h) => { saved = structuredClone(h); } };
function setup(repo, resumeSessionId) {
  const recorder = new EventRecorder(storage);
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  const adapter = new OpenCodeAdapter({ resumeSessionId, connector: startOpenCodeServer, launch: {
    executable: locateOpenCode(undefined, root), homeDir: path.join(os.tmpdir(), 'vaw-opencode-home'), ollamaBaseUrl: endpoint,
    model, contextLimit: 32768, outputLimit: 4096, profile: 'approved-write',
  } });
  return { recorder, controller, adapter };
}
async function turn(c, recorder, taskId, repo, allowEdit = false) {
  const deadline = Date.now() + 600000;
  const approved = new Set();
  while (Date.now() < deadline) {
    const state = c.getSnapshot();
    for (const id of state.pendingApprovals) {
      if (approved.has(id)) continue;
      approved.add(id);
      const op = recorder.getOperation(id);
      if (allowEdit && op.operationType === 'Edit' && op.filePath === 'math.js') {
        assert.equal(fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8'), repo.before, 'file unchanged before approval');
        assert.ok(op.associatedChangeId, `edit has a reviewable diff: ${JSON.stringify({ d: op.description, r: op.rationale, s: op.resultSummary })}`);
        c.approve(id);
      } else if (allowEdit && op.command && /^node\s+test\.js\s*$/.test(op.command.command.trim())) c.approve(id);
      else c.reject(id, 'Only the requested math.js edit and node test.js are allowed.');
    }
    if (state.awaitingInput) {
      const round = recorder.getTask(taskId).turns.at(-1);
      console.log(round.report);
      assert.equal(round.status, 'Completed');
      return;
    }
    if (state.taskStatus !== 'Running') throw new Error(recorder.getTask(taskId).summary || 'Task ended unexpectedly.');
    await new Promise((r) => setTimeout(r, 100));
  }
  c.stop();
  await c.whenIdle();
  throw new Error('Timed out waiting for a local conversation turn.');
}

(async () => {
  const loaded = await (await fetch(`${endpoint}/api/ps`)).json();
  if (loaded.models?.some((m) => m.name !== model)) throw new Error('Another Ollama model is loaded. This test refuses to load a second model.');
  const repo = createDisposableJsRepo('vaw-conversation-');
  repo.before = fs.readFileSync(path.join(repo.dir, 'math.js'), 'utf8');
  let current;
  try {
    current = setup(repo);
    const taskId = current.controller.start('Read math.js and explain divide() and its zero-division bug in one sentence. Remember our session marker COBALT7319. Do not edit or run commands.', current.adapter, repo.dir);
    current.recorder.setLaunch(taskId, { provider: 'local', model, profile: 'approved-write', workspaceRoot: repo.dir });
    console.log('1. Explain with one model:', model);
    await turn(current.controller, current.recorder, taskId, repo);
    assert.equal(repo.status(), '', 'explanation is read-only');
    console.log('2. Edit, approve, and run tests');
    await current.controller.steer('Now edit math.js using the edit tool: make divide(a,b) throw new Error("division by zero") when b === 0. Use actual newline characters, not literal backslash-n. Then run node test.js once with bash and report the result. Do not change any other file.');
    await turn(current.controller, current.recorder, taskId, repo, true);
    const test = current.recorder.getOperations(taskId).findLast((op) => op.command?.command.trim() === 'node test.js');
    assert.equal(test?.command?.exitCode, 0, 'real test succeeded');
    assert.match(execFileSync(process.execPath, ['test.js'], { cwd: repo.dir, encoding: 'utf8', windowsHide: true }), /all tests passed/);
    console.log('3. Follow-up in same session');
    await current.controller.steer('In one sentence, explain the guard you just added. Do not edit or run commands.');
    await turn(current.controller, current.recorder, taskId, repo);
    const sessionId = current.recorder.getTask(taskId).session.id;
    await current.controller.endSession();
    await current.controller.whenIdle();
    current.recorder.dispose();
    console.log('4. New controller + new OpenCode process, restore original session');
    current = setup(repo, sessionId);
    current.controller.start('What was our session marker? Reply with the marker only. Do not use tools.', current.adapter, repo.dir, { taskId, userMessage: 'What was our session marker?' });
    await turn(current.controller, current.recorder, taskId, repo);
    assert.match(current.recorder.getTask(taskId).messages.at(-1).text, /COBALT7319/);
    assert.equal(current.recorder.getTask(taskId).session.id, sessionId);
    assert.equal(current.recorder.getTasks().length, 1, 'all turns remain in the same conversation');
    assert.equal(current.recorder.getTask(taskId).turns.length, 4);
    assert.equal(current.recorder.getTask(taskId).session.continuity, 'resumed');
    await current.controller.endSession();
    await current.controller.whenIdle();
    console.log('5. A session that no longer exists: the failure is reported, nothing is silently replaced or replayed');
    current.recorder.dispose();
    current = setup(repo, 'ses_doesnotexist000000000000');
    current.controller.start('What was our session marker?', current.adapter, repo.dir, { taskId, userMessage: 'What was our session marker?' });
    await current.controller.whenIdle();
    const lostTask = current.recorder.getTask(taskId);
    assert.equal(lostTask.session.id, sessionId, 'the recorded session is not overwritten');
    assert.equal(lostTask.turns.at(-1).status, 'Failed', `turn result: ${lostTask.turns.at(-1).status}`);
    console.log(`   reported: ${(lostTask.summary || lostTask.turns.at(-1).report || '').slice(0, 160)}`);
    const files = repo.status().split('\n').filter(Boolean);
    assert.deepEqual(files, ['M math.js']);
    const finalLoaded = await (await fetch(`${endpoint}/api/ps`)).json();
    assert.ok(finalLoaded.models.every((m) => m.name === model));
    console.log('PASS: single model; four turns; native resume; approval gates; independent test rerun; only math.js changed.');
  } finally {
    if (current?.controller.isActive) current.controller.stop();
    await current?.controller.whenIdle();
    current?.recorder.dispose();
    await repo.dispose();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
