import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

test('conversation UI selects sessions, renders retained text/results, sends inline, and preserves newer drafts', () => {
  class Element {
    id = ''; children: Element[] = []; textContent = ''; className = ''; value = ''; disabled = false;
    scrollTop = 0; scrollHeight = 100; clientHeight = 100;
    listeners: Record<string, (event?: any) => void> = {};
    attrs: Record<string, string> = {};
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute(k: string, v: string) { this.attrs[k] = v; }
    addEventListener(k: string, fn: (event?: any) => void) { this.listeners[k] = fn; }
  }
  const app = new Element(); app.id = 'app';
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  let receive: (event: any) => void = () => {};
  const sent: any[] = [];
  let saved: any;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../media/conversation.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: (s: any) => { saved = s; }, postMessage: (m: any) => sent.push(m) }),
    document: { getElementById: (id: string) => all(app).find((e) => e.id === id), createElement: () => new Element() },
    window: { addEventListener: (_: string, fn: typeof receive) => { receive = fn; } },
  });
  const model = { strings: {}, taskId: 'task-a', tasks: [{ taskId: 'task-a', title: 'First conversation', date: 'today', status: 'ready' }, { taskId: 'task-b', title: 'Other conversation', date: 'today', status: 'Completed' }], header: { statusLabel: 'Turn complete', statusKind: 'idle', taskDescription: 'First conversation' }, messages: [{ role: 'assistant', text: '<script>not executable</script>', timestamp: '2026-11-17T12:00:00Z' }], turns: [{ number: 1, status: 'Completed', report: 'node test.js: Completed, exit 0' }], approvals: [], canSend: true, mode: 'live' };
  const deliver = (data: any) => receive({ data });
  deliver({ type: 'state', model });
  assert.ok(all(app).some((e) => e.textContent === '<script>not executable</script>'));
  assert.ok(all(app).some((e) => /exit 0/.test(e.textContent)));
  const input = () => all(app).find((e) => e.id === 'message')!;
  input().value = 'Explain this change'; input().listeners.input();
  all(app).find((e) => e.textContent === 'chat.send')!.listeners.click();
  assert.equal(sent.at(-1).text, 'Explain this change');
  assert.equal(sent.at(-1).taskId, 'task-a');
  input().value = 'My next question'; input().listeners.input();
  deliver({ type: 'sent', taskId: 'task-a', sent: true });
  assert.equal(input().value, 'My next question', 'an acknowledgement cannot erase a newer draft');
  deliver({ type: 'state', model: { ...model, canSend: false, blocked: 'chat.busy' } });
  assert.equal(input().value, 'My next question');
  assert.equal(all(app).find((e) => e.textContent === 'chat.send')!.disabled, true);
  all(app).find((e) => e.className === 'session' && e.children.some((child) => child.textContent === 'Other conversation'))!.listeners.click();
  assert.equal(sent.at(-1).type, 'select');
  assert.equal(sent.at(-1).taskId, 'task-b');
  assert.equal(saved.drafts['task-a'], 'My next question');
});
