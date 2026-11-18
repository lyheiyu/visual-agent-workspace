// @ts-check
// "Explain Code in Detail" panel. Renders state from the extension host and
// posts intents. DOM + textContent only; Markdown via markdownView.js.
(function () {
  // @ts-ignore supplied by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {any} */ (document.getElementById('app'));
  /** @param {any} m */
  const send = (m) => vscode.postMessage(m);
  /** @type {any} */
  let model;
  /** Collapsed sections survive re-renders (keyed by part/section index). */
  /** @type {Record<string, boolean>} */
  const collapsed = (vscode.getState() || {}).collapsed || {};
  /** @param {string} key @param {Record<string, string|number>} [vars] */
  const S = (key, vars) => {
    const tpl = (model && model.strings[key]) || key;
    return vars ? tpl.replace(/\{(\w+)\}/g, (/** @type {string} */ m, /** @type {string} */ k) => (k in vars ? String(vars[k]) : m)) : tpl;
  };
  /** @param {string} tag @param {string} [text] @param {string} [cls] */
  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  /** @param {string} label @param {() => void} fn @param {boolean} [disabled] @param {string} [cls] */
  function button(label, fn, disabled = false, cls = '') {
    const b = el('button', label, cls);
    // @ts-ignore
    b.disabled = disabled;
    b.addEventListener('click', fn);
    return b;
  }
  /** @param {[string,string][]} options @param {string} current @param {(v: string) => void} onChange @param {string} label */
  function select(options, current, onChange, label) {
    const s = /** @type {any} */ (el('select'));
    for (const [v, l] of options) {
      const o = /** @type {any} */ (el('option', l));
      o.value = v;
      if (v === current) o.selected = true;
      s.append(o);
    }
    s.setAttribute('aria-label', label);
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  /** @param {number} a @param {number} [b] */
  const span = (a, b) => (b && b !== a ? S('x.lines', { a, b }) : S('x.line', { a }));

  const MD = /** @type {any} */ (window).VAWMarkdown;
  /** @type {any} */
  let md;
  function renderer() {
    const id = model.record && model.record.id;
    return MD.create(document, {
      onRef: (/** @type {any} */ ref, /** @type {boolean} */ side) => send({ type: 'openReference', id, side, ref: { path: ref.path, line: ref.line, column: ref.column, endLine: ref.endLine, self: !!ref.self } }),
      onLink: (/** @type {string} */ href) => send({ type: 'openLink', href }),
      refTitle: (/** @type {any} */ ref) => (ref.self ? S('x.gotoLines') : `${S('ref.open')}: ${MD.label(ref)}`),
      linkTitle: (/** @type {string} */ href) => `${S('ref.external')}: ${href}`,
    });
  }

  /** @param {any} part @param {string} heading */
  function renderPart(part, heading) {
    const r = model.record;
    const box = el('section', undefined, 'part');
    const head = el('div', undefined, 'part-head');
    const h = el('h3');
    const range = el('a', heading, 'range');
    range.setAttribute('role', 'link');
    range.setAttribute('tabindex', '0');
    range.title = S('x.gotoLines');
    range.addEventListener('click', () => send({ type: 'gotoRange', id: r.id, startLine: part.startLine, endLine: part.endLine }));
    h.append(range);
    head.append(h);
    const status = part.status === 'streaming' ? S('r.streaming') : part.status === 'done' ? (part.cached ? S('r.doneCached') : part.durationMs !== undefined ? S('r.done', { s: (part.durationMs / 1000).toFixed(1) }) : '') : S('x.status.' + part.status);
    if (status) head.append(el('small', status, 'muted'));
    box.append(head);
    if (part.context && part.context.length) box.append(el('div', `${S('x.context')}: ${part.context.join(' › ')}`, 'small muted mono'));
    if (part.error) box.append(el('div', part.error, 'error'));
    if (part.status === 'streaming' && !part.sections.length) box.append(el('p', S('r.waiting'), 'muted'));
    part.sections.forEach((/** @type {any} */ s, /** @type {number} */ k) => {
      const key = `${r.id}:${part.index}:${k}`;
      const d = /** @type {any} */ (el('details', undefined, 'section'));
      d.open = !collapsed[key];
      d.addEventListener('toggle', () => {
        collapsed[key] = !d.open;
        vscode.setState({ collapsed });
      });
      const sum = el('summary');
      if (s.title) sum.append(el('span', s.title, 'section-title'));
      else sum.append(el('span', S('x.intro'), 'section-title muted'));
      if (s.startLine) {
        if (s.rangeValid) {
          const go = el('a', '↗ ' + span(s.startLine, s.endLine), 'range');
          go.setAttribute('role', 'link');
          go.setAttribute('tabindex', '0');
          go.title = S('x.gotoLines');
          const open = (/** @type {any} */ e) => {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            send({ type: 'gotoRange', id: r.id, startLine: s.startLine, endLine: s.endLine });
          };
          go.addEventListener('click', open);
          go.addEventListener('keydown', (/** @type {any} */ e) => e && e.key === 'Enter' && open(e));
          sum.append(go);
        } else {
          sum.append(el('span', '⚠ ' + S('x.rangeOutside', { range: span(s.startLine, s.endLine) }), 'warn small'));
        }
      }
      d.append(sum, md.render(s.ast));
      box.append(d);
    });
    if (part.gaps && part.gaps.length) box.append(el('div', S('x.gaps', { ranges: part.gaps.join(', ') }), 'warn small'));
    return box;
  }

  function render() {
    if (!model || !app) return;
    md = renderer();
    const r = model.record;
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    app.replaceChildren();
    const header = el('header', undefined, 'x-header');
    header.append(el('h2', S('x.title')));
    if (r) {
      header.append(el('div', r.file.relPath, 'file mono'));
      header.append(el('div', `${S('x.scope')}: ${S('x.scope.' + r.scope)} · ${r.scopeLabel}`, 'small'));
      header.append(el('div', `${S('x.model')}: ${r.model || '—'} · ${S('x.analyzed')}: ${r.plan.analyzed.join(', ')} / ${r.file.lineCount} · v${r.file.version} · sha256 ${r.file.hash}`, 'small muted'));
    } else {
      header.append(el('p', S('x.empty'), 'muted'));
    }
    const controls = el('div', undefined, 'x-controls');
    const busy = model.busy;
    controls.append(
      select(model.models.map((/** @type {string} */ m) => [m, m]), model.selectedModel || '', (v) => send({ type: 'selectModel', name: v }), S('r.model')),
      button('↻', () => send({ type: 'refreshModels' }), busy, 'icon'),
      select([['structured', S('x.mode.structured')], ['lineByLine', S('x.mode.lineByLine')]], model.mode, (v) => send({ type: 'setMode', mode: v }), S('x.mode')),
    );
    if (r) {
      controls.append(button(model.needsRun ? S('x.run') : S('x.rerun'), () => send({ type: 'run', mode: model.mode }), busy || !model.selectedModel, 'primary'));
      if (model.running) controls.append(button(S('r.cancel'), () => send({ type: 'cancel' }), false, 'danger'));
      controls.append(button(S('r.copy'), () => send({ type: 'copy', id: r.id }), r.status === 'running'), button(S('r.exportMd'), () => send({ type: 'export', id: r.id }), r.status === 'running'));
      // Secondary: a function's role within the project (explicit click; opens a picker).
      if (r.scope === 'file') controls.append(button(S('x.explainFunction'), () => send({ type: 'explainFunction', id: r.id }), busy, 'secondary'));
    }
    header.append(controls);
    if (model.connection === 'unavailable' && model.error) header.append(el('div', model.error, 'error small'));
    app.append(header);
    if (!r) return;

    const notes = el('div', undefined, 'notes');
    notes.append(el('div', S('r.unverified') + ' ' + S('x.labels'), 'warn small'));
    if (r.plan.partial) notes.append(el('div', S('x.partial', { analyzed: r.plan.analyzed.join(', '), omitted: r.plan.omitted.join(', ') }), 'warn'));
    if (r.stale) notes.append(el('div', S('x.stale'), 'error'));
    if (r.file.dirty) notes.append(el('div', S('x.dirty'), 'muted small'));
    if (model.needsRun) notes.append(el('div', S('x.needsRun'), 'muted'));
    if (r.status === 'cancelled') notes.append(el('div', S('x.status.cancelled'), 'muted'));
    if (r.error) notes.append(el('div', r.error, 'error'));
    if (r.plan.parts > 1) {
      const done = r.parts.filter((/** @type {any} */ p) => p.status === 'done').length;
      notes.append(el('div', S('x.progress', { done, n: r.plan.parts }), 'small muted'));
    }
    app.append(notes);
    if (r.synthesis) app.append(renderPart(r.synthesis, S('x.overall')));
    for (const p of r.parts) app.append(renderPart(p, r.parts.length > 1 ? `${S('x.part', { i: p.index + 1, n: r.parts.length })} · ${span(p.startLine, p.endLine)}` : span(p.startLine, p.endLine)));
    if (model.history.length > 1) {
      const h = el('details', undefined, 'history');
      h.append(el('summary', S('x.history')));
      for (const item of model.history) {
        const b = button(item.label, () => send({ type: 'show', id: item.id }), item.id === r.id, 'link');
        h.append(b);
      }
      app.append(h);
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  }

  window.addEventListener('message', (/** @type {any} */ e) => {
    if (e.data && e.data.type === 'state') {
      model = e.data.model;
      render();
    }
  });
  send({ type: 'ready' });
})();
