// @ts-check
// Agent Activity webview. Pure renderer: receives a view model from the
// extension and sends back user intents. Uses DOM APIs + textContent only.
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @param {any} msg */
  const send = (msg) => vscode.postMessage(msg);

  /**
   * @param {string} tag
   * @param {{class?: string, text?: string, title?: string, attrs?: Record<string,string>, on?: Record<string,(e:Event)=>void>}} [opts]
   * @param {(Node|null|undefined|false)[]} [children]
   */
  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.title) node.title = opts.title;
    for (const [k, v] of Object.entries(opts.attrs || {})) node.setAttribute(k, v);
    for (const [k, fn] of Object.entries(opts.on || {})) node.addEventListener(k, fn);
    for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  /** @param {string} label @param {() => void} onClick @param {{kind?: string, disabled?: boolean, title?: string}} [o] */
  function button(label, onClick, o = {}) {
    const b = el('button', { class: `btn ${o.kind || ''}`, text: label, title: o.title || label, on: { click: onClick }, attrs: { 'data-key': 'btn:' + label } });
    if (o.disabled) b.setAttribute('disabled', '');
    return b;
  }

  /** @param {string} status */
  const badge = (status, extra = '') => el('span', { class: `badge status-${status.toLowerCase()} ${extra}`, text: S('status.' + status) });

  /** @param {string} action @param {string} [operationId] */
  const act = (action, operationId) => send({ type: 'action', action, operationId });

  let lastSelected = /** @type {string|undefined} */ (undefined);
  /** Per-panel UI state: expanded step, open "…" menu, turn groups the user toggled. */
  const ui = Object.assign({ expanded: undefined, dismissed: undefined, menu: undefined, turns: {}, open: {} }, ((vscode.getState && vscode.getState()) || {}).ui || {});
  const saveUi = () => {
    try {
      vscode.setState({ ...((vscode.getState && vscode.getState()) || {}), ui: { expanded: ui.expanded, dismissed: ui.dismissed, turns: ui.turns, open: ui.open } });
    } catch {
      /* state is a convenience only */
    }
  };
  /** Dismiss only action menus; leave expanded steps and turn groups intact. */
  function closeMenus(except = null, restoreFocus = false) {
    for (const menu of document.querySelectorAll('details.more[open]')) {
      if (menu === except) continue;
      menu.removeAttribute('open');
      if (restoreFocus) menu.querySelector('summary')?.focus();
    }
    if (!except) ui.menu = undefined;
  }
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    closeMenus(target instanceof Element ? target.closest('details.more') : null);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('details.more[open]')) {
      event.preventDefault();
      closeMenus(null, true);
    }
  });
  window.addEventListener('blur', () => closeMenus());
  /** <details> the user toggled keep their state across re-renders; others use their default. @param {HTMLDetailsElement} d @param {string} key @param {boolean} dflt */
  function remember(d, key, dflt) {
    d.open = key in ui.open ? ui.open[key] : dflt;
    d.addEventListener('toggle', () => {
      if (!d.isConnected) return;
      ui.open[key] = d.open;
      saveUi();
    });
    return d;
  }
  /** Decisions clicked but not yet reflected in the state: their buttons stay disabled (no double decisions). */
  const inflight = /** @type {Record<string, number>} */ ({});
  /** When each pending approval was first shown: a card that just appeared ignores clicks briefly (no double click into the next proposal). */
  const shownAt = /** @type {Record<string, number>} */ ({});
  const ARM_MS = 700;
  /** @param {string} id */
  // Also right after any decision here: the next card can move under the mouse (layout shift) and must not take the second click.
  let lastDecisionAt = 0;
  const armed = (id) => Date.now() - (shownAt[id] || 0) >= ARM_MS && Date.now() - lastDecisionAt >= ARM_MS;
  /** @param {string} action @param {string} id */
  const decide = (action, id) => {
    if (!armed(id)) return;
    if (inflight[id] && Date.now() - inflight[id] < 4000) return;
    inflight[id] = Date.now();
    lastDecisionAt = Date.now();
    setTimeout(() => lastModel && render(lastModel), ARM_MS + 20);
    setTimeout(() => lastModel && render(lastModel), 4020); // if the decision did not go through (e.g. a dialog was cancelled), enable the buttons again
    act(action, id);
    if (lastModel) render(lastModel);
  };
  /** @type {any} */
  let lastModel;
  let lastFocus = /** @type {string|undefined} */ (undefined);
  let conversationOpen = false;
  /** @type {Record<string,string>} */
  let STR = {};
  /** Static UI string (no LLM). Unknown keys fall back to the key. @param {string} key @param {Record<string, string|number>} [vars] */
  const S = (key, vars) => {
    const tpl = STR[key] || key;
    return vars ? tpl.replace(/\{(\w+)\}/g, (/** @type {string} */ m, /** @type {string} */ k) => (k in vars ? String(vars[k]) : m)) : tpl;
  };
  /** Language selector shared by both panels. @param {string} current */
  function languageSelect(current) {
    const sel = /** @type {HTMLSelectElement} */ (el('select', { class: 'lang', attrs: { 'aria-label': S('lang.label'), 'data-key': 'lang' } }));
    for (const v of ['zh-CN', 'en', 'bilingual']) {
      const o = /** @type {HTMLOptionElement} */ (el('option', { text: S('lang.' + v), attrs: { value: v } }));
      if (v === current) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => send({ type: 'setLanguage', value: sel.value }));
    return sel;
  }

  /** "Writes files" label with the static reasons as tooltip. @param {any} c */
  function writesPill(c) {
    return c && c.writes ? el('span', { class: 'pill writes', text: S('c.writes'), title: S('c.heuristicTip') + ': ' + c.writeReasons.join('; ') + (c.writeTargets.length ? ' → ' + c.writeTargets.join(', ') : '') }) : null;
  }
  /** Full original command; long commands and embedded code start collapsed. @param {string} command @param {any} c @param {boolean} [open] */
  function fullCommand(command, c, open, key) {
    const d = el('details', { class: 'full-command' }, [
      el('summary', { text: c && (c.long || c.embeddedCode) ? S(c.embeddedCode ? 'c.fullCommandCode' : 'c.fullCommand') + ' · ' + S('c.chars', { n: command.length }) : S('c.fullCommand') }),
      el('pre', { class: 'mono', text: command }),
    ]);
    const dflt = !!(open || !(c && (c.long || c.embeddedCode)));
    if (key) remember(/** @type {HTMLDetailsElement} */ (d), key, dflt);
    else /** @type {HTMLDetailsElement} */ (d).open = dflt;
    return d;
  }

  /** @param {any} m */
  function render(m) {
    lastModel = m;
    STR = m.strings || {};
    for (const id of Object.keys(inflight)) if (!m.operations.some((/** @type {any} */ o) => o.id === id && o.awaitingApproval) || Date.now() - inflight[id] > 4000) delete inflight[id];
    for (const o of m.operations) if (o.awaitingApproval && !shownAt[o.id]) { shownAt[o.id] = Date.now(); setTimeout(() => lastModel && render(lastModel), ARM_MS + 20); }
    const scrollTop = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    // Preserve keyboard focus across re-renders.
    const active = document.activeElement;
    const focusKey = active && active.getAttribute ? active.getAttribute('data-key') || (active.id ? '#' + active.id : null) : null;
    app.replaceChildren();

    // ---- Header
    app.appendChild(
      el('header', { class: 'header' }, [
        el('div', { class: 'header-row' }, [
          el('span', { class: `state state-${m.header.statusKind}`, text: m.header.statusLabel }),
          m.header.simulated
            ? el('span', { class: 'pill sim', text: S('a.simulated'), title: S('a.simulatedTip') })
            : el('span', { class: 'pill real', text: S('a.real'), title: S('a.realTip') }),
          el('span', { class: 'spacer' }),
          languageSelect(m.language),
        ]),
        el('div', { class: 'muted small', text: m.header.adapterName }),
        m.header.boundary && el('div', { class: 'boundary small clamp', text: S('a.boundary') + ': ' + m.header.boundary, title: m.header.boundary }),
        m.header.liveTracking && el('div', { class: 'live small', title: S('a.liveTrackingTip') }, [
          el('span', { class: 'live-dot', text: '●' }),
          el('span', { text: ' ' + S('a.liveTracking') }),
          m.header.currentOperation && el('span', { class: 'muted', text: ` · ${S('a.now')}: ` + m.header.currentOperation }),
        ]),
        m.header.awaitingInput && el('div', { class: 'approval small', text: S('a.awaitingInput') }),
        m.header.taskDescription && el('div', { class: 'task-desc clamp', text: m.header.taskDescription, title: m.header.taskDescription }),
        m.header.workspaceRoot && el('div', { class: 'small muted', text: S('nt.workspace') + ': ' + m.header.workspaceRoot }),
      ]),
    );

    // ---- Approval banner: right under the status, so a pending decision is visible without scrolling
    const allWaiting = m.operations.filter((/** @type {any} */ o) => o.awaitingApproval);
    const waiting = allWaiting[0];
    const busy = !!(waiting && (inflight[waiting.id] || !armed(waiting.id)));
    if (waiting) {
      app.appendChild(
        el('section', { class: 'approval', attrs: { role: 'alert' } }, [
          el('div', { class: 'approval-title', text: allWaiting.length > 1 ? S('a.approvalNeededN', { n: allWaiting.length }) : S('a.approvalNeeded') }),
          el('div', {}, [el('span', { text: waiting.cmd ? waiting.cmd.summary : waiting.description }), waiting.cmd && el('span', { text: ' ' }), writesPill(waiting.cmd)]),
          waiting.cmd && !waiting.cmd.writes && el('div', { class: 'muted small', text: S(waiting.cmd.mayGenerate ? 'c.mayGenerate' : 'c.noWriteDetected') }),
          waiting.cmd && fullCommand(waiting.description.replace(/^(Run tests|Run): /, ''), waiting.cmd, false, 'cmd-banner:' + waiting.id),
          !waiting.simulated && waiting.type === 'Edit' && el('div', { class: 'small', text: S('a.approveAppliesPatch') }),
          waiting.file && el('div', { class: 'muted small', text: [waiting.file, waiting.fn && `${waiting.fn}()`].filter(Boolean).join(' › ') }),
          el('div', { class: 'btn-row' }, [
            waiting.hasChange && button(S('a.reviewDiff'), () => act('review', waiting.id), { title: S('a.reviewDiffTip') }),
            waiting.editing
              ? button(S('p.applyMine'), () => act('applyEdited', waiting.id), { kind: 'primary', disabled: busy, title: S('p.applyMineTip') })
              : button(S('a.approve'), () => decide('approve', waiting.id), { kind: 'primary', disabled: busy }),
            button(S('a.reject'), () => decide('reject', waiting.id), { kind: 'danger', disabled: busy }),
            !waiting.simulated && waiting.type === 'Edit' && waiting.hasChange && button(waiting.editing ? S('p.files') : S('p.editFirst'), () => act('editProposal', waiting.id), { title: S('p.editFirstTip'), disabled: busy }),
            waiting.editing && button(S('p.cancelEdit'), () => act('cancelEdit', waiting.id)),
            !waiting.simulated && button(S('p.regenerate'), () => decide('regenerate', waiting.id), { title: S('p.regenerateTip'), disabled: busy }),
          ]),
        ]),
      );
    }

    // ---- Controls
    const c = m.controls;
    const follow = el('input', { attrs: { type: 'checkbox', id: 'follow' } });
    /** @type {HTMLInputElement} */ (follow).checked = c.follow;
    follow.addEventListener('change', () => send({ type: 'setFollow', value: /** @type {HTMLInputElement} */ (follow).checked }));
    app.appendChild(
      el('section', { class: 'controls', attrs: { 'aria-label': S('a.controls') } }, [
        el('div', { class: 'btn-row' }, [
          button(S('a.startDemo'), () => act('start'), { disabled: !c.canStart, kind: m.tasks.length ? '' : 'primary', title: S('a.startDemoTip') }),
          button(S('a.newTask'), () => act('newTask'), { disabled: !c.canNewTask, title: S('a.newTaskTip') }),
          button(S('chat.title'), () => act('openChat')),
          c.canResume
            ? button(S('a.resume'), () => act('resume'), { title: S('a.resumeTip') })
            : button(S('a.pause'), () => act('pause'), {
                disabled: !c.canPause,
                title: c.pauseUnsupported
                  ? S('a.pauseUnsupportedTip')
                  : S('a.pauseTip'),
              }),
          button(S('a.stop'), () => act('stop'), { disabled: !c.canStop, kind: 'danger', title: c.pauseUnsupported ? S('a.stopCodexTip') : S('a.stopTip') }),
          c.canSteer && button(m.header.awaitingInput ? S('a.followUp') : S('a.steer'), () => act('steer'), { title: S('a.steerTip'), kind: m.header.awaitingInput ? 'primary' : '' }),
          c.canEndSession && button(S('a.endSession'), () => act('endSession'), { title: S('a.endSessionTip') }),
        ]),
        el('label', { class: 'follow', attrs: { for: 'follow' }, title: S('a.liveFollowTip') }, [
          follow,
          el('span', { text: ' ' + S('a.liveFollow') }),
        ]),
      ]),
    );

    // ---- Task selector (history)
    if (m.tasks.length > 0) {
      const select = /** @type {HTMLSelectElement} */ (el('select', { attrs: { 'aria-label': S('a.taskHistory') } }));
      for (const t of m.tasks) {
        const opt = /** @type {HTMLOptionElement} */ (el('option', { text: t.label, attrs: { value: t.taskId } }));
        if (t.taskId === m.selectedTaskId) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => send({ type: 'selectTask', taskId: select.value }));
      app.appendChild(el('section', { class: 'tasks' }, [el('label', { class: 'muted small', text: S('a.task') }), select]));
    }

    // Conversation is separate from the operation audit timeline.
    if (m.selectedTaskId) {
      const transcript = el('details', { class: 'conversation' }, [
        el('summary', { text: S('a.conversation') }),
        el('p', { class: 'small muted', text: S('a.conversationHint') }),
        el('div', { class: 'btn-row' }, [
          button(S('a.openConversation'), () => act('conversation')),
          button(S('a.continueHistory'), () => act('continueHistory'), { disabled: !c.canStart }),
        ]),
      ]);
      /** @type {HTMLDetailsElement} */ (transcript).open = conversationOpen;
      transcript.addEventListener('toggle', () => { conversationOpen = /** @type {HTMLDetailsElement} */ (transcript).open; });
      for (const message of m.conversation || []) {
        transcript.appendChild(el('article', { class: 'conversation-message' }, [
          el('strong', { text: S(message.role === 'user' ? 'a.you' : 'a.assistant') }),
          el('div', { class: 'small muted', text: message.timestamp }),
          el('pre', { class: 'conversation-text', text: message.text }),
        ]));
      }
      app.appendChild(transcript);
    }

    // ---- Timeline, grouped by conversation turn. Completed turns start collapsed.
    const timeline = el('section', { class: 'timeline-section', attrs: { 'aria-label': S('a.operations') } }, [el('h3', { text: S('a.timeline') })]);
    if (!m.operations.length) timeline.appendChild(el('p', { class: 'muted empty', text: S('a.noOps') }));
    if (m.hiddenOperationCount > 0) timeline.appendChild(el('p', { class: 'muted small', text: S('a.hiddenOps', { n: m.hiddenOperationCount }) }));
    const s = m.selected;
    if (ui.dismissed && ui.dismissed !== m.focusId) ui.dismissed = undefined;
    if (ui.expanded && !m.operations.some((/** @type {any} */ o) => o.id === ui.expanded)) ui.expanded = undefined;
    const openId = ui.expanded || (m.focusId && ui.dismissed !== m.focusId ? m.focusId : undefined);
    /** @param {string} id */
    const detailFor = (id) => (s && s.id === id ? s : m.focus && m.focus.id === id ? m.focus : m.expanded && m.expanded.id === id ? m.expanded : undefined);
    for (const g of m.turnGroups || []) {
      const key = `${m.selectedTaskId}:${g.number}`;
      const group = /** @type {HTMLDetailsElement} */ (el('details', { class: 'turn-group', attrs: { 'data-key': 'turn:' + key } }));
      group.open = key in ui.turns ? ui.turns[key] : g.open;
      group.addEventListener('toggle', () => {
        ui.turns[key] = group.open;
        saveUi();
      });
      const status = g.status ? S('status.' + g.status) : '';
      group.appendChild(
        el('summary', { class: 'turn-summary' }, [
          el('span', { class: 'turn-title', text: g.number ? S('a.turnN', { n: g.number }) : S('a.turnSetup') }),
          status && el('span', { class: 'muted small', text: ' · ' + status }),
          el('span', { class: 'muted small', text: ' · ' + S('a.stepsN', { n: g.steps }) }),
          g.failed > 0 && el('span', { class: 'badge status-failed small', text: S('a.failedN', { n: g.failed }) }),
          g.pending > 0 && el('span', { class: 'badge status-proposed small', text: S('a.pendingN', { n: g.pending }) }),
        ]),
      );
      const list = el('ol', { class: 'timeline' });
      const rows = m.operations.filter((/** @type {any} */ x) => x.turn === g.number);
      for (let i = 0; i < rows.length; ) {
        // Runs of 3+ finished reads/searches, or of the same failure repeated (retries), become one collapsed row.
        const k = runKey(rows[i]);
        let j = i;
        while (k && j < rows.length && runKey(rows[j]) === k) j++;
        if (j - i >= 3) {
          list.appendChild(runItem(rows.slice(i, j)));
          i = j;
        } else {
          list.appendChild(stepItem(rows[i], s && s.id === rows[i].id ? s : undefined));
          i++;
        }
      }
      group.appendChild(list);
      timeline.appendChild(group);
    }
    app.appendChild(timeline);

    /** Steps with the same key next to each other are grouped. @param {any} o */
    function runKey(o) {
      if (o.awaitingApproval || o.isCurrent || o.id === openId) return '';
      if (o.type === 'Read' && o.status === 'Completed' && !o.errorReason) return 'read';
      if (o.status === 'Failed') return `failed:${o.type}:${o.file || ''}`;
      return '';
    }
    /** Consecutive finished reads/searches as one row; open to see each. @param {any[]} items */
    function runItem(items) {
      const names = items.map((o) => o.file || o.description).filter(Boolean);
      const shown = [...new Set(names)].slice(0, 3).join(', ') + (new Set(names).size > 3 ? ', …' : '');
      const failed = items[0].status === 'Failed';
      const d = /** @type {HTMLDetailsElement} */ (el('details', { class: 'op-run', attrs: { 'data-key': 'run:' + items[0].id } }, [
        el('summary', { class: 'small' }, [
          el('span', { class: `type type-${items[0].type.toLowerCase()}`, text: S('type.' + items[0].type) }),
          failed && el('span', { text: ' ' }),
          failed && badge('Failed', 'small'),
          el('span', { text: ` × ${items.length} · #${items[0].seq}–#${items[items.length - 1].seq}` }),
          failed && items[items.length - 1].errorReason && el('div', { class: 'op-error', text: items[items.length - 1].errorReason }),
          shown && el('span', { class: 'muted', text: ' · ' + shown }),
        ]),
        el('ol', { class: 'timeline' }, items.map((o) => stepItem(o, s && s.id === o.id ? s : undefined))),
      ]));
      return el('li', {}, [remember(d, 'run:' + items[0].id, false)]);
    }

    /** One step: title (toggles brief details), one primary action, "…" for the rest. @param {any} o @param {any} detail */
    function stepItem(o, detail) {
      const expanded = openId === o.id;
      detail = detail || (expanded ? detailFor(o.id) : undefined);
      const where = [o.file, o.fn && `${o.fn}()`].filter(Boolean).join(' › ');
      const toggle = () => {
        if (expanded) {
          // Closing the automatically opened step keeps it closed until the focus moves on.
          if (ui.expanded !== o.id) ui.dismissed = o.id;
          ui.expanded = undefined;
        } else {
          ui.expanded = o.id;
        }
        saveUi();
        // The extension keeps sending this step's details even when Follow selects newer steps.
        send({ type: 'expand', operationId: ui.expanded || null });
        if (!expanded) send({ type: 'select', operationId: o.id, reveal: false });
        else render(m);
      };
      const title = el(
        'button',
        {
          class: 'op-title',
          title: S('a.toggleDetails'),
          attrs: { 'aria-expanded': expanded ? 'true' : 'false', 'data-id': o.id, 'data-key': 'op:' + o.id },
          on: { click: toggle },
        },
        [
          el('div', { class: 'op-top' }, [
            el('span', { class: 'seq', text: `#${o.seq}` }),
            el('span', { class: `type type-${o.type.toLowerCase()}`, text: S('type.' + o.type) }),
            badge(o.status),
            o.control && el('span', { class: `ctl ctl-${o.control.toLowerCase()}`, text: S('ctl.' + o.control), title: o.control === 'OBSERVED' ? S('a.observedTip') : S('a.interceptedTip') }),
            o.cmd && writesPill(o.cmd),
            el('span', { class: 'time muted', text: [o.cmd && o.cmd.duration, o.time].filter(Boolean).join(' · ') }),
          ]),
          el('div', { class: 'op-desc', text: o.cmd ? o.cmd.summary : o.description }),
          where && el('div', { class: 'op-where', text: where }),
          o.errorReason && el('div', { class: 'op-error', text: o.errorReason }),
        ],
      );
      // The pending approval is decided in the banner above; no second set of buttons on its row.
      const primary = waiting && o.id === waiting.id ? null : primaryButton(o, toggle);
      const row = el('div', { class: `op ${detail ? 'selected' : ''} ${o.isCurrent ? 'current' : ''} ${o.awaitingApproval ? 'waiting' : ''}` }, [
        title,
        el('div', { class: 'op-actions' }, [primary, moreMenu(o)]),
      ]);
      return el('li', {}, [row, expanded && (detail ? briefDetails(detail) : el('div', { class: 'brief muted small', text: S('a.loading') }))]);
    }

    /** @param {any} o @param {() => void} toggle */
    function primaryButton(o, toggle) {
      const inline = () => (openId === o.id ? undefined : toggle());
      switch (o.primary) {
        case 'review':
          return button(S('a.reviewChanges'), () => act('review', o.id), { kind: 'primary', title: S('a.reviewDiffTip') });
        case 'diff':
          return button(S('a.viewDiff'), () => act('review', o.id), { title: S('a.viewDiffTip') });
        case 'error':
          return button(S('a.viewError'), inline, { kind: 'danger-outline', title: S('a.viewErrorTip') });
        case 'command':
          return button(S('a.viewCommand'), inline, { title: S('a.viewCommandTip') });
        case 'file':
          return button(S('a.viewFile'), () => act('reveal', o.id), { title: S('a.gotoCodeTip') });
        case 'result':
          return button(S('a.viewResult'), inline, { title: S('a.viewResultTip') });
        default:
          return null;
      }
    }

    /** Secondary actions. @param {any} o */
    function moreMenu(o) {
      const sel = m.selected && m.selected.id === o.id ? m.selected : undefined;
      const items = [
        o.file && o.primary !== 'file' && button(S('a.gotoCode'), () => act('reveal', o.id), { title: S('a.gotoCodeTip') }),
        o.hasChange && o.primary !== 'diff' && o.primary !== 'review' && button(S('a.viewDiff'), () => act('review', o.id)),
        o.hasCommand && button(S('a.commandOutput'), () => act('showOutput', o.id)),
        o.hasCommand && button(S('c.copyCommand'), () => send({ type: 'copy', operationId: o.id, what: 'command' }), { title: S('c.copyTip') }),
        o.hasCommand && button(S('c.copyOutput'), () => send({ type: 'copy', operationId: o.id, what: 'output' }), { title: S('c.copyTip') }),
        o.hasCommand && m.controls.reviewerEnabled && button(S('c.explain'), () => act('aiExplainCommand', o.id), { title: S('c.explainTip') }),
        o.hasChange && m.controls.reviewerEnabled && button(S('a.aiReview'), () => act('aiReviewChange', o.id), { title: S('a.aiReviewTip') }),
        o.errorReason && o.hasCommand && m.controls.reviewerEnabled && button(S('a.aiError'), () => act('aiExplainError', o.id), { title: S('a.aiErrorTip') }),
        o.awaitingApproval && (!waiting || o.id !== waiting.id) && !o.simulated && o.type === 'Edit' && o.hasChange && button(S('p.editFirst'), () => act('editProposal', o.id), { title: S('p.editFirstTip') }),
        o.awaitingApproval && (!waiting || o.id !== waiting.id) && !o.simulated && button(S('p.regenerate'), () => decide('regenerate', o.id), { title: S('p.regenerateTip') }),
        button(S('a.export'), () => act('exportContext', o.id), { title: S('a.exportTip') }),
        button(S('a.fullRecord'), () => act('record', o.id), { title: S('a.fullRecordTip') }),
      ].filter(Boolean);
      void sel;
      const menu = /** @type {HTMLDetailsElement} */ (el('details', { class: 'more', attrs: { 'data-key': 'more:' + o.id } }, [
        el('summary', { text: '…', title: S('a.moreActions'), attrs: { 'aria-label': S('a.moreActions') } }),
        el('div', { class: 'menu' }, items),
      ]));
      menu.open = ui.menu === o.id;
      menu.addEventListener('toggle', () => {
        if (!menu.isConnected) return;
        if (menu.open) closeMenus(menu);
        ui.menu = menu.open ? o.id : ui.menu === o.id ? undefined : ui.menu;
      });
      menu.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('button')) closeMenus();
      });
      return menu;
    }

    /** Brief inline details from the selected operation (full record via "…"). @param {any} d */
    function briefDetails(d) {
      const box = el('div', { class: 'brief', attrs: { 'aria-label': S('a.detailsAria') } });
      // Further pending approvals (the first one is in the banner) can be decided here.
      if ((d.canApprove || d.canReject) && !(waiting && waiting.id === d.id)) {
        const busyHere = !!inflight[d.id] || !armed(d.id);
        box.appendChild(el('div', { class: 'btn-row' }, [
          d.canReviewChange && button(S('a.reviewChanges'), () => act('review', d.id), { title: S('a.reviewDiffTip') }),
          d.canApprove && button(S('a.approve'), () => decide('approve', d.id), { kind: 'primary', disabled: busyHere }),
          d.canReject && button(S('a.reject'), () => decide('reject', d.id), { kind: 'danger', disabled: busyHere }),
        ]));
      }
      if (d.errorReason) {
        box.appendChild(el('div', { class: 'op-error' }, [el('strong', { text: S('a.errorReason') + ': ' }), el('span', { text: d.errorReason })]));
      }
      if (d.command) {
        const out = [d.command.stdout, d.command.stderr].filter(Boolean).join('\n');
        const facts = [
          [S('f.cwd'), d.command.workingDirectory],
          [S('f.exitCode'), d.command.exitCode !== undefined ? String(d.command.exitCode) : undefined],
          [S('f.duration'), d.cmd && d.cmd.duration],
        ].filter((x) => x[1]);
        box.appendChild(el('div', { class: 'command' }, [
          d.cmd && d.cmd.writes && el('div', { class: 'warn small', text: S('c.writesDetail', { reasons: d.cmd.writeReasons.join('; ') }) }),
          d.cmd && d.cmd.sourceWrite && d.status === 'Rejected' && el('div', { class: 'warn small', text: S('c.blockedWrite') }),
          d.cmd && !d.cmd.writes && el('div', { class: 'muted small', text: S(d.cmd.mayGenerate ? 'c.mayGenerate' : 'c.noWriteDetected') }),
          d.command.simulated && el('span', { class: 'pill sim', text: S('a.simulated') }),
          fullCommand(d.command.command, d.cmd, false, 'cmd:' + d.id),
          el('dl', { class: 'fields' }, facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'mono', text: v })])),
          out && remember(/** @type {HTMLDetailsElement} */ (el('details', {}, [
            el('summary', { text: (d.command.outputCombined ? S('a.outputCombined') : S('a.output')) + ' · ' + S('c.chars', { n: out.length }) }),
            el('pre', { text: d.command.stdout || '' }),
            d.command.stderr && el('pre', { class: 'stderr', text: d.command.stderr }),
          ])), 'out:' + d.id, !!(d.errorReason || out.length < 4000)),
        ]));
      } else if (d.resultSummary) {
        const long = d.resultSummary.length > 1500;
        box.appendChild(el('div', {}, [
          el('pre', { class: 'result', text: long ? d.resultSummary.slice(0, 1500) + '…' : d.resultSummary }),
          long && button(S('a.fullRecord'), () => act('record', d.id), { title: S('a.fullRecordTip') }),
        ]));
      }
      if (d.change) box.appendChild(el('div', { class: 'small' }, [el('strong', { text: S('f.change') + ': ' }), el('span', { text: `${d.change.decision}${d.change.decisionReason ? ` — ${d.change.decisionReason}` : ''}${d.changeCount > 1 ? ` (${S('a.filesOneDecision', { n: d.changeCount })})` : ''}` })]));
      if (d.affectedFunctions.length || d.changedLines.length) {
        box.appendChild(el('div', { class: 'changes' }, [
          ...d.affectedFunctions.map((/** @type {any} */ f) =>
            el('div', { class: 'fn-row' }, [
              el('button', { class: 'link', text: f.label, title: S('a.gotoFunction'), attrs: { 'data-key': 'fn:' + d.id + ':' + f.index }, on: { click: () => send({ type: 'gotoFunction', operationId: d.id, index: f.index }) } }),
              m.controls.reviewerEnabled && el('button', { class: 'link small', text: S('a.explainFunction'), title: S('a.explainFunctionTip'), attrs: { 'data-key': 'fnx:' + d.id + ':' + f.index }, on: { click: () => send({ type: 'explainFunction', operationId: d.id, index: f.index }) } }),
            ]),
          ),
          d.changedLines.length > 0 && el('div', { class: 'small mono muted', text: d.changedLines.join('\n') }),
        ]));
      }
      if (d.rationale) box.appendChild(el('div', { class: 'small muted', text: d.rationale }));
      // Audit trail stays complete, folded by default.
      const trail = remember(/** @type {HTMLDetailsElement} */ (el('details', { class: 'audit' }, [el('summary', { text: `${S('a.auditTrail')} (${d.history.length})` })])), 'audit:' + d.id, false);
      trail.appendChild(el('div', { class: 'small muted', text: d.controlExplanation }));
      const history = el('ol', { class: 'history' });
      for (const h of d.history) {
        history.appendChild(el('li', {}, [
          el('span', { class: 'muted', text: h.timestamp.slice(11, 19) + ' ' }),
          badge(h.status, 'small'),
          el('span', { text: ` ${S('a.by')} ${h.actor}${h.note ? `: ${h.note}` : ''}` }),
        ]));
      }
      trail.appendChild(history);
      trail.appendChild(el('div', { class: 'small muted mono', text: `${S('f.operationId')}: ${d.id}` }));
      box.appendChild(trail);
      return box;
    }

    if (document.scrollingElement) document.scrollingElement.scrollTop = scrollTop;
    if (focusKey) {
      const target = focusKey.startsWith('#')
        ? document.getElementById(focusKey.slice(1))
        : app.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (target instanceof HTMLElement && !target.hasAttribute('disabled')) target.focus({ preventScroll: true });
    }
    // Keep a newly focused step (approval, running step, failure) in view when Follow is on.
    if (m.focusId && m.focusId !== lastFocus && m.controls.follow && !ui.expanded) {
      // A pending approval is decided in the banner at the top: keep the banner in view, not its row.
      const node = waiting && waiting.id === m.focusId ? app.querySelector('section.approval') : app.querySelector(`[data-id="${CSS.escape(m.focusId)}"]`);
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
    lastFocus = m.focusId;
    // Keep a newly selected row visible.
    if (s && s.id !== lastSelected) {
      const node = app.querySelector(`[data-id="${CSS.escape(s.id)}"]`);
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
    lastSelected = s && s.id;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'state' && msg.model) render(msg.model);
  });

  send({ type: 'ready' });
  if (ui.expanded) send({ type: 'expand', operationId: ui.expanded });
})();
