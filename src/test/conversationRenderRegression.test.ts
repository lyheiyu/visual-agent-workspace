import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { parseMarkdown } from '../references/markdown';

class Element {
  id = ''; children: Element[] = []; textContent = ''; className = ''; value = '';
  scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  listeners: Record<string, (event?: any) => void> = {};
  attrs: Record<string, string> = {};
  constructor(readonly tagName = 'div') {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, listener: (event?: any) => void) { this.listeners[key] = listener; }
}

function webview(brokenRenderer = false) {
  const app = new Element(); app.id = 'app';
  const all = (element: Element): Element[] => [element, ...element.children.flatMap(all)];
  let receive: (event: any) => void = () => {};
  const sent: any[] = [];
  const errors: unknown[] = [];
  const window: any = { addEventListener: (_: string, listener: typeof receive) => { receive = listener; } };
  const context = vm.createContext({
    window,
    console: { error: (...args: unknown[]) => errors.push(args) },
    acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: (message: any) => sent.push(message) }),
    document: {
      getElementById: (id: string) => all(app).find((node) => node.id === id),
      createElement: (tag: string) => new Element(tag),
      createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
    },
  });
  const media = path.resolve(__dirname, '../../media');
  vm.runInContext(fs.readFileSync(path.join(media, 'markdownView.js'), 'utf8'), context);
  if (brokenRenderer) window.VAWMarkdown.create = () => ({ render: () => { throw new Error('Unsupported formatting'); } });
  vm.runInContext(fs.readFileSync(path.join(media, 'conversation.js'), 'utf8'), context);
  return {
    nodes: () => all(app), sent, errors,
    show(text: string) {
      receive({ data: { type: 'state', model: {
        strings: {}, taskId: 'saved-conversation', tasks: [],
        header: { statusLabel: 'Turn complete', statusKind: 'idle' },
        messages: [{ role: 'assistant', text, ast: parseMarkdown(text), timestamp: '2026-11-17T12:00:00Z' }],
        turns: [{ number: 1, status: 'Completed', report: text, ast: parseMarkdown(text) }],
        approvals: [], canSend: true, mode: 'live',
      } } });
    },
  };
}

test('saved conversations containing nested lists and blockquotes reopen with messages, results and composer', () => {
  const view = webview();
  assert.doesNotThrow(() => view.show('# Previous answer\n\n- Read file\n  - Inspect function\n- Review diff\n\n> Results\n>\n> 1. Run tests\n> 2. Explain changes'));
  assert.ok(view.nodes().filter((node) => node.tagName === 'ul').length >= 2);
  assert.ok(view.nodes().some((node) => node.tagName === 'ol'));
  assert.ok(view.nodes().some((node) => node.tagName === 'blockquote'));
  assert.ok(view.nodes().some((node) => node.id === 'message'));
  assert.equal(view.errors.length, 0);
  view.nodes().find((node) => node.textContent === 'chat.send')!.listeners.click();
});

test('a formatting error falls back to original text without losing the composer or preventing follow-up', () => {
  const view = webview(true);
  const text = '## Preserved answer\n\n- Existing message';
  assert.doesNotThrow(() => view.show(text));
  assert.ok(view.nodes().some((node) => node.tagName === 'pre' && node.textContent === text));
  const input = view.nodes().find((node) => node.id === 'message')!;
  input.value = 'Continue from here'; input.listeners.input();
  view.nodes().find((node) => node.textContent === 'chat.send')!.listeners.click();
  assert.equal(view.sent.at(-1).type, 'send');
  assert.equal(view.sent.at(-1).text, 'Continue from here');
  assert.ok(view.errors.length > 0);
});
