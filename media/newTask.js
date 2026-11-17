// @ts-check
// New Agent Task form. textContent only; strings from the static i18n table.
(function () {
  // @ts-ignore injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  /** @param {any} m */
  const send = (m) => vscode.postMessage(m);
  /** @type {Record<string,string>} */
  let STR = {};
  /** @param {string} k */
  const S = (k) => STR[k] || k;

  /** @type {any} */
  const state = { providers: [], workspaces: [], last: { byProvider: {} }, models: {}, loading: {}, errors: {}, provider: undefined, model: undefined, effort: undefined, profile: undefined, workspace: undefined, instructions: '', error: '', starting: false, reviewerModel: undefined };

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

  function selectProvider(/** @type {string} */ id) {
    state.provider = id;
    const p = state.providers.find((/** @type {any} */ x) => x.id === id);
    const last = state.last.byProvider[id] || {};
    state.profile = last.profile && p.profiles.some((/** @type {any} */ x) => x.id === last.profile) ? last.profile : p.profiles[0].id;
    state.model = undefined;
    state.effort = undefined;
    if (p.available && !state.models[id]) loadModels(false);
    else pickDefaults();
    render();
  }

  function loadModels(/** @type {boolean} */ refresh) {
    if (!state.workspace) return;
    state.loading[state.provider] = true;
    state.errors[state.provider] = '';
    send({ type: 'models', provider: state.provider, workspace: state.workspace, refresh });
  }

  function pickDefaults() {
    const list = state.models[state.provider] || [];
    const last = state.last.byProvider[state.provider] || {};
    const ok = list.filter((/** @type {any} */ m) => m.compatible);
    const m = ok.find((/** @type {any} */ x) => x.id === last.model) || ok.find((/** @type {any} */ x) => x.isDefault) || ok[0];
    state.model = m ? m.id : undefined;
    const efforts = (m && m.efforts) || [];
    state.effort = efforts.includes(last.effort) ? last.effort : efforts.includes(m && m.defaultEffort) ? m.defaultEffort : efforts[0];
  }

  function render() {
    app.replaceChildren();
    app.appendChild(el('h2', { text: S('nt.title') }));

    // Provider
    const provs = el('div', { class: 'providers' });
    for (const p of state.providers) {
      const card = el(
        'button',
        {
          class: `card ${state.provider === p.id ? 'selected' : ''} ${p.available ? '' : 'unavailable'}`,
          attrs: { 'aria-pressed': String(state.provider === p.id) },
          on: { click: () => selectProvider(p.id) },
        },
        [
          el('div', { class: 'card-title' }, [
            el('span', { text: p.displayName }),
            p.experimental && el('span', { class: 'pill sim', text: S('nt.experimental') }),
            el('span', { class: `pill ${p.available ? 'ok' : 'bad'}`, text: p.available ? S('nt.available') : S('nt.unavailable') }),
          ]),
          p.auth && el('div', { class: 'small muted', text: `${S('nt.auth')}: ${p.auth}` }),
          !p.available && p.reason && el('div', { class: 'small error', text: p.reason }),
        ],
      );
      provs.appendChild(card);
    }
    app.appendChild(el('section', {}, [el('h3', { text: S('nt.provider') }), provs]));

    const p = state.providers.find((/** @type {any} */ x) => x.id === state.provider);
    if (!p) return;

    // Workspace
    const ws = /** @type {HTMLSelectElement} */ (el('select', { attrs: { 'aria-label': S('nt.workspace') } }));
    for (const w of state.workspaces) {
      const o = /** @type {HTMLOptionElement} */ (el('option', { text: `${w.name} — ${w.path}`, attrs: { value: w.path } }));
      if (w.path === state.workspace) o.selected = true;
      ws.appendChild(o);
    }
    ws.addEventListener('change', () => {
      state.workspace = ws.value;
      send({ type: 'selectWorkspace', workspace: ws.value });
      state.models = {};
      loadModels(false);
      render();
    });

    // Model
    const list = state.models[p.id] || [];
    const modelSel = /** @type {HTMLSelectElement} */ (el('select', { attrs: { 'aria-label': S('nt.model') } }));
    for (const m of list) {
      const o = /** @type {HTMLOptionElement} */ (el('option', { text: `${m.label}${m.detail ? ' · ' + m.detail : ''}${m.compatible ? '' : ` — ${S('nt.incompatible')}: ${m.reason}`}`, attrs: { value: m.id } }));
      if (!m.compatible) o.disabled = true;
      if (m.id === state.model) o.selected = true;
      modelSel.appendChild(o);
    }
    if (!list.length) modelSel.setAttribute('disabled', '');
    modelSel.addEventListener('change', () => {
      state.model = modelSel.value;
      const m = list.find((/** @type {any} */ x) => x.id === state.model);
      const efforts = (m && m.efforts) || [];
      state.effort = efforts.includes(state.effort) ? state.effort : efforts.includes(m && m.defaultEffort) ? m.defaultEffort : efforts[0];
      render();
    });
    const model = list.find((/** @type {any} */ x) => x.id === state.model);
    const efforts = (model && model.efforts) || [];
    const effortSel = /** @type {HTMLSelectElement} */ (el('select', { attrs: { 'aria-label': S('nt.effort') } }));
    for (const e of efforts) {
      const o = /** @type {HTMLOptionElement} */ (el('option', { text: STR['nt.effort.' + e] || e, attrs: { value: e } }));
      if (e === state.effort) o.selected = true;
      effortSel.appendChild(o);
    }
    effortSel.addEventListener('change', () => (state.effort = effortSel.value));

    const profiles = el('div', { class: 'profiles' });
    for (const pr of p.profiles) {
      const id = 'prof-' + pr.id;
      const input = /** @type {HTMLInputElement} */ (el('input', { attrs: { type: 'radio', name: 'profile', id, value: pr.id } }));
      input.checked = state.profile === pr.id;
      input.addEventListener('change', () => (state.profile = pr.id));
      profiles.appendChild(
        el('label', { class: 'profile', attrs: { for: id } }, [
          input,
          el('span', {}, [el('strong', { text: ' ' + pr.label }), pr.writes && el('span', { class: 'pill sim', text: S('nt.writes') }), el('div', { class: 'small muted', text: pr.detail })]),
        ]),
      );
    }

    const ta = /** @type {HTMLTextAreaElement} */ (el('textarea', { attrs: { rows: '6', placeholder: S('nt.instructionsHint'), 'aria-label': S('nt.instructions') } }));
    ta.value = state.instructions;
    ta.addEventListener('input', () => (state.instructions = ta.value));

    const canStart = p.available && !!state.model && !!state.workspace && !state.starting && !state.loading[p.id] && list.some((m) => m.id === state.model && m.compatible);
    app.appendChild(
      el('section', { class: 'form' }, [
        el('label', { text: S('nt.workspace') }),
        el('div', { class: 'model-row' }, [ws, el('button', { class: 'btn', text: S('nt.browseWorkspace'), on: { click: () => send({ type: 'browseWorkspace', provider: state.provider, selection: { model: state.model, effort: state.effort, profile: state.profile, instructions: state.instructions } }) } })]),
        el('div', { class: 'small muted', text: S('nt.workspaceHint') }),
        el('label', { text: S('nt.model') }),
        el('div', { class: 'model-row' }, [
          modelSel,
          el('button', { class: 'btn', text: '↻', title: S('nt.refreshModels'), on: { click: () => loadModels(true) } }),
        ]),
        state.loading[p.id] && el('div', { class: 'small muted', text: S('nt.loadingModels') }),
        state.errors[p.id] && el('div', { class: 'small error', text: state.errors[p.id] }),
        !p.available && el('div', { class: 'small error', text: S('nt.providerUnavailable') }),
        efforts.length > 0 && el('label', { text: S('nt.effort') }),
        efforts.length > 0 && effortSel,
        el('label', { text: S('nt.profile') }),
        profiles,
        el('label', { text: S('nt.instructions') }),
        ta,
        el('div', { class: 'small muted', text: `${S('nt.reviewerIndependent')}${state.reviewerModel ? ` (${state.reviewerModel})` : ''}` }),
        state.error && el('div', { class: 'error', text: state.error }),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn primary',
            text: state.starting ? S('nt.starting') : S('nt.start'),
            attrs: canStart ? {} : { disabled: '' },
            on: {
              click: () => {
                state.starting = true;
                state.error = '';
                render();
                send({ type: 'start', provider: state.provider, selection: { model: state.model, effort: efforts.length ? state.effort : undefined, profile: state.profile, workspaceRoot: state.workspace, instructions: state.instructions } });
              },
            },
          }),
          el('button', { class: 'btn', text: S('nt.refreshProviders'), on: { click: () => send({ type: 'refreshProviders' }) } }),
        ]),
      ]),
    );
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'init') {
      STR = m.strings || {};
      state.providers = m.providers;
      state.workspaces = m.workspaces;
      state.last = m.last || { byProvider: {} };
      if (m.seed) {
        state.instructions = m.seed.instructions || '';
        state.workspace = m.seed.workspaceRoot;
        if (m.seed.provider) state.last.byProvider[m.seed.provider] = { ...state.last.byProvider[m.seed.provider], ...m.seed };
      }
      state.reviewerModel = m.reviewerModel;
      state.workspace = state.workspace && m.workspaces.some((w) => w.path === state.workspace) ? state.workspace : m.defaultWorkspace || (m.workspaces[0] && m.workspaces[0].path);
      const prefer = m.prefer || state.provider || state.last.provider;
      const first = state.providers.find((/** @type {any} */ p) => p.id === prefer) || state.providers.find((/** @type {any} */ p) => p.available) || state.providers[0];
      state.models = {};
      if (first) selectProvider(first.id);
      else render();
    } else if (m.type === 'workspacesUpdated') {
      state.workspaces = m.workspaces;
      const next = m.defaultWorkspace || (m.workspaces.some((w) => w.path === state.workspace) ? state.workspace : undefined);
      if (next !== state.workspace) {
        state.workspace = next;
        state.models = {};
        state.model = undefined;
        if (state.provider) loadModels(false);
      }
      render();
    } else if (m.type === 'workspaceSelected') {
      if (!state.workspaces.some((w) => w.path === m.workspace.path)) state.workspaces.push(m.workspace);
      state.workspace = m.workspace.path;
      state.models = {};
      if (state.provider) loadModels(false);
      render();
    } else if (m.type === 'preferProvider') {
      selectProvider(m.provider);
    } else if (m.type === 'models') {
      if (m.workspace !== state.workspace) return; // A reply from the previous project must not overwrite this one.
      state.loading[m.provider] = false;
      state.errors[m.provider] = m.error || '';
      state.models[m.provider] = m.models || [];
      if (m.provider === state.provider) pickDefaults();
      render();
    } else if (m.type === 'error') {
      state.starting = false;
      state.error = m.message || '';
      render();
    }
  });
  send({ type: 'ready' });
})();
