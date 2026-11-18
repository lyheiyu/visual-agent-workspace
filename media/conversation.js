// @ts-check
(function () {
  // @ts-ignore supplied by VS Code
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const drafts = saved.drafts || {};
  const errors = {};
  let model;
  let sending = false;
  let pending;
  let lastTask;
  const app = document.getElementById('app');
  const send = (message) => vscode.postMessage(message);
  const S = (key) => model?.strings[key] || key;
  // Markdown + clickable file references (media/markdownView.js). Clicking only posts a message;
  // the extension host validates and resolves the path before opening an editor.
  const MD = window.VAWMarkdown;
  const md = MD && MD.create(document, {
    onRef: (ref, side) => send({ type: 'openReference', ref: { path: ref.path, line: ref.line, column: ref.column, endLine: ref.endLine }, side }),
    onLink: (href) => send({ type: 'openLink', href }),
    refTitle: (ref) => `${S('ref.open')}: ${MD.label(ref)}
${S('ref.hint')}`,
    linkTitle: (href) => `${S('ref.external')}: ${href}`,
  });
  const body = (ast, text) => {
    try { return md && ast ? md.render(ast) : el('pre', text); }
    catch (error) {
      console.error('Conversation formatting failed; displaying the original text.', error);
      return el('pre', text);
    }
  };
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(label, callback, disabled = false) {
    const node = el('button', label);
    node.disabled = disabled;
    node.addEventListener('click', callback);
    return node;
  }
  /** @param {any} node @param {string} title */
  function titled(node, title) { node.title = title; return node; }
  /** Manual-change actions reuse the conversation; "continue" takes the composer text as the next step. */
  function sendManual(kind) {
    if (!model?.canSend || sending) return;
    sending = true;
    errors[model.taskId] = '';
    pending = kind === 'continue' ? { taskId: model.taskId, text: (drafts[model.taskId] || '').trim() } : undefined;
    send({ type: 'manual', kind, text: kind === 'continue' ? (drafts[model.taskId] || '') : undefined });
    render();
  }
  function persist() { vscode.setState({ drafts, selectedTaskId: model?.taskId }); }
  function submit(useSavedContext = false) {
    if (!model?.canSend || sending) return;
    const text = (drafts[model.taskId] || '').trim();
    if (!text) return;
    sending = true;
    pending = { taskId: model.taskId, text };
    errors[model.taskId] = '';
    send({ type: 'send', taskId: model.taskId, text, useSavedContext });
    render();
  }
  function render() {
    if (!model || !app) return;
    const oldScroll = document.getElementById('messages');
    const scroll = oldScroll?.scrollTop || 0;
    const bottom = !oldScroll || oldScroll.scrollHeight - scroll - oldScroll.clientHeight < 80;
    const focused = document.activeElement?.id === 'message';
    const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    app.replaceChildren();
    const list = el('aside', undefined, 'sessions');
    list.append(el('h2', S('chat.title')), button('+ ' + S('chat.new'), () => send({ type: 'new' })));
    for (const task of model.tasks) {
      const card = button('', () => send({ type: 'select', taskId: task.taskId }));
      card.className = 'session' + (task.taskId === model.taskId ? ' selected' : '');
      card.setAttribute('aria-pressed', String(task.taskId === model.taskId));
      card.append(el('strong', task.title), el('small', S(task.status === 'ready' ? 'state.ready' : 'status.' + task.status)), el('small', task.model), el('small', task.project || ''), el('small', task.date));
      list.append(card);
    }
    const main = el('main');
    const header = el('header');
    header.append(el('strong', model.header.statusLabel, 'status ' + model.header.statusKind), el('div', model.header.taskDescription || S('chat.empty')), el('small', model.header.workspaceRoot || ''));
    if (model.taskId) header.append(el('small', S('chat.' + model.mode)));
    if (model.selectedModel) header.append(el('small', model.selectedModel));
    if (model.profile) header.append(el('small', S(model.profile)));
    const actions = el('div', undefined, 'actions');
    if (model.header.workspaceRoot) actions.append(button(S('chat.project'), () => send({ type: 'project' })));
    if (model.canStop) actions.append(button(S('a.stop'), () => send({ type: 'action', action: 'stop' })));
    if (model.canEnd) actions.append(button(S('a.endSession'), () => send({ type: 'action', action: 'endSession' })));
    header.append(actions);
    main.append(header);
    const messages = el('div', undefined, 'messages');
    messages.id = 'messages';
    // Merged into right-click context-menu arguments for file references (webview/context).
    if (model.taskId) messages.setAttribute('data-vscode-context', JSON.stringify({ taskId: model.taskId }));
    if (!model.taskId) messages.append(el('p', S('chat.empty'), 'muted'));
    for (const message of model.messages) {
      const item = el('article', undefined, 'message ' + message.role);
      item.append(el('strong', S(message.role === 'user' ? 'a.you' : 'a.assistant')), body(message.ast, message.text), el('small', new Date(message.timestamp).toLocaleString()));
      messages.append(item);
    }
    if (model.turns.length) {
      messages.append(el('h3', S('chat.turns')));
      for (const turn of model.turns) {
        const item = el('details', undefined, 'turn' + (turn.failedOperations ? ' failed' : ''));
        item.open = turn === model.turns[model.turns.length - 1];
        item.append(el('summary', `#${turn.number} · ${S(turn.failedOperations ? 'chat.turnFailed' : 'status.' + turn.status)}`));
        if (turn.report) item.append(body(turn.ast, turn.report));
        messages.append(item);
      }
    }
    if (model.preview) {
      // A proposal is being generated. Live text only if the runtime streams it; editing waits for the finished proposal.
      const box = el('article', undefined, 'approval preview');
      box.setAttribute('role', 'status');
      if (model.preview.text) {
        const pre = el('pre', model.preview.text);
        pre.className = 'mono preview-text';
        box.append(el('strong', S('p.preview')), el('p', [model.preview.filePath, model.preview.characters + ' chars'].filter(Boolean).join(' · '), 'muted'), pre, el('p', S('p.previewNote'), 'muted'));
      } else {
        box.append(el('strong', S('p.generating')), model.preview.filePath ? el('p', model.preview.filePath, 'muted') : '', el('p', S('p.generatingNote'), 'muted'));
      }
      box.append(button(S('p.editFirst') + ' — ' + S('p.editAfterGeneration'), () => {}, true));
      messages.append(box);
    }
    for (const approval of model.approvals) {
      const item = el('article', undefined, 'approval' + (approval.conflict ? ' conflict' : ''));
      const title = el('p');
      title.append(el('span', approval.cmd ? approval.cmd.summary : approval.description));
      if (approval.cmd && approval.cmd.writes) {
        const pill = el('span', S('c.writes'), 'pill writes');
        pill.title = S('c.heuristicTip') + ': ' + approval.cmd.writeReasons.join('; ');
        title.append(' ', pill);
      }
      item.append(el('strong', S('a.approvalNeeded')), title);
      if (approval.command && !(approval.cmd && approval.cmd.writes)) item.append(el('p', S('c.noWriteDetected'), 'muted'));
      if (approval.command) {
        const d = el('details');
        d.append(el('summary', S(approval.cmd && approval.cmd.embeddedCode ? 'c.fullCommandCode' : 'c.fullCommand')), el('pre', approval.command));
        d.open = !(approval.cmd && (approval.cmd.long || approval.cmd.embeddedCode));
        item.append(d);
      }
      if (approval.conflict) item.append(el('p', S('p.conflict').replace('{what}', approval.conflict), 'error'));
      const row = el('div', undefined, 'actions');
      const feedback = () => (drafts[model.taskId] || '').trim();
      row.append(
        approval.hasChange ? button(S('a.reviewDiff'), () => send({ type: 'action', action: 'review', operationId: approval.id })) : '',
        button(S('a.approve'), () => send({ type: 'action', action: 'approve', operationId: approval.id }), !!approval.conflict),
        button(S('a.reject'), () => send({ type: 'action', action: 'reject', operationId: approval.id })),
        approval.hasChange && approval.type === 'Edit' ? button(approval.editing ? S('p.applyMine') : S('p.editFirst'), () => send({ type: 'action', action: approval.editing ? 'applyEdited' : 'editProposal', operationId: approval.id })) : '',
        button(S('p.regenerate'), () => send({ type: 'regenerate', operationId: approval.id, feedback: feedback() })),
      );
      item.append(row);
      messages.append(item);
    }
    main.append(messages);
    if (model.taskId) {
      const composer = el('footer');
      if (model.blocked) composer.append(el('p', S(model.blocked), 'muted'));
      if (model.needsConfiguration) composer.append(el('p', S('chat.needsSettings'), 'muted'), button(S('chat.configure'), () => send({ type: 'configure' })));
      if (errors[model.taskId]) composer.append(el('p', errors[model.taskId], 'error'));
      const input = el('textarea');
      input.id = 'message'; input.rows = 3; input.maxLength = 4000;
      input.placeholder = S('chat.placeholder');
      input.setAttribute('aria-label', S('chat.placeholder'));
      input.value = drafts[model.taskId] || '';
      input.addEventListener('input', () => { drafts[model.taskId] = input.value; persist(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      });
      composer.append(input);
      const buttons = el('div', undefined, 'actions');
      buttons.append(button(S(sending ? 'chat.sending' : 'chat.send'), () => submit(), !model.canSend || sending),
        button(S('chat.explain'), () => send({ type: 'explain' }), !model.canSend || sending));
      if (model.canFallback && model.header.statusKind === 'failed') buttons.append(button(S('chat.fallback'), () => {
        if (!drafts[model.taskId]) drafts[model.taskId] = model.messages.filter((m) => m.role === 'user').at(-1)?.text || '';
        submit(true);
      }, !model.canSend || sending));
      if (model.manual && model.manual.tracked) {
        buttons.append(
          titled(button(S('m.check'), () => sendManual('check'), !model.canSend || sending), S('m.checkTip')),
          titled(button(S('m.continue'), () => sendManual('continue'), !model.canSend || sending), S('m.continueTip')),
        );
      }
      if (model.manual && model.manual.validating) composer.append(el('p', S('m.validating'), 'muted'));
      if (model.manual && model.manual.last) composer.append(el('pre', model.manual.last.text, model.manual.last.ok ? 'muted' : 'error'));
      composer.append(buttons);
      main.append(composer);
    }
    app.append(list, main);
    if (focused) {
      const input = document.getElementById('message');
      input?.focus();
      if (selection) input?.setSelectionRange(...selection);
    }
    if (bottom || lastTask !== model.taskId) messages.scrollTop = messages.scrollHeight;
    else messages.scrollTop = scroll;
    lastTask = model.taskId;
  }
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'state') { model = data.model; persist(); render(); }
    else if (data?.type === 'sent') {
      sending = false;
      if (data.sent) {
        if (pending?.taskId === data.taskId && (drafts[data.taskId] || '').trim() === pending.text) drafts[data.taskId] = '';
        errors[data.taskId] = '';
      }
      pending = undefined;
      persist(); render();
    } else if (data?.type === 'regenerated') {
      drafts[data.taskId] = '';
      persist(); render();
    } else if (data?.type === 'error') { sending = false; pending = undefined; errors[data.taskId] = data.message; render(); }
  });
  send({ type: 'ready', taskId: saved.selectedTaskId });
})();
