import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { findReferences, parseReferenceTarget, sanitizeReference } from '../references/codeReference';
import { Block, Inline, parseMarkdown, parsePlain, textOf } from '../references/markdown';
import { resolveReference, walkForSuffix } from '../references/referenceResolver';

const MEDIA = path.resolve(__dirname, '..', '..', 'media');

function refs(ast: unknown, acc: Array<{ ref: any; text: string }> = []): Array<{ ref: any; text: string }> {
  if (Array.isArray(ast)) ast.forEach((x) => refs(x, acc));
  else if (ast && typeof ast === 'object') {
    const n = ast as any;
    if (n.t === 'ref') acc.push({ ref: n.ref, text: textOf(n.c) });
    for (const v of Object.values(n)) if (v && typeof v === 'object') refs(v, acc);
  }
  return acc;
}
function nodes(ast: unknown, t: string, acc: any[] = []): any[] {
  if (Array.isArray(ast)) ast.forEach((x) => nodes(x, t, acc));
  else if (ast && typeof ast === 'object') {
    if ((ast as any).t === t) acc.push(ast);
    for (const v of Object.values(ast)) if (v && typeof v === 'object') nodes(v, t, acc);
  }
  return acc;
}

test('acceptance: Markdown link with an absolute Windows path containing spaces and :line', () => {
  const ast = parseMarkdown('[mujoco_optimizer.py:167](C:/D/projects/Orca robot hand/orca sim/orca_sim/src/orca_sim/mujoco_optimizer.py:167)');
  const [r] = refs(ast);
  assert.deepEqual(r.ref, { path: 'C:/D/projects/Orca robot hand/orca sim/orca_sim/src/orca_sim/mujoco_optimizer.py', line: 167 });
  assert.equal(r.text, 'mujoco_optimizer.py:167', 'the label is preserved');
});

test('reference formats: file:line, file:line:column, #L, ranges, relative, absolute, file://, code spans', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['mujoco_optimizer.py:167', { path: 'mujoco_optimizer.py', line: 167 }],
    ['gesture_retargeting.py:55:9', { path: 'gesture_retargeting.py', line: 55, column: 9 }],
    ['palm_aligned_optimizer.py#L62', { path: 'palm_aligned_optimizer.py', line: 62 }],
    ['src/x.ts#L4C2', { path: 'src/x.ts', line: 4, column: 2 }],
    ['src/x.ts#L10-L20', { path: 'src/x.ts', line: 10, endLine: 20 }],
    ['src/orca_sim/mujoco_optimizer.py', { path: 'src/orca_sim/mujoco_optimizer.py' }],
    ['./run_palm_aligned_experiment.py:177', { path: 'run_palm_aligned_experiment.py', line: 177 }],
    [String.raw`C:\D\Orca robot hand\x.py:12:5`, { path: String.raw`C:\D\Orca robot hand\x.py`, line: 12, column: 5 }],
    ['/home/u/proj/a.json:3', { path: '/home/u/proj/a.json', line: 3 }],
    ['file:///C:/a%20b/c.py#L10-L20', { path: 'C:/a b/c.py', line: 10, endLine: 20 }],
    ['`config/settings.json`', { path: 'config/settings.json' }],
    ['`C:/Orca robot hand/orca sim/x.py:3`', { path: 'C:/Orca robot hand/orca sim/x.py', line: 3 }],
    ['[rel](orca sim/x.py#L3)', { path: 'orca sim/x.py', line: 3 }],
    ['[t](<C:/a b/c.tsx>)', { path: 'C:/a b/c.tsx' }],
    ['see `python scripts/run.py --flag`', { path: 'scripts/run.py' }],
    ['在 mujoco_optimizer.py:167 中', { path: 'mujoco_optimizer.py', line: 167 }],
  ];
  for (const [src, want] of cases) {
    const found = refs(parseMarkdown(src));
    assert.equal(found.length, 1, `${src}: ${JSON.stringify(found)}`);
    for (const [k, v] of Object.entries(want)) assert.equal(found[0].ref[k], v, `${src}: ${k}`);
  }
});

test('ordinary prose, numbers, versions, URLs and identifiers are not references', () => {
  const prose = [
    'Version v0.4 took 3.14 s at 12:30; e.g. 167 items, ratio 1:2.',
    'Node.js and Vue.js are frameworks; config.json alone in prose is not linked.',
    'np.linalg.norm and self.foo(x) and os.path.join are code, not files.',
    'Visit https://example.com/src/main.py:12 or www.example.org/a.js for details.',
    'C:/foo/bar is a dir and x.py is mentioned.',
    'snake_case_name and __dunder__ words.',
  ];
  for (const s of prose) assert.deepEqual(refs(parseMarkdown(s)), [], s);
  assert.deepEqual(refs(parseMarkdown('`np.linalg.norm` `torch.nn` `a + b`')), []);
  assert.equal(nodes(parseMarkdown('Visit https://example.com/src/main.py:12 now'), 'link').length, 1);
});

test('Markdown structure is preserved: tables with refs and pipes in code, code blocks, lists, quotes, links', () => {
  const md = [
    '## Findings',
    '',
    '| File | Line | Note |',
    '|---|---:|:---:|',
    '| `palm_aligned_optimizer.py:62` | 62 | uses `a|b` |',
    '| run_palm_aligned_experiment.py:177 | 177 | **bold** |',
    '',
    '```python',
    'x = load("mujoco_optimizer.py:167")  # not linked inside code blocks',
    '<script>alert(1)</script>',
    '```',
    '',
    '1. first `src/a.ts:3`',
    '   - nested see [docs](https://example.com)',
    '2. second',
    '',
    '> quoted gesture_retargeting.py:55',
    '',
    '---',
  ].join('\n');
  const ast = parseMarkdown(md);
  assert.deepEqual(ast.map((b) => b.t), ['h', 'table', 'pre', 'ol', 'quote', 'hr']);
  const table = ast[1] as Extract<Block, { t: 'table' }>;
  assert.deepEqual(table.align, [null, 'right', 'center']);
  assert.equal(table.rows.length, 2);
  assert.equal(textOf(table.rows[0][2]), 'uses a|b', 'pipe inside a code span does not split the cell');
  assert.deepEqual(refs(table).map((r) => r.ref.path), ['palm_aligned_optimizer.py', 'run_palm_aligned_experiment.py']);
  const pre = ast[2] as Extract<Block, { t: 'pre' }>;
  assert.equal(pre.lang, 'python');
  assert.match(pre.v, /<script>alert\(1\)<\/script>/, 'code block content is kept verbatim');
  assert.deepEqual(refs(pre), []);
  const ol = ast[3] as Extract<Block, { t: 'ol' }>;
  assert.equal(ol.items.length, 2);
  assert.equal(nodes(ol, 'ul').length, 1, 'nested list');
  assert.equal(nodes(ol, 'link')[0].href, 'https://example.com');
  assert.equal(refs(ast[4]).length, 1);
});

test('unsafe content: HTML stays text, javascript:/command:/data: links are never links or references', () => {
  const ast = parseMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert(1)) [run](command:workbench.action.terminal.new) [d](data:text/html,<b>x</b>) [v](vscode://ext/x.py)');
  assert.deepEqual(nodes(ast, 'link'), []);
  assert.deepEqual(refs(ast), []);
  assert.match(textOf((ast[0] as any).c), /<img src=x onerror=alert\(1\)>/);
  for (const bad of ['command:foo', 'javascript:alert(1)', 'https://x/a.py', 'vscode://x', '', 'a\0b.py']) assert.equal(sanitizeReference({ path: bad }), undefined, bad);
  assert.deepEqual(sanitizeReference({ refPath: 'a.py', refLine: 3, refColumn: 2, refEndLine: 1, extra: 'x' }), { path: 'a.py', line: 3, column: 2, endLine: undefined });
  assert.equal(sanitizeReference({ path: 'a.py', line: -1 })!.line, undefined);
  assert.equal(parseReferenceTarget('C:/x/' + 'a'.repeat(2000) + '.py'), undefined, 'over-long paths are refused');
});

test('user messages keep every character and line break; only references become links', () => {
  const ast = parsePlain('**not bold**\n  x.py:3  \n<b>');
  const p = ast[0] as Extract<Block, { t: 'p' }>;
  assert.equal(textOf(p.c), '**not bold**\n  x.py:3  \n<b>');
  assert.equal(refs(ast).length, 1);
});

test('resolver: absolute with spaces, relative, multi-root, ambiguous, missing, outside, folders', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-ref-'));
  try {
    const orca = path.join(tmp, 'Orca robot hand', 'orca sim', 'orca_sim');
    const mk = (p: string, lines = 200) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Array.from({ length: lines }, (_, i) => `# line ${i + 1}`).join('\n'));
    };
    const target = path.join(orca, 'src', 'orca_sim', 'mujoco_optimizer.py');
    mk(target);
    mk(path.join(orca, 'scripts', 'run_palm_aligned_experiment.py'));
    const other = path.join(tmp, 'other project');
    mk(path.join(other, 'src', 'orca_sim', 'mujoco_optimizer.py'));
    mk(path.join(other, 'util.py'));
    mk(path.join(orca, 'util.py'));
    mk(path.join(orca, 'a', 'same.py'));
    mk(path.join(orca, 'b', 'same.py'));
    mk(path.join(orca, 'node_modules', 'pkg', 'gesture_retargeting.py'));
    mk(path.join(tmp, 'outside.py'));

    const roots = [orca, other];
    // Absolute path with spaces (the acceptance example), forward slashes.
    let r = await resolveReference({ path: target.replace(/\\/g, '/'), line: 167 }, { roots });
    assert.equal(r.kind, 'file');
    assert.equal(path.normalize((r as any).absolutePath), target);
    // Relative to the primary root wins over an identical path in another root.
    r = await resolveReference({ path: 'src/orca_sim/mujoco_optimizer.py' }, { roots });
    assert.equal(r.kind === 'file' && r.root, orca);
    r = await resolveReference({ path: 'util.py' }, { roots: [other, orca] });
    assert.equal(r.kind === 'file' && r.absolutePath, path.join(other, 'util.py'));
    // Bare filename found by suffix search; dependency folders are skipped.
    r = await resolveReference({ path: 'run_palm_aligned_experiment.py', line: 177 }, { roots });
    assert.equal(r.kind === 'file' && r.via, 'suffix');
    r = await resolveReference({ path: 'gesture_retargeting.py' }, { roots });
    assert.equal(r.kind, 'missing', 'node_modules is not searched');
    // Ambiguous: two files with the same name → the caller must ask.
    r = await resolveReference({ path: 'same.py' }, { roots });
    assert.equal(r.kind, 'ambiguous');
    assert.equal((r as any).candidates.length, 2);
    // A relative path written from a parent folder ("orca sim/orca_sim/util.py") resolves by suffix.
    r = await resolveReference({ path: 'orca sim/orca_sim/util.py' }, { roots });
    assert.equal(r.kind === 'file' && r.absolutePath, path.join(orca, 'util.py'));
    // Outside every root.
    r = await resolveReference({ path: path.join(tmp, 'outside.py') }, { roots });
    assert.equal(r.kind, 'outside');
    r = await resolveReference({ path: '../../../outside.py' }, { roots: [orca] });
    assert.equal(r.kind, 'outside', 'relative escapes are reported, not silently opened');
    // Missing and folder.
    assert.equal((await resolveReference({ path: 'nope/missing.py' }, { roots })).kind, 'missing');
    assert.equal((await resolveReference({ path: 'src' }, { roots })).kind, 'invalid');
    assert.equal((await resolveReference({ path: 'x.py' }, { roots: [] })).kind, 'missing');
    // Absolute path from another machine: trailing segments found in the project.
    r = await resolveReference({ path: '/home/someone/orca_sim/src/orca_sim/mujoco_optimizer.py' }, { roots: [orca] });
    assert.equal(r.kind === 'file' && r.absolutePath, target);
    if (process.platform === 'win32') {
      const msys = '/' + target[0].toLowerCase() + target.slice(2).replace(/\\/g, '/');
      r = await resolveReference({ path: msys }, { roots });
      assert.equal(r.kind, 'file', 'Git-Bash style /c/... paths');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('suffix search is bounded', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-walk-'));
  try {
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(tmp, `d${i}`));
    fs.writeFileSync(path.join(tmp, 'd29', 'x.py'), '');
    assert.deepEqual(await walkForSuffix(tmp, ['x.py'], path, { maxEntries: 5 }), []);
    assert.equal((await walkForSuffix(tmp, ['x.py'])).length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- webview

class Element {
  id = ''; children: any[] = []; textContent = ''; className = ''; value = ''; disabled = false; tagName: string;
  scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  listeners: Record<string, (event?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag; }
  append(...children: any[]) { this.children.push(...children); }
  appendChild(c: any) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(k: string, fn: (event?: any) => void) { this.listeners[k] = fn; }
  set innerHTML(_v: string) { throw new Error('innerHTML must never be used'); }
}

test("conversation webview: Markdown rendered with DOM nodes; clicking a reference posts a validated-shape message", () => {
  const app = new Element(); app.id = 'app';
  const all = (node: any): any[] => [node, ...(node.children ?? []).flatMap(all)];
  let receive: (event: any) => void = () => {};
  const sent: any[] = [];
  const window: any = { addEventListener: (_: string, fn: typeof receive) => { receive = fn; } };
  const context = vm.createContext({
    window,
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: (m: any) => sent.push(m) }),
    document: { getElementById: (id: string) => all(app).find((e) => e.id === id), createElement: (t: string) => new Element(t), createTextNode: (v: string) => Object.assign(new Element('#text'), { textContent: v }) },
  });
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'markdownView.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(MEDIA, 'conversation.js'), 'utf8'), context);
  const text = 'Look at [mujoco_optimizer.py:167](C:/D/projects/Orca robot hand/orca sim/orca_sim/src/orca_sim/mujoco_optimizer.py:167)\n\n| a | b |\n|---|---|\n| `x.py:3` | <script>alert(1)</script> |\n\n[site](https://example.com)';
  // Same JSON round trip as postMessage.
  const ast = JSON.parse(JSON.stringify(parseMarkdown(text)));
  receive({ data: { type: 'state', model: { strings: {}, taskId: 't1', tasks: [], header: { statusLabel: '', statusKind: 'idle' }, messages: [{ role: 'assistant', text, ast, timestamp: '2026-11-17T12:00:00Z' }], turns: [], approvals: [], canSend: true, mode: 'live' } } });
  const anchors = all(app).filter((e) => e.tagName === 'a' && /code-ref/.test(e.className));
  assert.equal(anchors.length, 2);
  assert.ok(all(app).some((e) => e.tagName === 'table'));
  assert.ok(all(app).some((e) => e.textContent === '<script>alert(1)</script>'), 'HTML is shown as text');
  assert.ok(!all(app).some((e) => e.tagName === 'script'));
  const ctx = JSON.parse(anchors[0].attrs['data-vscode-context']);
  assert.equal(ctx.webviewSection, 'codeRef');
  assert.equal(ctx.refLine, 167);
  assert.equal(JSON.parse(all(app).find((e) => e.id === 'messages').attrs['data-vscode-context']).taskId, 't1');
  anchors[0].listeners.click({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'openReference', ref: { path: 'C:/D/projects/Orca robot hand/orca sim/orca_sim/src/orca_sim/mujoco_optimizer.py', line: 167 }, side: false });
  anchors[1].listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(sent.at(-1).ref.path, 'x.py');
  anchors[1].listeners.auxclick({ button: 1 });
  assert.equal(sent.at(-1).side, true, 'middle-click opens to the side');
  const ext = all(app).find((e) => e.tagName === 'a' && /ext-link/.test(e.className));
  assert.equal(ext.attrs.href, undefined, 'external links have no href (the webview never navigates)');
  ext.listeners.click({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'openLink', href: 'https://example.com' });
});

test('webview scripts never use innerHTML/outerHTML/insertAdjacentHTML or eval', () => {
  for (const f of fs.readdirSync(MEDIA).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(MEDIA, f), 'utf8');
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|\beval\(|new Function/, f);
  }
});

test('findReferences keeps offsets for embedded references', () => {
  const s = 'python scripts/run.py --cfg conf/a.yaml:3';
  assert.deepEqual(findReferences(s).map((m) => s.slice(m.start, m.end)), ['scripts/run.py', 'conf/a.yaml:3']);
  const inl: Inline[] = (parseMarkdown('`' + s + '`')[0] as any).c[0].c;
  assert.equal(inl.filter((n) => n.t === 'ref').length, 2);
});
