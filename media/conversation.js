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
    if (!model.taskId) messages.append(el('p', S('chat.empty'), 'muted'));
    for (const message of model.messages) {
      const item = el('article', undefined, 'message ' + message.role);
      item.append(el('strong', S(message.role === 'user' ? 'a.you' : 'a.assistant')), el('pre', message.text), el('small', new Date(message.timestamp).toLocaleString()));
      messages.append(item);
    }
    if (model.turns.length) {
      messages.append(el('h3', S('chat.turns')));
      for (const turn of model.turns) {
        const item = el('details', undefined, 'turn' + (turn.failedOperations ? ' failed' : ''));
        item.open = turn === model.turns[model.turns.length - 1];
        item.append(el('summary', `#${turn.number} · ${S(turn.failedOperations ? 'chat.turnFailed' : 'status.' + turn.status)}`));
        if (turn.report) item.append(el('pre', turn.report));
        messages.append(item);
      }
    }
    for (const approval of model.approvals) {
      const item = el('article', undefined, 'approval');
      item.append(el('strong', S('a.approvalNeeded')), el('p', approval.description),
        button(S('a.reviewDiff'), () => send({ type: 'action', action: 'review', operationId: approval.id })),
        button(S('a.approve'), () => send({ type: 'action', action: 'approve', operationId: approval.id })),
        button(S('a.reject'), () => send({ type: 'action', action: 'reject', operationId: approval.id })));
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
    } else if (data?.type === 'error') { sending = false; pending = undefined; errors[data.taskId] = data.message; render(); }
  });
  send({ type: 'ready', taskId: saved.selectedTaskId });
})();
