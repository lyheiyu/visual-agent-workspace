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
  const ui = Object.assign({ expanded: undefined, menu: undefined, turns: {} }, ((vscode.getState && vscode.getState()) || {}).ui || {});
  const saveUi = () => {
    try {
      vscode.setState({ ...((vscode.getState && vscode.getState()) || {}), ui: { expanded: ui.expanded, turns: ui.turns } });
    } catch {
      /* state is a convenience only */
    }
  };
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
  function fullCommand(command, c, open) {
    const d = el('details', { class: 'full-command' }, [
      el('summary', { text: c && (c.long || c.embeddedCode) ? S(c.embeddedCode ? 'c.fullCommandCode' : 'c.fullCommand') + ' · ' + S('c.chars', { n: command.length }) : S('c.fullCommand') }),
      el('pre', { class: 'mono', text: command }),
    ]);
    if (open || !(c && (c.long || c.embeddedCode))) /** @type {HTMLDetailsElement} */ (d).open = true;
    return d;
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
          el('div', {}, [el('span', { text: waiting.cmd ? waiting.cmd.summary : waiting.description }), waiting.cmd && el('span', { text: ' ' }), writesPill(waiting.cmd)]),
          waiting.cmd && !waiting.cmd.writes && el('div', { class: 'muted small', text: S(waiting.cmd.mayGenerate ? 'c.mayGenerate' : 'c.noWriteDetected') }),
          waiting.cmd && fullCommand(waiting.description.replace(/^(Run tests|Run): /, ''), waiting.cmd),
          !waiting.simulated && waiting.type === 'Edit' && el('div', { class: 'small', text: S('a.approveAppliesPatch') }),
          waiting.file && el('div', { class: 'muted small', text: [waiting.file, waiting.fn && `${waiting.fn}()`].filter(Boolean).join(' › ') }),
          el('div', { class: 'btn-row' }, [
            button(S('a.reviewDiff'), () => act('review', waiting.id), { title: S('a.reviewDiffTip') }),
            button(S('a.approve'), () => act('approve', waiting.id), { kind: 'primary' }),
            button(S('a.reject'), () => act('reject', waiting.id), { kind: 'danger' }),
            !waiting.simulated && waiting.type === 'Edit' && button(S('p.editFirst'), () => act('editProposal', waiting.id), { title: S('p.editFirstTip') }),
            !waiting.simulated && button(S('p.regenerate'), () => act('regenerate', waiting.id), { title: S('p.regenerateTip') }),
          ]),
        ]),
      );
    }

    // ---- Timeline, grouped by conversation turn. Completed turns start collapsed.
    const timeline = el('section', { class: 'timeline-section', attrs: { 'aria-label': S('a.operations') } }, [el('h3', { text: S('a.timeline') })]);
    if (!m.operations.length) timeline.appendChild(el('p', { class: 'muted empty', text: S('a.noOps') }));
    if (m.hiddenOperationCount > 0) timeline.appendChild(el('p', { class: 'muted small', text: S('a.hiddenOps', { n: m.hiddenOperationCount }) }));
    const s = m.selected;
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
      for (const o of m.operations.filter((/** @type {any} */ x) => x.turn === g.number)) list.appendChild(stepItem(o, s && s.id === o.id ? s : undefined));
      group.appendChild(list);
      timeline.appendChild(group);
    }
    app.appendChild(timeline);

    /** One step: title (toggles brief details), one primary action, "…" for the rest. @param {any} o @param {any} detail */
    function stepItem(o, detail) {
      const expanded = ui.expanded === o.id;
      const where = [o.file, o.fn && `${o.fn}()`].filter(Boolean).join(' › ');
      const toggle = () => {
        ui.expanded = expanded ? undefined : o.id;
        saveUi();
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
      const primary = primaryButton(o, toggle);
      const row = el('div', { class: `op ${detail ? 'selected' : ''} ${o.isCurrent ? 'current' : ''} ${o.awaitingApproval ? 'waiting' : ''}` }, [
        title,
        el('div', { class: 'op-actions' }, [primary, moreMenu(o)]),
      ]);
      return el('li', {}, [row, expanded && (detail ? briefDetails(detail) : el('div', { class: 'brief muted small', text: S('a.loading') }))]);
    }

    /** @param {any} o @param {() => void} toggle */
    function primaryButton(o, toggle) {
      const inline = () => (ui.expanded === o.id ? undefined : toggle());
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
        o.awaitingApproval && !o.simulated && o.type === 'Edit' && o.hasChange && button(S('p.editFirst'), () => act('editProposal', o.id), { title: S('p.editFirstTip') }),
        o.awaitingApproval && !o.simulated && button(S('p.regenerate'), () => act('regenerate', o.id), { title: S('p.regenerateTip') }),
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
        ui.menu = menu.open ? o.id : ui.menu === o.id ? undefined : ui.menu;
      });
      return menu;
    }

    /** Brief inline details from the selected operation (full record via "…"). @param {any} d */
    function briefDetails(d) {
      const box = el('div', { class: 'brief', attrs: { 'aria-label': S('a.detailsAria') } });
      if (d.canApprove || d.canReject) {
        box.appendChild(el('div', { class: 'btn-row' }, [
          d.canReviewChange && button(S('a.reviewChanges'), () => act('review', d.id), { title: S('a.reviewDiffTip') }),
          d.canApprove && button(S('a.approve'), () => act('approve', d.id), { kind: 'primary' }),
          d.canReject && button(S('a.reject'), () => act('reject', d.id), { kind: 'danger' }),
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
          fullCommand(d.command.command, d.cmd),
          el('dl', { class: 'fields' }, facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'mono', text: v })])),
          out && el('details', { attrs: d.errorReason || out.length < 4000 ? { open: '' } : {} }, [
            el('summary', { text: (d.command.outputCombined ? S('a.outputCombined') : S('a.output')) + ' · ' + S('c.chars', { n: out.length }) }),
            el('pre', { text: d.command.stdout || '' }),
            d.command.stderr && el('pre', { class: 'stderr', text: d.command.stderr }),
          ]),
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
      const trail = el('details', { class: 'audit' }, [el('summary', { text: `${S('a.auditTrail')} (${d.history.length})` })]);
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
