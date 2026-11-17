import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

test('task form follows workspace changes, retains instructions, and ignores old project model replies', () => {
  class Element {
    children: Element[] = [];
    attrs: Record<string, string> = {};
    listeners: Record<string, () => void> = {};
    value = '';
    textContent = '';
    appendChild(child: Element) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    addEventListener(k: string, fn: () => void) { this.listeners[k] = fn; }
  }
  const app = new Element();
  const sent: any[] = [];
  let receive: (e: { data: any }) => void = () => {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../media/newTask.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => sent.push(m) }),
    document: { getElementById: () => app, createElement: () => new Element() },
    window: { addEventListener: (_: string, fn: typeof receive) => { receive = fn; } },
  });
  const deliver = (data: any) => receive({ data });
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const provider = { id: 'codex', displayName: 'Codex', available: true, profiles: [{ id: 'observe', label: 'Read only' }] };
  const models = [{ id: 'gpt-6.1-sol', label: 'Sol', compatible: true, efforts: ['low', 'medium', 'high'] }];
  deliver({ type: 'init', strings: {}, providers: [provider], workspaces: [{ name: 'A', path: '/A' }], defaultWorkspace: '/A' });
  deliver({ type: 'models', provider: 'codex', workspace: '/A', models });
  const input = all(app).find((e) => e.attrs['aria-label'] === 'nt.instructions')!;
  input.value = 'Inspect the current project';
  input.listeners.input();
  deliver({ type: 'workspacesUpdated', workspaces: [{ name: 'B', path: '/B' }], defaultWorkspace: '/B' });
  assert.equal(sent.at(-1).workspace, '/B');
  deliver({ type: 'models', provider: 'codex', workspace: '/A', models });
  assert.equal(all(app).find((e) => e.textContent === 'nt.start')!.attrs.disabled, '');
  deliver({ type: 'models', provider: 'codex', workspace: '/B', models });
  const effort = all(app).find((e) => e.attrs['aria-label'] === 'nt.effort')!;
  assert.deepEqual(effort.children.map((e) => e.attrs.value), ['low', 'medium', 'high']);
  effort.value = 'high';
  effort.listeners.change();
  all(app).find((e) => e.textContent === 'nt.start')!.listeners.click();
  const start = sent.at(-1);
  assert.equal(start.selection.workspaceRoot, '/B');
  assert.equal(start.selection.instructions, 'Inspect the current project');
  assert.equal(start.selection.effort, 'high');
});
