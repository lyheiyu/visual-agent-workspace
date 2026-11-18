#!/usr/bin/env node
// REAL Codex check (opt-in; uses Codex quota: one short turn in a disposable repo):
// a declined file change carries the user's reason to Codex (turn/steer), and Codex reacts to it.
//   node scripts/run-codex-decline-real.js
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { CodexAppServerAdapter, stdioConnector } = require('../out/adapters/codex/CodexAppServerAdapter');
const { locateCodex } = require('../out/adapters/codex/codexLocator');
const { getProfile } = require('../out/adapters/codex/profiles');
const { createDisposableRepo } = require('./lib/disposable-repo');

const waitFor = (c, pred, ms = 300000) =>
  new Promise((resolve, reject) => {
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

(async () => {
  const loc = locateCodex();
  if (!loc) throw new Error('Codex CLI not found');
  const repo = createDisposableRepo();
  const sent = [];
  const connector = (cwd) => {
    const c = stdioConnector(loc)(cwd);
    c.onTraffic(({ direction, message }) => direction === 'out' && message.method && sent.push(message));
    return c;
  };
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  const taskId = controller.start(process.env.VAW_CODEX_PROMPT || 'Create a new file named hello.txt containing exactly the text: hi. Use apply_patch; each patch is shown to the user, who approves or declines it, so do request the patch even though the sandbox is read-only. Do not run commands and do not change any other file.', new CodexAppServerAdapter({ connector, profile: getProfile('approve-edits') }), repo.dir);
  const checks = [];
  const check = (n, ok, d = '') => {
    checks.push(ok);
    console.log(`${ok ? '✔' : '✖'} ${n}${d ? ` — ${d}` : ''}`);
  };
  let s = await waitFor(controller, (x) => !!x.awaitingApprovalFor || x.taskStatus !== 'Running');
  const first = s.awaitingApprovalFor && recorder.getOperation(s.awaitingApprovalFor);
  for (const o of recorder.getOperations(taskId)) {
    console.log(`  #${o.sequenceNumber} [${o.status}] ${o.operationType} ${o.description.slice(0, 140)} :: ${String(o.resultSummary || '').slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  check('Codex proposed a file change for approval', !!first && first.operationType === 'Edit', first ? first.description : s.taskStatus);
  let second;
  if (first) {
    controller.reject(first.operationId, 'Name the file greeting.txt instead (same content). Do not create hello.txt.');
    s = await waitFor(controller, (x) => (!!x.awaitingApprovalFor && x.awaitingApprovalFor !== first.operationId) || x.taskStatus !== 'Running');
    const steer = sent.find((m) => m.method === 'turn/steer');
    check('reason sent to Codex via turn/steer', !!steer && /greeting\.txt/.test(steer.params.input[0].text));
    const delivery = recorder.getOperations(taskId).find((o) => o.operationType === 'Instruct' && /decline reason/.test(o.description));
    check('delivery recorded', !!delivery, delivery ? `${delivery.status}: ${delivery.resultSummary}` : 'none');
    second = s.awaitingApprovalFor && recorder.getOperation(s.awaitingApprovalFor);
    console.log(`• Codex next: ${second ? second.description : `turn ended (${s.taskStatus})`}`);
    const texts = recorder.getOperations(taskId).filter((o) => /^Codex: /.test(o.description)).map((o) => o.resultSummary || o.description);
    console.log(`• Codex messages: ${texts.join(' | ').slice(0, 400) || '(none)'}`);
    check('Codex reacted to the reason (next proposal targets greeting.txt, or its reply mentions it)', !!(second && /greeting\.txt/.test(second.description + (second.filePath ?? ''))) || texts.some((t) => /greeting\.txt/.test(t)));
    if (second) controller.reject(second.operationId); // keep the disposable repo unchanged; no reason → no steer
  }
  await controller.whenIdle();
  check('nothing written to the repo', repo.status() === '', repo.status());
  await repo.dispose();
  console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
