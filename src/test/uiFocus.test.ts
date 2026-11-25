import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentController } from '../controller/AgentController';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { buildActivityViewModel } from '../ui/viewModel';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');

class Element {
  id = ''; children: any[] = []; textContent = ''; className = ''; value = ''; disabled = false; open = false; title = ''; tagName: string;
  isConnected = true; scrollTop = 0; scrollHeight = 100; clientHeight = 100; scrolled = 0;
  listeners: Record<string, (e?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag; }
  append(...c: any[]) { this.children.push(...c.filter((x) => x !== '' && x !== null && x !== undefined && x !== false).map((x) => (typeof x === 'string' ? Object.assign(new Element('#text'), { textContent: x }) : x))); }
  appendChild(c: any) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; }
  getAttribute(k: string) { return this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  removeAttribute(k: string) { if (k === 'open') this.open = false; delete this.attrs[k]; }
  addEventListener(k: string, fn: (e?: any) => void) { this.listeners[k] = fn; }
  querySelector() { return null; }
  scrollIntoView() { this.scrolled++; }
  focus() {}
}

function load(file: string) {
  const app = new Element(); app.id = 'app';
  const all = (n: any): any[] => [n, ...(n.children ?? []).flatMap(all)];
  let receive: (e: any) => void = () => {};
  const sent: any[] = [];
  let state: any = {};
  // Webview clock: a new approval card ignores clicks for its first 0.7 s. Delivering a state advances the
  // clock by 1 s (as if the user read the card) unless raw = true; timers are not needed here.
  const clock = { t: 1_000_000 };
  const RealDate = Date;
  class FakeDate extends RealDate { static now() { return clock.t; } }
  const ctx = vm.createContext({
    Date: FakeDate,
    setTimeout: () => 0,
    window: { addEventListener: (k: string, fn: any) => { if (k === 'message') receive = fn; } },
    acquireVsCodeApi: () => ({ getState: () => state, setState: (s: any) => { state = s; }, postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m))) }),
    document: {
      getElementById: (id: string) => all(app).find((e) => e.id === id),
      createElement: (t: string) => new Element(t),
      createTextNode: (v: string) => Object.assign(new Element('#text'), { textContent: v }),
      addEventListener: () => {},
      querySelector: (sel: string) => {
        const m = /^\[data-id="(.+)"\]$/.exec(sel);
        return m ? all(app).find((e) => e.attrs?.['data-id'] === m[1]) ?? null : null;
      },
      querySelectorAll: () => [],
      activeElement: null,
      scrollingElement: { scrollTop: 0 },
    },
    Element,
    CSS: { escape: (s: string) => s },
  });
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'markdownView.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(MEDIA, file), 'utf8'), ctx);
  // app.querySelector is used by activity.js for focus/scroll lookups.
  (app as any).querySelector = (sel: string) => {
    const m = /^\[data-id="(.+)"\]$/.exec(sel);
    return m ? all(app).find((e) => e.attrs?.['data-id'] === m[1]) ?? null : null;
  };
  return { all: () => all(app), sent, deliver: (model: any, raw = false) => { receive({ data: { type: 'state', model } }); if (!raw) clock.t += 1000; }, tick: (ms: number) => { clock.t += ms; } };
}

// ---------------------------------------------------------------- view model

test('focus step: pending approval, else the running step, else the newest failure of the newest turn', () => {
  const recorder = new EventRecorder();
  const task = recorder.startTask({ description: 't', source: 'local', adapterName: 'Local', simulated: false });
  const add = (input: any, final?: any) => {
    const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, requiresApproval: false, ...input });
    if (final) recorder.updateOperation(op.operationId, final);
    return op;
  };
  recorder.startTurn(task.taskId);
  const oldFail = add({ operationType: 'Test', description: 'old failure' }, { status: 'Failed', resultSummary: 'boom' });
  recorder.finishTurn(task.taskId, 'Completed');
  recorder.startTurn(task.taskId);
  const fail = add({ operationType: 'Test', description: 'new failure' }, { status: 'Failed', resultSummary: 'bad' });
  const running = add({ operationType: 'Read', description: 'reading' }, { status: 'Running' });
  const edit = add({ operationType: 'Edit', description: 'Edit math.js', associatedChangeId: 'c1' });
  const snap = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' }).getSnapshot();
  const live = { ...snap, taskId: task.taskId, taskStatus: 'Running' as const };
  const vmFor = (s: any) => buildActivityViewModel(recorder, s, { follow: true, selectedTaskId: task.taskId });
  const a = vmFor({ ...live, pendingApprovals: [edit.operationId], awaitingApprovalFor: edit.operationId, currentOperationId: running.operationId });
  assert.equal(a.focusId, edit.operationId, 'a pending approval comes first');
  assert.equal(a.focus?.canApprove, true, 'its details are included');
  const b = vmFor({ ...live, pendingApprovals: [], currentOperationId: running.operationId });
  assert.equal(b.focusId, running.operationId, 'then the running step');
  const c = vmFor({ ...live, pendingApprovals: [], currentOperationId: undefined });
  assert.equal(c.focusId, fail.operationId, 'then the newest failure of the newest turn');
  assert.notEqual(c.focusId, oldFail.operationId, 'a failure in a completed older turn stays collapsed');
});

// ---------------------------------------------------------------- activity webview

const header = { statusLabel: 'Running', statusKind: 'running', adapterName: 'x', simulated: false, liveTracking: true, awaitingInput: false };
const row = (id: string, seq: number, extra: any = {}) => ({ id, seq, time: '10:00', type: 'Read', status: 'Completed', description: `Read f${seq}.js`, file: `f${seq}.js`, simulated: false, awaitingApproval: false, isCurrent: false, control: 'OBSERVED', hasCommand: false, hasChange: false, turn: 1, primary: 'file', ...extra });
const detail = (r: any) => ({ ...r, timestamp: 't', history: [], controlExplanation: '', changeCount: 0, changedLines: [], affectedFunctions: [], hasFailedCommand: false, canApprove: false, canReject: false, canReviewChange: false, canReveal: false, resultSummary: `details of ${r.id}` });
const model = (ops: any[], over: any = {}) => ({
  header, controls: { reviewerEnabled: false, follow: true }, tasks: [{ taskId: 't', label: 't' }], selectedTaskId: 't', language: 'en', strings: {},
  operations: ops, hiddenOperationCount: 0, conversation: [], turns: [],
  turnGroups: [...new Set(ops.map((o) => o.turn))].map((n) => ({ number: n, status: 'Running', steps: ops.filter((o) => o.turn === n).length, failed: 0, pending: 0, open: true })),
  ...over,
});
const briefs = (ui: ReturnType<typeof load>) => ui.all().filter((e) => e.className === 'brief');
const briefText = (ui: ReturnType<typeof load>) => briefs(ui).map((b) => JSON.stringify(b, (k, v) => (k === 'listeners' ? undefined : v))).join('');
const title = (ui: ReturnType<typeof load>, id: string) => ui.all().find((e) => e.attrs?.['data-id'] === id)!;

test('activity: the focus step opens by itself; manual expansion wins and stays; closing the automatic one keeps it closed until the focus moves', () => {
  const ui = load('activity.js');
  const a = row('a', 1, { type: 'Execute', primary: 'command' });
  const cur = row('cur', 2, { type: 'Execute', status: 'Running', isCurrent: true, primary: 'command' });
  ui.deliver(model([a, cur], { focusId: 'cur', focus: detail(cur) }));
  assert.equal(briefs(ui).length, 1, 'exactly one step open');
  assert.match(briefText(ui), /details of cur/, 'the running step opened without a click');
  // Manual expansion of another step: it wins, and only it is open.
  title(ui, 'a').listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'select', operationId: 'a', reveal: false });
  ui.deliver(model([a, cur], { focusId: 'cur', focus: detail(cur), selected: detail(a) }));
  assert.equal(briefs(ui).length, 1);
  assert.match(briefText(ui), /details of a/);
  // Updates (a new focus) do not take the manually opened step away.
  const next = row('next', 3, { type: 'Execute', status: 'Running', isCurrent: true, primary: 'command' });
  ui.deliver(model([a, { ...cur, status: 'Completed', isCurrent: false }, next], { focusId: 'next', focus: detail(next), selected: detail(a) }));
  assert.match(briefText(ui), /details of a/, 'manual expansion respected');
  // Collapse the manual one → the focus step is shown again.
  title(ui, 'a').listeners.click();
  ui.deliver(model([a, { ...cur, status: 'Completed', isCurrent: false }, next], { focusId: 'next', focus: detail(next) }));
  assert.match(briefText(ui), /details of next/);
  // Close the automatic one: it stays closed on updates…
  title(ui, 'next').listeners.click();
  ui.deliver(model([a, next], { focusId: 'next', focus: detail(next) }));
  assert.equal(briefs(ui).length, 0, 'closed by the user');
  // …until the focus moves on.
  const fail = row('fail', 4, { type: 'Test', status: 'Failed', errorReason: 'exit 1', primary: 'error' });
  ui.deliver(model([a, next, fail], { focusId: 'fail', focus: detail(fail) }));
  assert.match(briefText(ui), /details of fail/, 'a new failure opens');
});

test('activity: 3+ finished reads are grouped into one collapsed row; its open state survives updates; completed turns collapse unless the user opened them', () => {
  const ui = load('activity.js');
  const reads = [1, 2, 3, 4].map((n) => row('r' + n, n));
  const edit = row('e', 5, { type: 'Edit', status: 'Completed', primary: 'diff', hasChange: true, description: 'Edit x.js' });
  ui.deliver(model([...reads, edit]));
  const runs = () => ui.all().filter((e) => e.className === 'op-run');
  assert.equal(runs().length, 1);
  assert.equal(runs()[0].open, false, 'collapsed by default');
  assert.ok(JSON.stringify(runs()[0].children[0]).includes('× 4 · #1–#4'), 'summary: count and range');
  assert.ok(title(ui, 'r3'), 'every step is still there inside the group');
  assert.ok(title(ui, 'e'), 'other steps stay ungrouped');
  runs()[0].open = true;
  runs()[0].listeners.toggle();
  ui.deliver(model([...reads, edit]));
  assert.equal(runs()[0].open, true, 'the user opened it: still open after an update');
  // Two reads are not grouped.
  ui.deliver(model([row('x1', 1), row('x2', 2), edit]));
  assert.equal(runs().length, 0);
  // Turns: a running turn is open; once completed it collapses, unless the user opened it.
  const t1 = [row('t1', 1, { turn: 1 })];
  const t2 = [row('t2', 2, { turn: 2 })];
  const turnModel = (s1: string, s2: string, o1: boolean, o2: boolean) => model([...t1, ...t2], { turnGroups: [{ number: 1, status: s1, steps: 1, failed: 0, pending: 0, open: o1 }, { number: 2, status: s2, steps: 1, failed: 0, pending: 0, open: o2 }] });
  ui.deliver(turnModel('Completed', 'Running', false, true));
  const groups = () => ui.all().filter((e) => e.className === 'turn-group');
  assert.deepEqual(groups().map((g) => g.open), [false, true]);
  groups()[0].open = true;
  groups()[0].listeners.toggle(); // the user opens the completed turn 1
  ui.deliver(turnModel('Completed', 'Completed', false, false));
  assert.deepEqual(groups().map((g) => g.open), [true, false], 'turn 2 collapsed automatically; turn 1 kept open by the user');
});

test('activity: approving disables the banner buttons until the state changes; a second click sends nothing', () => {
  const ui = load('activity.js');
  const p = row('p', 1, { type: 'Edit', status: 'Proposed', awaitingApproval: true, hasChange: true, primary: 'review' });
  ui.deliver(model([p], { focusId: 'p', focus: { ...detail(p), canApprove: true, canReject: true } }));
  const btn = (label: string) => ui.all().find((e) => e.tagName === 'button' && e.textContent === label);
  assert.equal(ui.all().filter((e) => e.tagName === 'button' && e.textContent === 'a.approve').length, 1, 'one Approve (banner), not repeated in the details');
  btn('a.approve')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'approve', operationId: 'p' });
  const n = ui.sent.length;
  assert.equal(btn('a.approve')!.disabled, true);
  assert.equal(btn('a.reject')!.disabled, true);
  btn('a.approve')!.listeners.click();
  btn('a.reject')!.listeners.click();
  assert.equal(ui.sent.length, n, 'no duplicate decision');
  // Approved elsewhere / here: the banner disappears with the state.
  ui.deliver(model([{ ...p, status: 'Running', awaitingApproval: false }]));
  assert.equal(btn('a.approve'), undefined, 'no obsolete approval buttons');
  // Editing your own version: the banner applies it instead of approving the agent's.
  ui.deliver(model([{ ...p, editing: true }], { focusId: 'p' }));
  assert.equal(btn('a.approve'), undefined);
  btn('p.applyMine')!.listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'applyEdited', operationId: 'p' });
  assert.ok(btn('p.cancelEdit'));
});

// ---------------------------------------------------------------- conversation webview

test('conversation: turn reports you open stay open while the agent works; the latest is open by default', () => {
  const ui = load('conversation.js');
  const turn = (n: number) => ({ number: n, status: 'Completed', report: `report ${n}`, failedOperations: 0 });
  const base = { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'running' }, messages: [], canSend: false, mode: 'live', approvals: [] };
  ui.deliver({ ...base, turns: [turn(1), turn(2)] });
  const turns = () => ui.all().filter((e) => e.tagName === 'details' && String(e.className).startsWith('turn'));
  assert.deepEqual(turns().map((d) => d.open), [false, true]);
  turns()[0].open = true;
  turns()[0].listeners.toggle();
  ui.deliver({ ...base, turns: [turn(1), turn(2), turn(3)] });
  assert.deepEqual(turns().map((d) => d.open), [true, true, true].map((_, i) => i !== 1), 'turn 1 kept open by the user; turn 2 collapses as it is no longer the latest; turn 3 open');
});

test('repetition: identical failed retries are one collapsed row; a recovered failure does not take focus; the turn report merges identical lines', async () => {
  const ui = load('activity.js');
  const fails = [1, 2, 3].map((n) => row('f' + n, n, { type: 'Edit', status: 'Failed', file: 'src/math.js', errorReason: 'Could not find oldString', primary: 'error' }));
  const ok = row('ok', 4, { type: 'Edit', status: 'Completed', file: 'src/math.js', primary: 'diff', hasChange: true });
  ui.deliver(model([...fails, ok]));
  const runs = ui.all().filter((e) => e.className === 'op-run');
  assert.equal(runs.length, 1, 'three identical failures grouped');
  assert.ok(JSON.stringify(runs[0].children[0]).includes('Could not find oldString'), 'the reason is shown once on the group');
  assert.equal(ui.all().filter((e) => e.className === 'op-error' && e.textContent === 'Could not find oldString').length, 4, 'one on the group row + each step inside');

  // View model: the failures were retries the later Completed edit recovered from → no automatic expansion.
  const recorder = new EventRecorder();
  const task = recorder.startTask({ description: 't', source: 'local', adapterName: 'Local', simulated: false });
  recorder.startTurn(task.taskId);
  for (let i = 0; i < 3; i++) recorder.updateOperation(recorder.recordOperation(task.taskId, { source: 'local', simulated: false, requiresApproval: false, operationType: 'Edit', description: 'Edit src/math.js', filePath: 'src/math.js' }).operationId, { status: 'Failed', resultSummary: 'Could not find oldString' });
  const done = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, requiresApproval: false, operationType: 'Edit', description: 'Edit src/math.js', filePath: 'src/math.js' });
  recorder.updateOperation(done.operationId, { status: 'Completed' });
  recorder.finishTurn(task.taskId, 'Completed');
  const snap = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' }).getSnapshot();
  const vmodel = buildActivityViewModel(recorder, snap, { follow: true, selectedTaskId: task.taskId });
  assert.equal(vmodel.focusId, undefined, 'recovered failure: nothing pops open');
  assert.equal(vmodel.turnGroups.at(-1)!.open, true, 'the newest (just finished) turn stays open until the next one starts');
  const report = recorder.getTask(task.taskId)!.turns!.at(-1)!.report!;
  assert.match(report, /- src\/math\.js: Failed \(×3\)/);
  assert.match(report, /- Edit src\/math\.js: Could not find oldString \(×3\)/);
  assert.equal(report.match(/Could not find oldString/g)!.length, 1, 'the failure text appears once');
});

test('a proposal that just appeared cannot be decided by the second click of a double click (both panels)', () => {
  // Agent Activity: approve #1, the agent immediately asks for #2 at the same place.
  const ui = load('activity.js');
  const p1 = row('p1', 1, { type: 'Execute', status: 'Proposed', awaitingApproval: true, primary: 'command' });
  const p2 = row('p2', 2, { type: 'Execute', status: 'Proposed', awaitingApproval: true, primary: 'command' });
  const approve = () => ui.all().find((e) => e.tagName === 'button' && e.textContent === 'a.approve')!;
  ui.deliver(model([p1]));
  approve().listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'approve', operationId: 'p1' });
  ui.deliver(model([{ ...p1, status: 'Running', awaitingApproval: false }, p2]), true); // arrives 0 ms later
  const n = ui.sent.length;
  assert.equal(approve().disabled, true, 'the new card starts disabled');
  approve().listeners.click();
  assert.equal(ui.sent.length, n, 'the second click of the double click does not approve #2');
  ui.tick(800);
  approve().listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'approve', operationId: 'p2' }, 'a deliberate click after 0.7 s works');

  // Conversation panel: same rule.
  const cv = load('conversation.js');
  const base = { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'waiting' }, messages: [], turns: [], canSend: false, mode: 'live' };
  const card = (id: string) => ({ id, type: 'Execute', description: 'Run: git status', hasChange: false, awaitingApproval: true, command: 'git status' });
  const cbtn = () => cv.all().find((e) => e.tagName === 'button' && e.textContent === 'a.approve')!;
  cv.deliver({ ...base, approvals: [card('c2')] }, true);
  cbtn().listeners.click();
  assert.equal(cv.sent.filter((m) => m.action === 'approve').length, 0, 'ignored right after it appeared');
  cv.tick(800);
  cbtn().listeners.click();
  assert.deepEqual(cv.sent.at(-1), { type: 'action', action: 'approve', operationId: 'c2' });
});

test('after a decision, the other pending cards of the panel are briefly locked too (the next card moving under the mouse)', () => {
  const cv = load('conversation.js');
  const base = { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'waiting' }, messages: [], turns: [], canSend: false, mode: 'live' };
  const card = (id: string) => ({ id, type: 'Execute', description: `Run: cat ${id}`, hasChange: false, awaitingApproval: true, command: `cat ${id}` });
  cv.deliver({ ...base, approvals: [card('a'), card('b')] });
  const approves = () => cv.all().filter((e) => e.tagName === 'button' && e.textContent === 'a.approve');
  approves()[0].listeners.click();
  assert.deepEqual(cv.sent.at(-1), { type: 'action', action: 'approve', operationId: 'a' });
  // 'a' is decided; 'b' slides into its place within the same double click.
  cv.deliver({ ...base, approvals: [card('b')] }, true);
  approves()[0].listeners.click();
  assert.equal(cv.sent.filter((m) => m.action === 'approve').length, 1, '"b" was not approved by the second click');
  cv.tick(800);
  approves()[0].listeners.click();
  assert.deepEqual(cv.sent.at(-1), { type: 'action', action: 'approve', operationId: 'b' });
});

test('a step expanded by hand keeps its details when Follow selects newer steps', () => {
  const recorder = new EventRecorder();
  const task = recorder.startTask({ description: 't', source: 'local', adapterName: 'Local', simulated: false });
  const mk = (d: string) => { const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, requiresApproval: false, operationType: 'Read', description: d }); recorder.updateOperation(op.operationId, { status: 'Completed', resultSummary: d }); return op; };
  const old = mk('old step');
  const newer = mk('newer step');
  const snap = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => '' }).getSnapshot();
  const vmodel = buildActivityViewModel(recorder, snap, { follow: true, selectedTaskId: task.taskId, selectedOperationId: newer.operationId, expandedOperationId: old.operationId });
  assert.equal(vmodel.selected?.id, newer.operationId);
  assert.equal(vmodel.expanded?.id, old.operationId, 'details of the hand-expanded step are still sent');
  const ui = load('activity.js');
  const rows = [row(old.operationId, 1), row(newer.operationId, 2)];
  ui.deliver(model(rows));
  title(ui, old.operationId).listeners.click();
  assert.deepEqual(ui.sent.slice(-2), [{ type: 'expand', operationId: old.operationId }, { type: 'select', operationId: old.operationId, reveal: false }]);
  ui.deliver(model(rows, { selected: detail(rows[1]), expanded: { ...detail(rows[0]), resultSummary: 'details of old' } }));
  assert.match(briefText(ui), /details of old/, 'not "Loading…"');
});
