// @ts-check
// Renders the whitelisted Markdown AST produced by src/references/markdown.ts.
// DOM APIs and textContent only: no innerHTML, no href navigation, no inline
// handlers. File references post a message; the extension host re-validates
// and resolves them before opening anything.
(function (root) {
  const TAGS = { em: 'em', strong: 'strong', del: 'del' };

  /** @param {any} ref */
  function label(ref) {
    return `${ref.path}${ref.line ? ':' + ref.line : ''}${ref.line && ref.column ? ':' + ref.column : ''}${ref.endLine ? '-' + ref.endLine : ''}`;
  }

  /**
   * @param {Document} doc
   * @param {{ onRef: (ref: any, side: boolean) => void, onLink?: (href: string) => void, refTitle?: (ref: any) => string, linkTitle?: (href: string) => string, context?: Record<string, unknown> }} handlers
   */
  function create(doc, handlers) {
    /** @param {string} tag @param {string} [text] @param {string} [cls] */
    function el(tag, text, cls) {
      const n = doc.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }
    /** @param {any} el2 @param {() => void} fn */
    function activate(el2, fn) {
      el2.setAttribute('role', 'link');
      el2.setAttribute('tabindex', '0');
      el2.addEventListener('click', (/** @type {any} */ e) => {
        if (e && e.preventDefault) e.preventDefault();
        fn();
      });
      el2.addEventListener('keydown', (/** @type {any} */ e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          if (e.preventDefault) e.preventDefault();
          fn();
        }
      });
    }
    /** @param {any[]} nodes @param {any} parent */
    function inline(nodes, parent) {
      for (const n of nodes || []) {
        if (n.t === 'text') parent.append(doc.createTextNode ? doc.createTextNode(n.v) : el('span', n.v));
        else if (n.t === 'br') parent.append(el('br'));
        else if (n.t === 'code') inline(n.c, append(parent, el('code')));
        else if (TAGS[n.t]) inline(n.c, append(parent, el(TAGS[n.t])));
        else if (n.t === 'link') {
          const a = append(parent, el('a', undefined, 'ext-link'));
          a.setAttribute('title', handlers.linkTitle ? handlers.linkTitle(n.href) : n.href);
          a.setAttribute('data-href', n.href);
          activate(a, () => handlers.onLink && handlers.onLink(n.href));
          inline(n.c, a);
        } else if (n.t === 'ref') {
          const a = append(parent, el('a', undefined, 'code-ref' + (n.ref.self ? ' self' : '')));
          a.setAttribute('title', handlers.refTitle ? handlers.refTitle(n.ref) : label(n.ref));
          // VS Code merges this into the webview context-menu arguments (webview/context menus).
          a.setAttribute('data-vscode-context', JSON.stringify({
            ...(handlers.context || {}),
            webviewSection: 'codeRef',
            refPath: n.ref.path,
            refLine: n.ref.line,
            refColumn: n.ref.column,
            refEndLine: n.ref.endLine,
            refSelf: !!n.ref.self,
          }));
          activate(a, () => handlers.onRef(n.ref, false));
          a.addEventListener('auxclick', (/** @type {any} */ e) => {
            if (e && e.button === 1) handlers.onRef(n.ref, true);
          });
          inline(n.c, a);
        }
      }
    }
    /** @param {any} parent @param {any} child */
    function append(parent, child) {
      parent.append(child);
      return child;
    }
    /** @param {any[]} blockNodes @param {any} parent */
    function blocks(blockNodes, parent) {
      for (const b of blockNodes || []) {
        if (b.t === 'p') inline(b.c, append(parent, el('p')));
        else if (b.t === 'h') inline(b.c, append(parent, el('h' + Math.min(6, Math.max(1, Number(b.level) || 1)))));
        else if (b.t === 'pre') {
          const pre = append(parent, el('pre', undefined, 'code-block'));
          const code = append(pre, el('code', b.v));
          if (b.lang) code.setAttribute('data-lang', String(b.lang).slice(0, 30));
        } else if (b.t === 'ul' || b.t === 'ol') {
          const list = append(parent, el(b.t));
          if (b.t === 'ol' && b.start !== 1) list.setAttribute('start', String(b.start));
          for (const item of b.items) blocks(item, append(list, el('li')));
        } else if (b.t === 'quote') blocks(b.c, append(parent, el('blockquote')));
        else if (b.t === 'hr') append(parent, el('hr'));
        else if (b.t === 'table') {
          const wrap = append(parent, el('div', undefined, 'table-wrap'));
          const table = append(wrap, el('table'));
          const head = append(append(table, el('thead')), el('tr'));
          b.head.forEach((/** @type {any[]} */ cell, /** @type {number} */ k) => {
            const th = append(head, el('th'));
            if (b.align[k]) th.className = 'align-' + b.align[k];
            inline(cell, th);
          });
          const body = append(table, el('tbody'));
          for (const row of b.rows) {
            const tr = append(body, el('tr'));
            row.forEach((/** @type {any[]} */ cell, /** @type {number} */ k) => {
              const td = append(tr, el('td'));
              if (b.align[k]) td.className = 'align-' + b.align[k];
              inline(cell, td);
            });
          }
        }
      }
    }
    return {
      /** @param {any[]} ast */
      render(ast) {
        const box = el('div', undefined, 'md');
        blocks(ast, box);
        return box;
      },
      inline,
    };
  }

  const api = { create, label };
  // @ts-ignore
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // @ts-ignore
  else root.VAWMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
