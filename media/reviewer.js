// @ts-check
// Local AI Reviewer webview. Renders state; sends intents. textContent only.
// UI strings come from the extension's static string table (no LLM).
(function () {
  // @ts-ignore injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  /** @param {any} msg */
  const send = (msg) => vscode.postMessage(msg);

  /** @type {Record<string,string>} */
  let STR = {};
  /** @param {string} key @param {Record<string, string|number>} [vars] */
  const S = (key, vars) => {
    const tpl = STR[key] || key;
    return vars ? tpl.replace(/\{(\w+)\}/g, (/** @type {string} */ m, /** @type {string} */ k) => (k in vars ? String(vars[k]) : m)) : tpl;
  };

  /**
   * @param {string} tag
   * @param {{class?: string, text?: string, title?: string, attrs?: Record<string,string>, on?: Record<string,(e:Event)=>void>}} [o]
   * @param {(Node|null|undefined|false|"")[]} [children]
   */
  function el(tag, o = {}, children = []) {
    const n = document.createElement(tag);
    if (o.class) n.className = o.class;
    if (o.text !== undefined) n.textContent = o.text;
    if (o.title) n.title = o.title;
    for (const [k, v] of Object.entries(o.attrs || {})) n.setAttribute(k, v);
    for (const [k, f] of Object.entries(o.on || {})) n.addEventListener(k, f);
    for (const c of children) if (c) n.appendChild(c);
    return n;
  }
  /** @param {string} label @param {() => void} fn @param {{kind?: string, disabled?: boolean, title?: string, key?: string}} [o] */
  function button(label, fn, o = {}) {
    const b = el('button', { class: `btn ${o.kind || ''}`, text: label, title: o.title || label, on: { click: fn }, attrs: { 'data-key': 'btn:' + (o.key || label) } });
    if (o.disabled) b.setAttribute('disabled', '');
    return b;
  }
  /** @param {string} key @param {string} current @param {[string,string][]} options @param {(v: string) => void} onChange */
  function select(key, current, options, onChange) {
    const sel = /** @type {HTMLSelectElement} */ (el('select', { attrs: { 'data-key': key } }));
    for (const [value, label] of options) {
      const o = /** @type {HTMLOptionElement} */ (el('option', { text: label, attrs: { value } }));
      if (value === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  /** @param {any} m */
  function render(m) {
    STR = m.strings || {};
    const active = document.activeElement;
    const focusKey = active && active.getAttribute ? active.getAttribute('data-key') : null;
    const out = document.querySelector('.output');
    const atBottom = out ? out.scrollTop + out.clientHeight >= out.scrollHeight - 20 : true;
    app.replaceChildren();

    const langSel = select('lang', m.language, [['zh-CN', S('lang.zh-CN')], ['en', S('lang.en')], ['bilingual', S('lang.bilingual')]], (v) => send({ type: 'setLanguage', value: v }));
    langSel.classList.add('lang');
    langSel.setAttribute('aria-label', S('lang.label'));

    if (!m.enabled) {
      app.appendChild(
        el('section', { class: 'notice' }, [
          el('div', { class: 'header-row' }, [el('span', { class: 'spacer' }), langSel]),
          el('p', { text: S('r.disabled') }),
          button(S('r.openSettings'), () => send({ type: 'settings' }), { key: 'settings' }),
        ]),
      );
      return;
    }

    /** @type {Record<string, [string, string]>} */
    const connMap = {
      connected: ['ok', S('r.connected', { n: m.models.length })],
      checking: ['busy', S('r.checking')],
      unavailable: ['bad', S('r.unavailable')],
      unknown: ['idle', S('r.unknown')],
      disabled: ['idle', S('r.disabled')],
    };
    const conn = connMap[m.connection] || ['idle', m.connection];

    const modelSel = select('model', m.selectedModel, m.models.map((/** @type {any} */ x) => [x.name, x.detail ? `${x.name} (${x.detail})` : x.name]), (v) => send({ type: 'selectModel', name: v }));
    modelSel.setAttribute('aria-label', S('r.model'));
    if (!m.models.length) modelSel.setAttribute('disabled', '');

    app.appendChild(
      el('section', { class: 'header' }, [
        el('div', { class: 'header-row' }, [
          el('span', { class: `conn conn-${conn[0]}`, text: conn[1] }),
          el('span', { class: 'pill local', text: S('r.local'), title: S('r.localTip', { endpoint: m.endpoint }) }),
          el('span', { class: 'spacer' }),
          langSel,
        ]),
        el('div', { class: 'muted small', text: m.endpoint }),
        m.errorKey && el('div', { class: 'error small', text: S(m.errorKey) }),
        m.error && el('div', { class: 'error small mono', text: m.error }),
        el('div', { class: 'model-row' }, [modelSel, button('↻', () => send({ type: 'refresh' }), { title: S('r.refreshTip'), key: 'refresh' })]),
      ]),
    );

    const busy = m.busy;
    const ready = m.connection === 'connected' && !!m.selectedModel && !busy;
    app.appendChild(
      el('section', { class: 'actions' }, [
        el('div', { class: 'muted small', text: S('r.onlyOnClick') }),
        el('div', { class: 'small', text: `${S('r.responseLanguage')}: ${S('lang.' + m.language)}` }),
        m.selection && el('div', { class: 'small', text: `${S('r.selected')}: ${m.selection}` }),
        el('div', { class: 'btn-row' }, [
          button(S('r.explain'), () => send({ type: 'run', kind: 'explain' }), { disabled: !ready, title: S('r.explainTip'), key: 'explain' }),
          button(S('r.review'), () => send({ type: 'run', kind: 'review' }), { disabled: !ready, title: S('r.reviewTip'), key: 'review' }),
          button(S('r.impact'), () => send({ type: 'run', kind: 'impact' }), { disabled: !ready, title: S('r.impactTip'), key: 'impact' }),
          button(S('r.error'), () => send({ type: 'run', kind: 'error' }), { disabled: !ready, title: S('r.errorTip'), key: 'error' }),
          button(S('r.detail'), () => send({ type: 'run', kind: 'detail' }), { disabled: !ready, title: S('r.detailTip'), key: 'detail' }),
        ]),
        busy && button(S('r.cancel'), () => send({ type: 'cancel' }), { kind: 'danger', title: S('r.cancelTip'), key: 'cancel' }),
      ]),
    );

    const c = m.current;
    if (c) {
      const statusText =
        c.status === 'streaming'
          ? S('r.streaming')
          : c.status === 'done'
            ? c.cached
              ? S('r.doneCached')
              : S('r.done', { s: ((c.durationMs || 0) / 1000).toFixed(1) })
            : c.status === 'cancelled'
              ? S('r.cancelled')
              : S('r.errorStatus');
      const tr = c.view === 'zh-CN' || c.view === 'en' ? c.translations[c.view] : undefined;
      const other = c.translations[c.language === 'zh-CN' ? 'en' : 'zh-CN'];
      /** @type {[string,string][]} */
      const versions = [['original', `${S('r.viewOriginal')} (${S('lang.' + c.language)})`]];
      for (const [k, v] of Object.entries(c.translations)) {
        if (/** @type {any} */ (v).status === 'done') versions.push([k, S('lang.' + k)]);
      }
      if (other && other.status === 'done') versions.push(['bilingual', S('lang.bilingual')]);
      const canTranslate = c.status === 'done' && c.language !== 'bilingual' && !busy && ready;
      const targets = /** @type {[string,string][]} */ ([['zh-CN', '中文'], ['en', 'English']]).filter(([v]) => v !== c.language);
      let target = targets[0] ? targets[0][0] : 'zh-CN';
      const targetSel = select('target', target, targets, (v) => (target = v));
      targetSel.setAttribute('aria-label', S('r.translateTo'));

      const body =
        c.view === 'bilingual' && other
          ? [el('pre', { class: 'output', text: c.text }), el('pre', { class: 'output', text: other.text })]
          : tr
            ? [el('pre', { class: 'output', text: tr.text || S('r.translating') }), el('details', {}, [el('summary', { text: S('r.viewOriginal') }), el('pre', { text: c.text })])]
            : [el('pre', { class: 'output', text: c.text || (c.status === 'streaming' ? S('r.waiting') : '') })];

      app.appendChild(
        el('section', { class: 'result' }, [
          el('h3', { text: c.title }),
          el('div', { class: 'small muted', text: `${c.model} · ${statusText}${c.truncated ? ' · ' + S('r.truncated') : ''}${tr && tr.status === 'streaming' ? ' · ' + S('r.translating') : ''}` }),
          el('div', { class: 'warn small', text: S('r.unverified') }),
          c.error && el('div', { class: 'error small', text: c.error }),
          tr && tr.codeSpansPreserved === false && el('div', { class: 'warn small', text: S('r.codeChanged') }),
          c.thinking && el('details', {}, [el('summary', { text: S('r.reasoning') }), el('pre', { class: 'thinking', text: c.thinking })]),
          versions.length > 1 &&
            el('div', { class: 'model-row' }, [
              el('span', { class: 'small', text: S('r.view') + ':' }),
              select('view', c.view, versions, (v) => send({ type: 'showVersion', id: c.id, view: v })),
            ]),
          ...body,
          el('div', { class: 'btn-row' }, [
            button(S('r.openBeside'), () => send({ type: 'open', id: c.id }), { key: 'open' }),
            button(S('r.copy'), () => send({ type: 'copy', id: c.id }), { disabled: c.status === 'streaming', key: 'copy' }),
            button(S('r.exportMd'), () => send({ type: 'export', id: c.id }), { disabled: c.status === 'streaming', key: 'export' }),
          ]),
          c.status === 'done' &&
            c.language !== 'bilingual' &&
            el('div', { class: 'model-row' }, [
              targetSel,
              button(S('r.translate'), () => send({ type: 'translate', id: c.id, target }), { disabled: !canTranslate, title: S('r.translateTip'), key: 'translate' }),
            ]),
        ]),
      );
    }

    if (m.history.length > 1) {
      app.appendChild(
        el('section', {}, [
          el('h3', { text: S('r.recent') }),
          ...m.history.slice(1).map((/** @type {any} */ h) =>
            el('button', { class: 'link', text: `${h.title} · ${h.model} · ${h.status}`, on: { click: () => send({ type: 'open', id: h.id }) } }),
          ),
        ]),
      );
    }

    const newOut = document.querySelector('.output');
    if (newOut && atBottom) newOut.scrollTop = newOut.scrollHeight;
    if (focusKey) {
      const t = app.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (t instanceof HTMLElement && !t.hasAttribute('disabled')) t.focus({ preventScroll: true });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data.model);
  });
  send({ type: 'ready' });
})();
