import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { applyAll, describeApplyFailure, EditFileInput, EditSession, FileStore } from '../review/multiFileEdit';

const temps: string[] = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const FILES: EditFileInput[] = [
  { changeId: 'c0', rel: 'src/a.js', abs: '/p/src/a.js', kind: 'update', original: 'const a = 1;\n', proposed: 'const a = 2;\n' },
  { changeId: 'c1', rel: 'src/b.js', abs: '/p/src/b.js', kind: 'update', original: 'const b = 1;\n', proposed: 'const b = 2;\n' },
  { changeId: 'c2', rel: 'src/c.js', abs: '/p/src/c.js', kind: 'add', original: '', proposed: 'const c = 3;\n' },
  { changeId: 'c3', rel: 'old.js', abs: '/p/old.js', kind: 'delete', original: 'legacy();\n', proposed: '' },
];

/** In-memory files; optionally fail a write or a restore. */
function memoryStore(initial: Record<string, string>, fail: { write?: string; restore?: string } = {}): FileStore & { files: Map<string, string>; writes: string[] } {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const written = new Set<string>();
  return {
    files,
    writes,
    read: async (abs) => files.get(abs),
    isDirty: () => false,
    write: async (abs, text) => {
      if (fail.write === abs) {
        files.set(abs, text.slice(0, 3)); // a partial write before the error
        throw new Error('disk full');
      }
      if (fail.restore === abs && written.has(abs)) throw new Error('locked');
      written.add(abs);
      writes.push(abs);
      files.set(abs, text);
    },
    remove: async (abs) => {
      writes.push(`rm ${abs}`);
      files.delete(abs);
    },
  };
}

test('multi-file edit session: per-file working text survives switching; reset restores one file; state and fingerprint follow the edits', () => {
  const s = new EditSession(FILES);
  assert.equal(s.multi, true);
  assert.equal(s.active, 0);
  assert.ok(s.state().every((f) => f.excluded === false));
  assert.deepEqual(s.state().map((f) => [f.rel, f.kind, f.editable, f.edited, f.added, f.removed]), [
    ['src/a.js', 'update', true, false, 1, 1],
    ['src/b.js', 'update', true, false, 1, 1],
    ['src/c.js', 'add', true, false, 1, 0],
    ['old.js', 'delete', false, false, 0, 1],
  ]);
  const fp0 = s.fingerprint();
  assert.equal(s.setText(0, 'const a = 42; // mine\n'), true);
  s.select(1);
  assert.equal(s.setText(1, 'const b = 99;\n'), true);
  s.select(2);
  s.select(0);
  assert.equal(s.text(0), 'const a = 42; // mine\n', 'switching away and back keeps the edit');
  assert.equal(s.text(1), 'const b = 99;\n');
  assert.notEqual(s.fingerprint(), fp0);
  assert.equal(s.reset(1), 'const b = 2;\n');
  assert.deepEqual(s.state().map((f) => f.edited), [true, false, false, false], 'only the reset file returns to the proposal');
  assert.equal(s.setText(3, 'keep me'), false, 'deletions have no editable text');
  assert.equal(s.state()[0].active, true);
  s.reset(0);
  assert.equal(s.fingerprint(), fp0, 'same content, same fingerprint');
  assert.throws(() => s.select(9), /No file #9/);
  assert.throws(() => new EditSession([]), /no file changes/);
  const single = new EditSession([FILES[0]]);
  assert.equal(single.multi, false, 'single-file proposals keep the one-step flow');
});

test('multi-file edit session: the consolidated diff covers every file, marks user edits, new and deleted files', () => {
  const s = new EditSession(FILES);
  s.setText(0, 'const a = 42;\n');
  s.setText(2, '');
  const d = s.consolidatedDiff();
  assert.match(d, /^# Combined change: 4 of 4 file\(s\), \+2 −3; 2 edited by you\. Nothing has been written yet\./);
  assert.match(d, /diff --git a\/src\/a\.js b\/src\/a\.js \(edited by you\)\n--- a\/src\/a\.js\n\+\+\+ b\/src\/a\.js\n@@[^\n]*\n(-const a = 1;\n\+const a = 42;|\+const a = 42;\n-const a = 1;)/);
  assert.match(d, /diff --git a\/src\/b\.js b\/src\/b\.js\n[\s\S]*\+const b = 2;/);
  assert.match(d, /src\/c\.js \(edited by you\)\nnew file\n--- \/dev\/null\n\+\+\+ b\/src\/c\.js\n\(no change: identical to the current file\)/);
  assert.match(d, /deleted file\n--- a\/old\.js\n\+\+\+ \/dev\/null\n@@[^\n]*\n-legacy\(\);/);
  assert.deepEqual(s.plan().map((p) => [p.rel, p.kind, p.text]), [
    ['src/a.js', 'update', 'const a = 42;\n'],
    ['src/b.js', 'update', 'const b = 2;\n'],
    ['src/c.js', 'add', ''],
    ['old.js', 'delete', undefined],
  ]);
});

test('multi-file edit session: a proposed deletion can be excluded (file kept) without rejecting the rest; reset re-includes it', async () => {
  const s = new EditSession(FILES);
  assert.throws(() => s.setExcluded(0, true), /Only proposed deletions can be excluded; edit src\/a\.js instead/);
  const fp = s.fingerprint();
  s.setExcluded(3, true);
  assert.notEqual(s.fingerprint(), fp, 'excluding changes what would be applied, so a new preview is needed');
  assert.deepEqual(s.state()[3], { index: 3, rel: 'old.js', kind: 'delete', editable: false, excluded: true, edited: true, active: false, added: 0, removed: 0 });
  assert.deepEqual(s.plan().map((p) => p.rel), ['src/a.js', 'src/b.js', 'src/c.js'], 'the kept file is not part of the plan');
  const d = s.consolidatedDiff();
  assert.match(d, /^# Combined change: 3 of 4 file\(s\), \+3 −2; 0 edited by you; 1 deletion\(s\) excluded\./);
  assert.match(d, /diff --git a\/old\.js b\/old\.js\n\(deletion excluded by you: the file is kept unchanged\)\n/);
  assert.equal(s.hasWrites(), true);
  // Applying writes the rest and leaves the kept file untouched.
  const store = memoryStore({ '/p/src/a.js': 'const a = 1;\n', '/p/src/b.js': 'const b = 1;\n', '/p/old.js': 'legacy();\n' });
  assert.equal((await applyAll(s.plan(), store)).ok, true);
  assert.equal(store.files.get('/p/old.js'), 'legacy();\n');
  assert.equal(store.files.get('/p/src/c.js'), 'const c = 3;\n');
  s.reset(3);
  assert.equal(s.isExcluded(3), false, 'reset restores the proposed deletion');
  assert.equal(s.fingerprint(), fp);
  const onlyDelete = new EditSession([FILES[3]]);
  onlyDelete.setExcluded(0, true);
  assert.equal(onlyDelete.hasWrites(), false, 'nothing left to apply: the UI tells the user to reject instead');
});

test('apply all: writes, creates and deletes every file on a real filesystem; then reports exactly what was written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-multi-'));
  temps.push(root);
  const files = FILES.map((f) => ({ ...f, abs: path.join(root, f.rel) }));
  fs.mkdirSync(path.join(root, 'src'));
  for (const f of files) if (f.kind !== 'add') fs.writeFileSync(f.abs, f.original);
  const store: FileStore = {
    read: async (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined),
    write: async (abs, text) => fs.writeFileSync(abs, text),
    remove: async (abs) => fs.rmSync(abs),
  };
  const s = new EditSession(files);
  s.setText(0, 'const a = 42;\n');
  const r = await applyAll(s.plan(), store);
  assert.deepEqual(r, { ok: true, written: ['src/a.js', 'src/b.js', 'src/c.js', 'old.js'] });
  assert.equal(fs.readFileSync(files[0].abs, 'utf8'), 'const a = 42;\n');
  assert.equal(fs.readFileSync(files[1].abs, 'utf8'), 'const b = 2;\n');
  assert.equal(fs.readFileSync(files[2].abs, 'utf8'), 'const c = 3;\n');
  assert.equal(fs.existsSync(files[3].abs), false);
});

test('apply all: version check before any write — a changed, unsaved, deleted or newly created file blocks the whole proposal', async () => {
  const initial = { '/p/src/a.js': 'const a = 1;\n', '/p/src/b.js': 'const b = 1;\n', '/p/old.js': 'legacy();\n' };
  const plan = new EditSession(FILES).plan();
  const cases: Array<[Record<string, string | undefined>, string, string, boolean?]> = [
    [{ '/p/src/b.js': 'const b = 1;\n// someone else\n' }, 'src/b.js', 'changed'],
    [{ '/p/src/c.js': 'other content\n' }, 'src/c.js', 'created'],
    [{ '/p/old.js': undefined }, 'old.js', 'deleted'],
    [{}, 'src/a.js', 'unsaved', true],
  ];
  for (const [patch, rel, reason, dirty] of cases) {
    const store = memoryStore(initial);
    for (const [k, v] of Object.entries(patch)) v === undefined ? store.files.delete(k) : store.files.set(k, v);
    if (dirty) store.isDirty = (abs) => abs === '/p/src/a.js';
    const r = await applyAll(plan, store);
    assert.equal(r.ok, false, reason);
    assert.ok(!r.ok && r.stage === 'validate');
    assert.deepEqual(!r.ok && r.stage === 'validate' && r.conflicts, [{ rel, reason }]);
    assert.deepEqual(store.writes, [], `${reason}: nothing written`);
    assert.match(describeApplyFailure(r as Exclude<typeof r, { ok: true }>), new RegExp(`^nothing was written: ${rel.replace('.', '\\.')} \\(${reason}\\)`));
  }
});

test('apply all: a failed write rolls back every file already written (and the partial one); a failed restore is reported, never hidden', async () => {
  const initial = { '/p/src/a.js': 'const a = 1;\n', '/p/src/b.js': 'const b = 1;\n', '/p/old.js': 'legacy();\n' };
  // Order: a, b, c (new), old (delete). Fail on c after a and b were written.
  const reordered = [FILES[0], FILES[1], FILES[3], FILES[2]];
  const plan = new EditSession(reordered).plan();
  const store = memoryStore(initial, { write: '/p/src/c.js' });
  const r = await applyAll(plan, store);
  assert.ok(!r.ok && r.stage === 'write');
  assert.equal(r.failed, 'src/c.js');
  assert.deepEqual(r.rolledBack, ['src/c.js', 'old.js', 'src/b.js', 'src/a.js']);
  assert.deepEqual(r.rollbackFailed, []);
  assert.deepEqual(Object.fromEntries(store.files), initial, 'every file is back to its previous content; the partially created file is gone');
  assert.match(describeApplyFailure(r), /writing src\/c\.js failed \(disk full\)\. Every file already written was restored/);

  const stuck = memoryStore(initial, { write: '/p/src/c.js', restore: '/p/src/a.js' });
  const r2 = await applyAll(new EditSession(FILES).plan(), stuck);
  assert.ok(!r2.ok && r2.stage === 'write');
  assert.deepEqual(r2.rollbackFailed, ['src/a.js']);
  assert.match(describeApplyFailure(r2), /Could NOT restore src\/a\.js; check this file\. Restored: src\/c\.js, src\/b\.js\./);
});

// ---------------------------------------------------------------- webview

const MEDIA = path.resolve(__dirname, '..', '..', 'media');
class Element {
  id = ''; children: any[] = []; textContent = ''; className = ''; value = ''; disabled = false; open = false; title = ''; tagName: string;
  scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  listeners: Record<string, (e?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag; }
  append(...c: any[]) { this.children.push(...c.filter((x) => x !== '').map((x) => (typeof x === 'string' ? Object.assign(new Element('#text'), { textContent: x }) : x))); }
  appendChild(c: any) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(k: string, fn: (e?: any) => void) { this.listeners[k] = fn; }
  querySelector() { return null; }
}
function loadConversation() {
  const app = new Element(); app.id = 'app';
  const all = (n: any): any[] => [n, ...(n.children ?? []).flatMap(all)];
  let receive: (e: any) => void = () => {};
  const sent: any[] = [];
  // Webview clock: a new approval card ignores clicks for its first 0.7 s. Delivering a state advances the
  // clock by 1 s (as if the user read the card) unless raw = true; timers are not needed here.
  const clock = { t: 1_000_000 };
  const RealDate = Date;
  class FakeDate extends RealDate { static now() { return clock.t; } }
  const ctx = vm.createContext({
    Date: FakeDate,
    setTimeout: () => 0,
    window: { addEventListener: (_: string, fn: any) => { receive = fn; } },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m))) }),
    document: { getElementById: (id: string) => all(app).find((e) => e.id === id), createElement: (t: string) => new Element(t), createTextNode: (v: string) => Object.assign(new Element('#text'), { textContent: v }), activeElement: null, scrollingElement: { scrollTop: 0 } },
    CSS: { escape: (s: string) => s },
  });
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'markdownView.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'conversation.js'), 'utf8'), ctx);
  return { all: () => all(app), sent, deliver: (data: any) => { receive({ data }); clock.t += 1000; } };
}

test('conversation webview: multi-file proposal shows a selectable file list with per-file reset, combined preview, apply and cancel', () => {
  const ui = loadConversation();
  const base = { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'waiting' }, messages: [], turns: [], canSend: false, mode: 'live' };
  const files = [
    { index: 0, rel: 'src/a.js', kind: 'update', editable: true, excluded: false, edited: true, active: false, added: 1, removed: 1 },
    { index: 1, rel: 'src/b.js', kind: 'update', editable: true, excluded: false, edited: false, active: true, added: 1, removed: 1 },
    { index: 2, rel: 'old.js', kind: 'delete', editable: false, excluded: false, edited: false, active: false, added: 0, removed: 1 },
  ];
  const approval = { id: 'op1', type: 'Edit', description: 'Edit 3 files', hasChange: true, awaitingApproval: true, editing: true, fileCount: 3, edit: { multi: true, previewed: false, files } };
  ui.deliver({ type: 'state', model: { ...base, approvals: [approval] } });
  const btn0 = (label: string) => ui.all().find((e) => e.tagName === 'button' && e.textContent === label)!;
  const items = ui.all().filter((e) => e.tagName === 'li');
  assert.deepEqual(items.map((e) => e.className), ['edit-file edited', 'edit-file active', 'edit-file delete']);
  btn0('p.keepFile').listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'excludeDeletion', operationId: 'op1', index: 2, excluded: true });
  ui.deliver({ type: 'state', model: { ...base, approvals: [{ ...approval, edit: { ...approval.edit, files: [files[0], files[1], { ...files[2], excluded: true, edited: true }] } }] } });
  assert.ok(ui.all().some((e) => e.textContent === ' p.fileKept'), 'kept file is labelled');
  btn0('p.deleteAgain').listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'excludeDeletion', operationId: 'op1', index: 2, excluded: false });
  ui.deliver({ type: 'state', model: { ...base, approvals: [approval] } });
  const fileButtons = ui.all().filter((e) => e.tagName === 'button' && e.className === 'file-link');
  assert.deepEqual(fileButtons.map((b) => b.textContent), ['src/a.js', 'src/b.js', 'old.js']);
  assert.equal(fileButtons[1].attrs['aria-current'], 'true');
  fileButtons[2].listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'editFile', operationId: 'op1', index: 2 });
  const btn = (label: string) => ui.all().filter((e) => e.tagName === 'button' && e.textContent === label);
  assert.equal(btn('p.resetFile').length, 1, 'reset only for edited files');
  btn('p.resetFile')[0].listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'resetEditFile', operationId: 'op1', index: 0 });
  assert.ok(ui.all().some((e) => e.textContent === 'p.previewBeforeApply'), 'says the combined diff comes first');
  btn('p.previewAll')[0].listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'previewEdited', operationId: 'op1' });
  btn('p.applyMineN')[0].listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'applyEdited', operationId: 'op1' });
  btn('p.cancelEdit')[0].listeners.click();
  assert.deepEqual(ui.sent.at(-1), { type: 'action', action: 'cancelEdit', operationId: 'op1' });
  // Single-file proposals keep the original card (no list), plus cancel while editing.
  ui.deliver({ type: 'state', model: { ...base, approvals: [{ ...approval, fileCount: 1, edit: { multi: false, previewed: false, files: [files[0]] } }] } });
  assert.equal(ui.all().filter((e) => e.tagName === 'li').length, 0);
  assert.equal(btn('p.applyMine').length, 1);
  assert.equal(btn('p.cancelEdit').length, 1);
  ui.deliver({ type: 'state', model: { ...base, approvals: [{ ...approval, editing: false, edit: undefined }] } });
  assert.equal(btn('p.editFirst').length, 1);
  assert.equal(btn('p.cancelEdit').length, 0);
});
