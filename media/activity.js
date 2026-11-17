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

  /** @param {any} m */
  function render(m) {
    STR = m.strings || {};
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
        m.header.boundary && el('div', { class: 'boundary small', text: S('a.boundary') + ': ' + m.header.boundary }),
        m.header.liveTracking && el('div', { class: 'live small', title: S('a.liveTrackingTip') }, [
          el('span', { class: 'live-dot', text: '●' }),
          el('span', { text: ' ' + S('a.liveTracking') }),
          m.header.currentOperation && el('span', { class: 'muted', text: ` · ${S('a.now')}: ` + m.header.currentOperation }),
        ]),
        m.header.awaitingInput && el('div', { class: 'approval small', text: S('a.awaitingInput') }),
        m.header.taskDescription && el('div', { class: 'task-desc', text: m.header.taskDescription }),
        m.header.workspaceRoot && el('div', { class: 'small muted', text: S('nt.workspace') + ': ' + m.header.workspaceRoot }),
      ]),
    );

    // ---- Controls
    const c = m.controls;
    const follow = el('input', { attrs: { type: 'checkbox', id: 'follow' } });
    /** @type {HTMLInputElement} */ (follow).checked = c.follow;
    follow.addEventListener('change', () => send({ type: 'setFollow', value: /** @type {HTMLInputElement} */ (follow).checked }));
    app.appendChild(
      el('section', { class: 'controls', attrs: { 'aria-label': S('a.controls') } }, [
        el('div', { class: 'btn-row' }, [
          button(S('a.startDemo'), () => act('start'), { disabled: !c.canStart, kind: 'primary', title: S('a.startDemoTip') }),
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
          button(S('chat.open'), () => act('openChat')),
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

    // ---- Approval banner
    const allWaiting = m.operations.filter((/** @type {any} */ o) => o.awaitingApproval);
    const waiting = allWaiting[0];
    if (waiting) {
      app.appendChild(
        el('section', { class: 'approval', attrs: { role: 'alert' } }, [
          el('div', { class: 'approval-title', text: allWaiting.length > 1 ? S('a.approvalNeededN', { n: allWaiting.length }) : S('a.approvalNeeded') }),
          el('div', { text: waiting.description }),
          !waiting.simulated && waiting.type === 'Edit' && el('div', { class: 'small', text: S('a.approveAppliesPatch') }),
          waiting.file && el('div', { class: 'muted small', text: [waiting.file, waiting.fn && `${waiting.fn}()`].filter(Boolean).join(' › ') }),
          el('div', { class: 'btn-row' }, [
            button(S('a.reviewDiff'), () => act('review', waiting.id), { title: S('a.reviewDiffTip') }),
            button(S('a.approve'), () => act('approve', waiting.id), { kind: 'primary' }),
            button(S('a.reject'), () => act('reject', waiting.id), { kind: 'danger' }),
          ]),
        ]),
      );
    }

    // ---- Timeline
    const list = el('ol', { class: 'timeline', attrs: { 'aria-label': S('a.operations') } });
    if (!m.operations.length) {
      list.appendChild(el('li', { class: 'muted empty', text: S('a.noOps') }));
    }
    if (m.hiddenOperationCount > 0) {
      list.appendChild(el('li', { class: 'muted small', text: S('a.hiddenOps', { n: m.hiddenOperationCount }) }));
    }
    for (const o of m.operations) {
      const selected = m.selected && m.selected.id === o.id;
      const where = [o.file, o.fn && `${o.fn}()`].filter(Boolean).join(' › ');
      const row = el(
        'button',
        {
          class: `op ${selected ? 'selected' : ''} ${o.isCurrent ? 'current' : ''} ${o.awaitingApproval ? 'waiting' : ''}`,
          title: o.file ? S('a.selectOpen') : S('a.select'),
          attrs: { 'aria-pressed': selected ? 'true' : 'false', 'data-id': o.id, 'data-key': 'op:' + o.id },
          on: { click: () => send({ type: 'select', operationId: o.id, reveal: true }) },
        },
        [
          el('div', { class: 'op-top' }, [
            el('span', { class: 'seq', text: `#${o.seq}` }),
            el('span', { class: `type type-${o.type.toLowerCase()}`, text: S('type.' + o.type) }),
            badge(o.status),
            o.control && el('span', { class: `ctl ctl-${o.control.toLowerCase()}`, text: S('ctl.' + o.control), title: o.control === 'OBSERVED' ? S('a.observedTip') : S('a.interceptedTip') }),
            el('span', { class: 'time muted', text: o.time }),
          ]),
          el('div', { class: 'op-desc', text: o.description }),
          where && el('div', { class: 'op-where', text: where }),
          o.hasCommand && el('div', { class: 'op-where mono', text: o.simulated ? S('a.commandSimulated') : S('a.command') }),
        ],
      );
      list.appendChild(el('li', {}, [row]));
    }
    app.appendChild(el('section', {}, [el('h3', { text: S('a.timeline') }), list]));

    // ---- Details
    const s = m.selected;
    if (s) {
      /** @type {[string, string|undefined][]} */
      const fields = [
        [S('f.type'), S('type.' + s.type)],
        [S('f.status'), S('status.' + s.status)],
        [S('f.file'), s.file],
        [S('f.function'), s.fn && `${s.fn}()`],
        [S('f.lineHint'), s.lineNumber && String(s.lineNumber)],
        [S('f.time'), s.timestamp],
        [S('f.rationale'), s.rationale],
        [S('f.result'), s.resultSummary],
        [S('f.control'), s.controlExplanation],
        [S('f.change'), s.change && `${s.change.decision}${s.change.decisionReason ? ` — ${s.change.decisionReason}` : ''}${s.changeCount > 1 ? ` (${S('a.filesOneDecision', { n: s.changeCount })})` : ''}`],
        [S('f.operationId'), s.id],
      ];
      const dl = el('dl', { class: 'fields' });
      for (const [k, v] of fields) {
        if (!v) continue;
        dl.appendChild(el('dt', { text: k }));
        dl.appendChild(el('dd', { text: v }));
      }

      const actions = el('div', { class: 'btn-row' }, [
        s.canReveal && button(S('a.gotoCode'), () => act('reveal', s.id), { title: S('a.gotoCodeTip') }),
        button(s.canReviewChange ? S('a.reviewDiff') : S('a.reviewDetails'), () => act('review', s.id)),
        s.command && button(S('a.commandOutput'), () => act('showOutput', s.id)),
        m.controls.reviewerEnabled && s.canReviewChange && button(S('a.aiReview'), () => act('aiReviewChange', s.id), { title: S('a.aiReviewTip') }),
        m.controls.reviewerEnabled && s.hasFailedCommand && button(S('a.aiError'), () => act('aiExplainError', s.id), { title: S('a.aiErrorTip') }),
        button(S('a.export'), () => act('exportContext', s.id), { title: S('a.exportTip') }),
        s.canApprove && button(S('a.approve'), () => act('approve', s.id), { kind: 'primary' }),
        s.canReject && button(S('a.reject'), () => act('reject', s.id), { kind: 'danger' }),
      ]);

      const changeInfo =
        (s.changedLines.length || s.affectedFunctions.length) &&
        el('div', { class: 'changes' }, [
          s.affectedFunctions.length > 0 && el('h4', { text: S('a.affectedFunctions') }),
          ...s.affectedFunctions.map((/** @type {any} */ f) =>
            el('button', {
              class: 'link',
              text: f.label,
              title: S('a.gotoFunction'),
              attrs: { 'data-key': 'fn:' + s.id + ':' + f.index },
              on: { click: () => send({ type: 'gotoFunction', operationId: s.id, index: f.index }) },
            }),
          ),
          s.changedLines.length > 0 && el('h4', { text: S('a.changedLines') }),
          s.changedLines.length > 0 && el('div', { class: 'small mono', text: s.changedLines.join('\n') }),
        ]);

      let cmd = null;
      if (s.command) {
        const cmdFields = el('dl', { class: 'fields' });
        /** @type {[string, string|undefined, string][]} */
        const cf = [
          [S('f.command'), s.command.command, 'mono'],
          [S('f.cwd'), s.command.workingDirectory, 'mono'],
          [S('f.status'), s.command.status, ''],
          [S('f.exitCode'), s.command.exitCode !== undefined ? String(s.command.exitCode) : undefined, ''],
          [S('f.started'), s.command.startedAt, ''],
          [S('f.finished'), s.command.finishedAt, ''],
        ];
        for (const [k, v, cls] of cf) {
          if (!v) continue;
          cmdFields.appendChild(el('dt', { text: k }));
          cmdFields.appendChild(el('dd', { class: cls || '', text: v }));
        }
        cmd = el('div', { class: 'command' }, [
          el('h4', {}, [el('span', { text: S('f.command') + ' ' }), s.command.simulated && el('span', { class: 'pill sim', text: S('a.simulated') })]),
          cmdFields,
          s.command.stdout && el('details', { attrs: { open: '' } }, [el('summary', { text: s.command.outputCombined ? S('a.outputCombined') : 'stdout' }), el('pre', { text: s.command.stdout })]),
          s.command.stderr && el('details', {}, [el('summary', { text: 'stderr' }), el('pre', { text: s.command.stderr })]),
        ]);
      }

      const history = el('ol', { class: 'history' });
      for (const h of s.history) {
        history.appendChild(
          el('li', {}, [
            el('span', { class: 'muted', text: h.timestamp.slice(11, 19) + ' ' }),
            badge(h.status, 'small'),
            el('span', { text: ` ${S('a.by')} ${h.actor}${h.note ? `: ${h.note}` : ''}` }),
          ]),
        );
      }

      app.appendChild(
        el('section', { class: 'details', attrs: { 'aria-label': S('a.detailsAria') } }, [
          el('h3', { text: S('a.details', { n: s.seq }) }),
          actions,
          dl,
          changeInfo,
          cmd,
          el('h4', { text: S('a.auditTrail') }),
          history,
        ]),
      );
    } else if (m.operations.length) {
      app.appendChild(el('p', { class: 'muted small', text: S('a.selectHint') }));
    }

    if (document.scrollingElement) document.scrollingElement.scrollTop = scrollTop;
    if (focusKey) {
      const target = focusKey.startsWith('#')
        ? document.getElementById(focusKey.slice(1))
        : app.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (target instanceof HTMLElement && !target.hasAttribute('disabled')) target.focus({ preventScroll: true });
    }
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
})();
