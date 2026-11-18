import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describeCommand, formatDuration, splitCommands } from '../analysis/commandInfo';
import { boundedDiffs, checkPreserved, snapshotConflict, userHunks } from '../review/proposalGuard';
import { findImporters } from '../analysis/staticAnalysis';
import { buildExplainPrompt, planChunks, sectionsFor } from '../reviewer/explainCode';
import { explainCommandPrompt } from '../reviewer/prompts';
import { AgentController, ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { OpenCodeAdapter } from '../agents/opencode/OpenCodeAdapter';
import { FakeOpenCode } from './support/fakeOpenCode';
import { buildActivityViewModel } from '../ui/viewModel';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');
const temps: string[] = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------- commands

test('command summaries come from the command text; file writes are labelled', () => {
  const cases: Array<[string, RegExp, boolean]> = [
    ['pytest -q tests/test_validation.py', /^Run tests \(pytest\)$/, false],
    ['python -m pytest -x', /^Run tests \(pytest\)$/, false],
    ['npm test', /^Run tests \(npm\)$/, false],
    ['npm install lodash', /^Install\/change packages \(npm\)$/, true],
    ['pip install -r requirements.txt', /^Install\/change packages \(pip\)$/, true],
    ['git status', /^Git status$/, false],
    ['git commit -am "x"', /^Git commit$/, true],
    ['ls -la src', /^Inspect files \(ls\)$/, false],
    ['echo hello > notes.txt', /^Write notes\.txt \(echo\)$/, true],
    ["sed -i 's/a/b/' app.py", /^Edit files in place \(sed -i\)$/, true],
    ['rm -rf build', /^Delete files \(rm\)$/, true],
    ['Remove-Item -Recurse out', /^Delete files \(Remove-Item\)$/, true],
    ['node test.js 2>&1', /^Run test\.js \(node\)$/, false],
    ['cat x.log | grep ERROR > /dev/null', /^Inspect files/, false],
    ["python -c \"open('out.txt','w').write('x')\"", /^Run inline python code$/, true],
    ['cd src && npm run build && npm test', /^Run script build \(npm\) \(\+1 more step\)$/, false],
  ];
  for (const [cmd, summary, writes] of cases) {
    const info = describeCommand(cmd);
    assert.match(info.summary, summary, cmd);
    assert.equal(info.writes, writes, `${cmd}: writes ${info.writeReasons.join('; ')}`);
  }
  const heredoc = describeCommand("cat > app.py <<'EOF'\nprint('hi')\nEOF");
  assert.equal(heredoc.writes, true);
  assert.deepEqual(heredoc.writeTargets, ['app.py']);
  assert.equal(heredoc.embeddedCode, true);
  assert.equal(heredoc.long, true, 'multi-line commands start collapsed');
  assert.equal(describeCommand('x'.repeat(200)).long, true);
  assert.deepEqual(splitCommands('a && b; c | d || "e;f"'), ['a', 'b', 'c', 'd', '"e;f"']);
  assert.equal(formatDuration(1234), '1.2 s');
  assert.equal(formatDuration(65_000), '1 min 5 s');
});

test('activity view model: summary, write label and duration derived from the recorded command and status history', () => {
  const recorder = new EventRecorder();
  const task = recorder.startTask({ description: 't', source: 'local', adapterName: 'Local', simulated: false });
  const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, operationType: 'Execute', description: "Run: cat > big.py <<'EOF'\n" + 'x = 1\n'.repeat(50) + 'EOF', requiresApproval: true, command: { command: "cat > big.py <<'EOF'\n" + 'x = 1\n'.repeat(50) + 'EOF', workingDirectory: '/p', simulated: false, status: 'Pending', startedAt: '2026-11-18T10:00:00.000Z' } });
  recorder.updateOperation(op.operationId, { status: 'Running' });
  recorder.updateOperation(op.operationId, { status: 'Completed', command: { exitCode: 0, finishedAt: '2026-11-18T10:00:02.500Z', status: 'Completed' } as any });
  const ctl = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' });
  const vm1 = buildActivityViewModel(recorder, ctl.getSnapshot(), { follow: false, selectedTaskId: task.taskId, selectedOperationId: op.operationId });
  const row = vm1.operations[0];
  assert.equal(row.cmd?.summary, 'Write big.py (cat)');
  assert.equal(row.cmd?.writes, true);
  assert.deepEqual(row.cmd?.writeTargets, ['big.py']);
  assert.equal(row.cmd?.duration, '2.5 s');
  assert.equal(row.cmd?.exitCode, 0);
  assert.equal(row.cmd?.long, true);
  assert.ok(vm1.selected?.command?.command.endsWith('EOF'), 'details keep the original command');
});

test('explain-command prompt: exact command, static facts, sections, and never asks to run it', () => {
  const p = explainCommandPrompt({ command: 'rm -rf build && npm ci', cwd: '/p', status: 'Proposed', facts: describeCommand('rm -rf build && npm ci') }, 8000, 'en');
  const user = p.messages[1].content;
  assert.match(user, /rm -rf build && npm ci/);
  assert.match(user, /## Purpose[\s\S]*## Reads[\s\S]*## Writes[\s\S]*## Risks/);
  assert.match(user, /Do not run it/);
  assert.match(user, /May write files \(heuristic\): yes/);
});

// ---------------------------------------------------------------- review before writing

test('conflict check: any change since the snapshot (disk, unsaved editor, creation, deletion) blocks writing', () => {
  assert.equal(snapshotConflict('a\n', 'update', { diskText: 'a\n', dirty: false }), undefined);
  assert.equal(snapshotConflict('a\n', 'update', { diskText: 'a\nb\n', dirty: false }), 'changed');
  assert.equal(snapshotConflict('a\n', 'update', { diskText: 'a\n', dirty: true }), 'unsaved');
  assert.equal(snapshotConflict('a\n', 'update', { diskText: undefined, dirty: false }), 'deleted');
  assert.equal(snapshotConflict('', 'add', { diskText: undefined, dirty: false }), undefined);
  assert.equal(snapshotConflict('', 'add', { diskText: 'someone else wrote this', dirty: false }), 'created');
  assert.equal(snapshotConflict(undefined, 'update', { diskText: 'a', dirty: false }), 'unavailable');
});

test('manual edits: hunks, preservation (kept / overwritten / deletion undone), bounded diffs', () => {
  const agent = 'def f(x):\n    return x\n\ndef g():\n    pass\n';
  const user = 'def f(x):\n    # validated by user\n    if x is None:\n        raise ValueError("x")\n    return x\n\ndef g():\n    pass\n';
  assert.equal(userHunks(agent, user).length, 1);
  const kept = 'def f(x):\n    # validated by user\n    if x is None:\n        raise ValueError("x")\n    return x\n\ndef g():\n    return 2\n';
  assert.deepEqual([checkPreserved(agent, user, kept).preserved, checkPreserved(agent, user, kept).total], [1, 1]);
  const overwritten = 'def f(x):\n    return x * 2\n\ndef g():\n    pass\n';
  const lost = checkPreserved(agent, user, overwritten);
  assert.equal(lost.preserved, 0);
  assert.equal(lost.lost[0].why, 'added lines missing');
  // A deleted debug line that the agent put back.
  const withDebug = 'a = 1\nprint("debug")\nb = 2\n';
  const userDeleted = 'a = 1\nb = 2\n';
  assert.equal(checkPreserved(withDebug, userDeleted, 'a = 1\nprint("debug")\nb = 3\n').lost[0]?.why, 'removed lines restored');
  assert.equal(checkPreserved(withDebug, userDeleted, 'a = 1\nb = 3\n').lost.length, 0);
  const b = boundedDiffs([{ rel: 'a.py', diff: 'x'.repeat(300) }, { rel: 'b.py', diff: 'y'.repeat(5000) }, { rel: 'c.py', diff: 'z' }], 1000);
  assert.ok(b.text.length <= 1000);
  assert.match(b.text, /diff truncated; read the file/);
  assert.deepEqual(b.omitted, ['c.py']);
});

test('local agent: live preview while an edit is generated, cleared when the proposal is complete; regenerate sends the feedback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-preview-'));
  temps.push(root);
  fs.writeFileSync(path.join(root, 'math.js'), 'function divide(a, b) {\n  return a / b;\n}\n');
  const fake = new FakeOpenCode();
  const previews: Array<ControllerSnapshot['preview']> = [];
  let firstReply = '';
  fake.turns = [
    async (s) => {
      s.assistant();
      // Like real OpenCode + Ollama: the pending part first arrives with no arguments.
      s.tool('call_e1', 'write', 'pending', {});
      await new Promise((r) => setTimeout(r, 350));
      s.tool('call_e1', 'write', 'pending', { filePath: path.join(root, 'math.js'), content: 'function divide(a, b) {\n  if (b === 0)' });
      await new Promise((r) => setTimeout(r, 20));
      s.tool('call_e1', 'write', 'pending', { filePath: path.join(root, 'math.js'), content: 'function divide(a, b) {\n  if (b === 0) throw new Error("zero");\n' });
      await new Promise((r) => setTimeout(r, 350));
      const input = { filePath: path.join(root, 'math.js'), content: 'function divide(a, b) {\n  if (b === 0) throw new Error("zero");\n  return a / b;\n}\n' };
      s.tool('call_e1', 'write', 'running', input);
      firstReply = await s.permission('per_1', 'edit', 'call_e1', { filepath: path.join(root, 'math.js') }, ['math.js']);
      s.tool('call_e1', 'write', 'error', input, { error: 'rejected' });
      s.idle();
    },
  ];
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => root });
  controller.onDidChangeState((s) => s.preview && previews.push(s.preview));
  controller.start('Guard divide', new OpenCodeAdapter({ connector: async () => fake, launch: { executable: 'x', homeDir: path.join(root, '.home'), ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 32768, outputLimit: 8192, profile: 'approved-write' } }));
  const snap = await new Promise<ControllerSnapshot>((resolve) => {
    const sub = controller.onDidChangeState((s) => {
      if (s.awaitingApprovalFor) {
        sub.dispose();
        resolve(s);
      }
    });
  });
  assert.ok(previews.length >= 2, 'generating state, then streamed preview');
  assert.equal(previews[0]!.text, '', 'no streamed text yet: "generating; review when complete"');
  assert.equal(previews[0]!.characters, 0);
  assert.equal(buildActivityViewModel(recorder, { ...controller.getSnapshot(), awaitingApprovalFor: undefined, pendingApprovals: [], preview: previews[0] }, { follow: false }).header.statusLabel, 'Generating a proposed change; review when complete');
  assert.equal(previews.at(-1)!.filePath, 'math.js');
  assert.match(previews.at(-1)!.text, /throw new Error/);
  assert.equal(snap.preview, undefined, 'preview cleared once the proposal is complete and awaiting approval');
  assert.equal(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), 'function divide(a, b) {\n  return a / b;\n}\n', 'nothing written during preview');
  // "Regenerate with feedback" = decline with the feedback as the message.
  controller.reject(snap.awaitingApprovalFor!, 'Regenerate requested by the user. Feedback: keep the return type. Re-read the latest math.js first, then propose a new change.');
  await new Promise<void>((resolve) => controller.onDidChangeState((s) => s.awaitingInput && resolve()));
  assert.equal(firstReply, 'reject');
  assert.match(fake.replies.at(-1)!.message!, /Feedback: keep the return type/);
  await controller.endSession();
  await controller.whenIdle();
});

// ---------------------------------------------------------------- file explanation

test('file explanation: purpose / flow / dependencies / modification impact, with project files that import it', () => {
  const files = [
    { filePath: 'importer.py', language: 'python', text: 'from validation import validate_samples\n' },
    { filePath: 'pkg/use.py', language: 'python', text: 'import os\nfrom .validation import summarize\n' },
    { filePath: 'other.py', language: 'python', text: 'validation_rules = 1\n' },
    { filePath: 'web/app.ts', language: 'c-like', text: "import { v } from './lib/validation';\n" },
  ];
  const deps = findImporters('validation.py', files);
  assert.deepEqual(deps.map((d) => `${d.filePath}:${d.line}`), ['importer.py:1', 'pkg/use.py:2']);
  assert.deepEqual(findImporters('web/lib/validation.ts', files).map((d) => d.filePath), ['web/app.ts']);
  const text = 'def validate(x):\n    return x\n';
  const plan = planChunks(text, 'python', { startLine: 1, endLine: 2 }, { maxChunkChars: 5000, maxChunks: 4 });
  const p = buildExplainPrompt({ filePath: 'validation.py', languageId: 'python', scope: 'file', mode: 'structured', text, plan, chunk: plan.chunks[0], totalLines: 2, dependents: deps, language: 'en' }).messages[1].content;
  assert.match(p, /Purpose of this file[\s\S]*Execution flow[\s\S]*Dependencies[\s\S]*Modification impact/);
  assert.match(p, /Project files that import this file[\s\S]*importer\.py:1/);
  assert.match(sectionsFor('symbol')[0], /Role within the project/);
  assert.match(sectionsFor('symbol').at(-1)!, /Modification impact/);
});

// ---------------------------------------------------------------- webviews

class Element {
  id = ''; children: any[] = []; textContent = ''; className = ''; value = ''; disabled = false; open = false; title = ''; tagName: string;
  scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  listeners: Record<string, (e?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag; }
  append(...c: any[]) { this.children.push(...c.filter((x) => x !== '')); }
  appendChild(c: any) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(k: string, fn: (e?: any) => void) { this.listeners[k] = fn; }
  querySelector() { return null; }
}
function load(file: string, state: any = {}) {
  const app = new Element(); app.id = 'app';
  const all = (n: any): any[] => [n, ...(n.children ?? []).flatMap(all)];
  let receive: (e: any) => void = () => {};
  const sent: any[] = [];
  const window: any = { addEventListener: (_: string, fn: any) => { receive = fn; } };
  const ctx = vm.createContext({
    window,
    acquireVsCodeApi: () => ({ getState: () => state, setState: () => {}, postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m))) }),
    document: { getElementById: (id: string) => all(app).find((e) => e.id === id), createElement: (t: string) => new Element(t), createTextNode: (v: string) => Object.assign(new Element('#text'), { textContent: v }), activeElement: null, scrollingElement: { scrollTop: 0 } },
    CSS: { escape: (s: string) => s },
  });
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'markdownView.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(MEDIA, file), 'utf8'), ctx);
  return { app, all: () => all(app), sent, deliver: (data: any) => receive({ data }) };
}

test('conversation: proposal card offers accept/reject/edit/regenerate; conflict blocks approval; live preview is read-only; manual-change buttons', () => {
  const ui = load('conversation.js');
  const base = { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'waiting' }, messages: [], turns: [], canSend: false, mode: 'live', manual: { tracked: 2, validating: false } };
  const approval = { id: 'op1', type: 'Edit', description: 'Edit math.js (+3 −0)', hasChange: true, awaitingApproval: true, editing: false };
  ui.deliver({ type: 'state', model: { ...base, approvals: [approval], preview: { tool: 'write', filePath: 'math.js', text: 'function divide', characters: 15 } } });
  const btn = (label: string) => ui.all().find((e) => e.tagName === 'button' && e.textContent.startsWith(label));
  assert.equal(btn('p.editFirst — ')!.disabled, true, 'no editing while generating');
  assert.ok(ui.all().some((e) => e.textContent === 'function divide'), 'live preview text');
  ui.all().find((e) => e.tagName === 'button' && e.textContent === 'p.editFirst')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'editProposal', operationId: 'op1' });
  btn('a.approve')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'approve', operationId: 'op1' });
  // Feedback for regenerate comes from the composer draft.
  const input = ui.all().find((e) => e.id === 'message')!;
  input.value = 'keep the signature';
  input.listeners.input();
  btn('p.regenerate')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'regenerate', operationId: 'op1', feedback: 'keep the signature' });
  ui.deliver({ type: 'state', model: { ...base, approvals: [{ ...approval, editing: true, conflict: 'math.js changed on disk since the diff was computed' }] } });
  assert.equal(btn('a.approve')!.disabled, true, 'approval disabled on conflict');
  assert.ok(ui.all().some((e) => /p\.conflict|math\.js changed/.test(e.textContent)));
  btn('p.applyMine')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'applyEdited', operationId: 'op1' });
  // Command approval: summary + write label, full command collapsed.
  ui.deliver({ type: 'state', model: { ...base, approvals: [{ id: 'op2', type: 'Execute', description: 'Run: rm -rf build', hasChange: false, command: 'rm -rf build', cmd: { summary: 'Delete files (rm)', writes: true, writeReasons: ['rm deletes build'], long: false, embeddedCode: false } }] } });
  assert.ok(ui.all().some((e) => e.textContent === 'Delete files (rm)'));
  assert.ok(ui.all().some((e) => e.className === 'pill writes'));
  assert.equal(btn('p.editFirst'), undefined, 'no edit for commands');
  // Manual changes.
  ui.deliver({ type: 'state', model: { ...base, canSend: true, approvals: [] } });
  input.value = 'now add tests';
  input.listeners.input();
  btn('m.continue')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'manual', kind: 'continue', text: 'now add tests' });
});

test('activity view model: steps grouped by turn; one primary action and a short error reason, from the records', () => {
  const recorder = new EventRecorder();
  const task = recorder.startTask({ description: 't', source: 'local', adapterName: 'Local', simulated: false });
  const add = (input: any, final?: any) => {
    const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, requiresApproval: false, ...input });
    if (final) recorder.updateOperation(op.operationId, final);
    return op;
  };
  const setup = add({ operationType: 'Analyze', description: 'Session started' }, { status: 'Completed', resultSummary: 'Session s1.' });
  recorder.startTurn(task.taskId);
  const read = add({ operationType: 'Read', description: 'Read math.js', filePath: 'math.js' }, { status: 'Completed' });
  const test1 = add(
    { operationType: 'Test', description: 'Run tests: node test.js', command: { command: 'node test.js', workingDirectory: '/p', simulated: false, status: 'Pending' } },
    { status: 'Failed', command: { exitCode: 1, stdout: 'running\nAssertionError: 1 == 2\n    at test.js:3', status: 'Failed' } as any },
  );
  const answer = add({ operationType: 'Analyze', description: 'Local agent: done' }, { status: 'Completed', resultSummary: 'The guard is in place.' });
  recorder.finishTurn(task.taskId, 'Completed');
  recorder.startTurn(task.taskId);
  const edit = add({ operationType: 'Edit', description: 'Edit math.js (+3 −0)', filePath: 'math.js', associatedChangeId: 'chg-1' });
  const snap = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' }).getSnapshot();
  const vmodel = buildActivityViewModel(recorder, { ...snap, taskId: task.taskId, taskStatus: 'Running', pendingApprovals: [edit.operationId], awaitingApprovalFor: edit.operationId }, { follow: false, selectedTaskId: task.taskId });
  const row = (id: string) => vmodel.operations.find((o) => o.id === id)!;
  assert.deepEqual([setup, read, test1, answer, edit].map((o) => row(o.operationId).turn), [0, 1, 1, 1, 2]);
  assert.deepEqual([read, test1, answer, edit].map((o) => row(o.operationId).primary), ['file', 'error', 'result', 'review']);
  assert.equal(row(test1.operationId).errorReason, 'exit 1: AssertionError: 1 == 2');
  assert.equal(row(read.operationId).errorReason, undefined);
  const g = Object.fromEntries(vmodel.turnGroups.map((x) => [x.number, x]));
  assert.equal(g[1].open, false, 'completed turn collapsed');
  assert.equal(g[1].failed, 1);
  assert.equal(g[2].open, true, 'turn with a pending approval open');
  assert.equal(g[2].pending, 1);
});

test('activity webview: completed turns collapsed; title toggles brief inline details; one primary action; secondary actions in "…"', () => {
  const ui = load('activity.js', {});
  const cmd = { summary: 'Run tests (pytest)', writes: false, writeTargets: [], writeReasons: [], long: true, embeddedCode: true, short: 'pytest', duration: '2.5 s', exitCode: 1 };
  const long = 'python - <<' + "'END'\n" + 'print(1)\n'.repeat(40) + 'END';
  const base = { seq: 1, time: '10:00', simulated: false, isCurrent: false, control: 'OBSERVED', hasChange: false, hasCommand: false };
  const failed = { ...base, id: 'op1', seq: 3, turn: 1, type: 'Test', status: 'Failed', description: 'Run tests: ' + long, awaitingApproval: false, hasCommand: true, cmd, primary: 'error', errorReason: 'exit 1: E   assert 1 == 2' };
  const readOp = { ...base, id: 'op2', seq: 4, turn: 1, type: 'Read', status: 'Completed', description: 'Read math.js', file: 'math.js', awaitingApproval: false, primary: 'file' };
  const pending = { ...base, id: 'op3', seq: 5, turn: 2, type: 'Edit', status: 'Proposed', description: 'Edit math.js (+3 −0)', file: 'math.js', awaitingApproval: true, hasChange: true, primary: 'review' };
  const model = (selected?: any) => ({
    header: { statusLabel: 'Running', statusKind: 'running', adapterName: 'x', simulated: false, liveTracking: true, awaitingInput: false },
    controls: { reviewerEnabled: true },
    tasks: [],
    selectedTaskId: 't',
    language: 'en',
    strings: {},
    operations: [failed, readOp, pending],
    hiddenOperationCount: 0,
    conversation: [],
    turns: [],
    turnGroups: [
      { number: 1, status: 'Completed', steps: 2, failed: 1, pending: 0, open: false },
      { number: 2, status: 'Running', steps: 1, failed: 0, pending: 1, open: true },
    ],
    selected,
  });
  ui.deliver({ type: 'state', model: model() });
  const groups = ui.all().filter((e) => e.className === 'turn-group');
  assert.deepEqual(groups.map((g) => g.open), [false, true], 'completed turn collapsed, running turn open');
  const btn = (label: string) => ui.all().find((e) => e.tagName === 'button' && e.textContent === label);
  btn('a.reviewChanges')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'review', operationId: 'op3' }, 'pending edit: Review changes opens the diff');
  btn('a.viewFile')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'reveal', operationId: 'op2' }, 'View file opens the editor');
  assert.ok(ui.all().some((e) => e.className === 'op-error' && e.textContent === 'exit 1: E   assert 1 == 2'), 'short error reason on the row');
  const titleNode = () => ui.all().find((e) => e.attrs['data-id'] === 'op1')!;
  const deep = (n: any): any[] => [n, ...(n.children ?? []).flatMap(deep)];
  const rowTexts = deep(titleNode()).map((e: any) => e.textContent);
  assert.ok(rowTexts.includes('Run tests (pytest)'));
  assert.ok(!rowTexts.some((t: string) => t.includes('print(1)')), 'the long command is not in the row');
  // Clicking the title selects without opening anything, then brief inline details appear.
  titleNode().listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'select', operationId: 'op1', reveal: false });
  const detail = {
    ...failed,
    timestamp: 't',
    history: [
      { status: 'Proposed', timestamp: '2026-11-18T10:00:00Z', actor: 'agent' },
      { status: 'Failed', timestamp: '2026-11-18T10:00:02Z', actor: 'agent' },
    ],
    controlExplanation: 'observed',
    changeCount: 0,
    changedLines: [],
    affectedFunctions: [],
    hasFailedCommand: true,
    canApprove: false,
    canReject: false,
    canReviewChange: false,
    canReveal: false,
    command: { command: long, workingDirectory: '/p', status: 'Failed', exitCode: 1, stdout: 'E   assert 1 == 2', simulated: false },
  };
  ui.deliver({ type: 'state', model: model(detail) });
  const brief = ui.all().find((e) => e.className === 'brief')!;
  assert.ok(brief, 'inline details shown');
  const full = deep(brief).find((e) => e.className === 'full-command')!;
  assert.equal(full.open, false, 'long command with embedded code collapsed');
  assert.ok(full.children.some((c: any) => c.textContent === long), 'original command preserved');
  assert.ok(deep(brief).some((e) => e.textContent === 'E   assert 1 == 2'), 'output inline');
  assert.ok(deep(brief).some((e) => e.className === 'audit'), 'full audit trail kept (folded)');
  const menus = ui.all().filter((e) => e.className === 'more');
  assert.equal(menus.length, 3);
  const menuButtons = (i: number) => deep(menus[i]).filter((e: any) => e.tagName === 'button').map((e: any) => e.textContent);
  assert.deepEqual(menuButtons(0), ['a.commandOutput', 'c.copyCommand', 'c.copyOutput', 'c.explain', 'a.aiError', 'a.export', 'a.fullRecord']);
  deep(menus[0]).find((e: any) => e.textContent === 'c.copyCommand').listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'copy', operationId: 'op1', what: 'command' });
  deep(menus[0]).find((e: any) => e.textContent === 'a.fullRecord').listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'record', operationId: 'op1' });
  assert.ok(menuButtons(2).includes('p.editFirst') && menuButtons(2).includes('p.regenerate'));
  // Clicking the title again collapses (no message, nothing opened).
  const sentBefore = ui.sent.length;
  titleNode().listeners.click();
  assert.equal(ui.sent.length, sentBefore);
  assert.equal(ui.all().find((e) => e.className === 'brief'), undefined);
});
