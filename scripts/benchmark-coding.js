// Real local/Codex benchmark. Writes only to disposable repositories and the specified report.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDisposableJsRepo } = require('./lib/disposable-js-repo');
const { AgentController } = require('../out/controller/AgentController');
const { EventRecorder } = require('../out/recorder/EventRecorder');
const { MockAgentAdapter } = require('../out/adapters/MockAgentAdapter');
const { OpenCodeAdapter } = require('../out/agents/opencode/OpenCodeAdapter');
const { startOpenCodeServer, locateOpenCode } = require('../out/agents/opencode/OpenCodeServer');
const { CodexAppServerAdapter, stdioConnector } = require('../out/adapters/codex/CodexAppServerAdapter');
const { locateCodex } = require('../out/adapters/codex/codexLocator');
const { getProfile } = require('../out/adapters/codex/profiles');
const { discoverOllamaCodingModels } = require('../out/agents/providers');
const { describeCommand } = require('../out/analysis/commandInfo');
const root = path.resolve(__dirname, '..');
const cases = [
  { name: 'single', prompt: 'Fix divide(1,0) to throw Error("division by zero"). Preserve all existing exports and behavior. Run node test.js.', files: ['math.js'] },
  { name: 'multi', prompt: 'First run node test.js to reproduce the failure, fix divide(1,0) to throw Error("division by zero"), and document the behavior in README.md. Run node test.js again.', files: ['math.js', 'README.md'] },
  { name: 'dependency', prompt: 'Extract divide into a new divide.js module, preserve the public add and divide exports of math.js, fix divide(1,0) to throw Error("division by zero"), and run node test.js. Keep CommonJS.', files: ['math.js', 'divide.js'] },
];
const selectedCases = process.env.VAW_BENCH_CASES ? cases.filter((scenario) => process.env.VAW_BENCH_CASES.split(',').includes(scenario.name)) : cases;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(provider, scenario, attempt) {
  const repo = createDisposableJsRepo('vaw-bench-');
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => repo.dir });
  const localModel = provider === 'codex' ? undefined : (await discoverOllamaCodingModels('http://127.0.0.1:11434')).find((model) => model.id === provider);
  const contextLimit = Math.min(32768, localModel?.contextLength ?? 32768);
  let tokens = 0;
  let cachedInputTokens = 0;
  let usageReports = 0;
  controller.onDidSessionEvent((event) => {
    if (event.kind === 'usage') { tokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0); cachedInputTokens += event.usage.cachedInputTokens ?? 0; usageReports++; }
  });
  const adapter = provider === 'codex'
    ? new CodexAppServerAdapter({ connector: stdioConnector(locateCodex()), profile: getProfile('approve-edits'), maxTurnMs: 180000 })
    : new OpenCodeAdapter({ connector: startOpenCodeServer, launch: { executable: locateOpenCode(undefined, root), homeDir: path.join(os.tmpdir(), 'vaw-opencode-home'), ollamaBaseUrl: 'http://127.0.0.1:11434', model: provider, contextLimit, outputLimit: Math.min(8192, Math.floor(contextLimit / 4)), profile: 'approved-write' } });
  const started = Date.now();
  const id = controller.start(scenario.prompt + ' Do not modify tests. Use file edit tools. Preserve existing module conventions.', adapter, repo.dir);
  let followup = false;
  const decided = new Set();
  try {
    while (controller.isActive && Date.now() - started < 180000) {
      const state = controller.getSnapshot();
      for (const pending of state.pendingApprovals) {
        if (decided.has(pending)) continue;
        decided.add(pending);
        const op = recorder.getOperation(pending);
        const paths = [...new Set([...(op.associatedChangeIds ?? []), ...(op.associatedChangeId ? [op.associatedChangeId] : [])])].map((id) => recorder.getChange(id)?.filePath);
        const commandInfo = op.command ? describeCommand(op.command.command) : undefined;
        const allowedCommand = commandInfo && !commandInfo.writes && !commandInfo.sourceWrite &&
          (op.operationType === 'Read' || (op.operationType === 'Test' && /\bnode\s+test\.js\b/.test(op.command.command)));
        if (op.operationType === 'Edit' && paths.length && paths.every((file) => scenario.files.includes(file))) controller.approve(pending);
        else if (allowedCommand) controller.approve(pending);
        else controller.reject(pending, 'Only requested source changes and read/test commands are authorised.');
      }
      if (state.awaitingInput && !followup) {
        followup = true;
        await controller.steer('Explain which public exports you preserved and the actual test result. Do not change files.');
      } else if (state.awaitingInput) break;
      await pause(80);
    }
  } finally {
    if (controller.isActive) controller.stop();
    await controller.whenIdle();
  }
  const operations = recorder.getOperations(id);
  const tests = operations.filter((op) => op.command && /node\s+test\.js/.test(op.command.command));
  const changed = repo.status();
  const actual = spawnSync(process.execPath, ['test.js'], { cwd: repo.dir, encoding: 'utf8', timeout: 10000 });
  const dependencyCheck = scenario.name !== 'dependency' || spawnSync(process.execPath, ['-e',
    'const assert=require("node:assert/strict");const m=require("./math");const d=require("./divide");assert.equal(m.divide,typeof d==="function"?d:d.divide);',
  ], { cwd: repo.dir, encoding: 'utf8', timeout: 10000 }).status === 0;
  const documentationCheck = scenario.name !== 'multi' || /zero/i.test(fs.readFileSync(path.join(repo.dir, 'README.md'), 'utf8'));
  const unexpectedEdits = changed.split('\n').filter(Boolean).filter((line) => !scenario.files.includes(line.trim().slice(2).trim()));
  const requiredFiles = scenario.files.every((file) => changed.includes(file));
  const lastReply = operations.filter((op) => op.assistantMessage || /^Local agent:|^Codex:/.test(op.description)).at(-1)?.resultSummary ?? '';
  const result = { provider, scenario: scenario.name, attempt, passed: actual.status === 0 && requiredFiles && dependencyCheck && documentationCheck && !unexpectedEdits.length, testExit: actual.status, requiredFiles, dependencyCheck, documentationCheck, unexpectedEdits, toolCalls: operations.filter((op) => op.command || ['Read', 'Edit'].includes(op.operationType)).length, tokens: usageReports ? tokens : null, elapsedMs: Date.now() - started, recordedTests: tests.map((op) => op.command.exitCode), followup, lastReply, changed, testError: actual.stderr,
    failures: operations.filter((op) => ['Failed', 'Rejected'].includes(op.status)).map((op) => ({ description: op.description, result: op.resultSummary, notes: op.history.map((entry) => entry.note).filter(Boolean) })),
    model: operations.find((op) => /session started/.test(op.description))?.description,
    cachedInputTokens: usageReports ? cachedInputTokens : null,
    taskStatus: recorder.getTask(id).status,
    passingTestClaimMismatch: /all tests pass|tests? (?:ran|completed) successfully/i.test(lastReply) && (actual.status !== 0 || !tests.some((op) => op.command.exitCode === 0)),
    sources: Object.fromEntries(scenario.files.map((file) => [file, fs.existsSync(path.join(repo.dir, file)) ? fs.readFileSync(path.join(repo.dir, file), 'utf8') : null])),
  };
  await repo.dispose();
  return result;
}
(async () => {
  const results = [];
  const report = process.env.VAW_BENCH_REPORT || path.join(root, '.vscode-test', 'coding-benchmark.json');
  for (const provider of (process.env.VAW_BENCH_PROVIDERS || 'qwen3:8b,codex').split(',')) {
    for (const scenario of selectedCases) for (let attempt = 1; attempt <= Number(process.env.VAW_BENCH_REPEATS || 2); attempt++) {
      try { results.push(await run(provider, scenario, attempt)); }
      catch (error) { results.push({ provider, scenario: scenario.name, attempt, passed: false, error: String(error) }); }
      fs.writeFileSync(report, JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results.at(-1)));
    }
  }
})();
