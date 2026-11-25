// @ts-check
(function () {
  // @ts-ignore supplied by VS Code
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const drafts = saved.drafts || {};
  /** <details> the user toggled (turn reports, full commands) keep their state across re-renders. */
  const opened = saved.opened || {};
  /** Decisions clicked but not yet reflected in the state (their buttons stay disabled). */
  const inflight = {};
  function remember(d, key, dflt) {
    d.open = key in opened ? opened[key] : dflt;
    d.addEventListener('toggle', () => { if (d.isConnected) { opened[key] = d.open; persist(); } });
    return d;
  }
  /** When each pending approval was first shown: a card that just appeared ignores clicks briefly (no double click into the next proposal). */
  const shownAt = {};
  const ARM_MS = 700;
  // Also right after any decision here: the next card can move under the mouse (layout shift) and must not take the second click.
  let lastDecisionAt = 0;
  const armed = (id) => Date.now() - (shownAt[id] || 0) >= ARM_MS && Date.now() - lastDecisionAt >= ARM_MS;
  function decide(message) {
    const id = message.operationId;
    if (!armed(id)) return;
    if (inflight[id] && Date.now() - inflight[id] < 4000) return;
    inflight[id] = Date.now();
    lastDecisionAt = Date.now();
    setTimeout(render, ARM_MS + 20);
    setTimeout(render, 4020); // if the decision did not go through (e.g. a dialog was cancelled), enable the buttons again
    send(message);
    render();
  }
  const errors = {};
  const attachments = {};
  let uploading = 0;
  let model;
  let sending = false;
  let pending;
  let lastTask;
  let lastApproval;
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

  function mergeFiles(taskId, files) {
    const next = [...(attachments[taskId] || []), ...files];
    const bytes = next.reduce((total, { data }) => {
      const padding = data.endsWith('==') ? 2 : Number(data.endsWith('='));
      return total + data.length * 3 / 4 - padding;
    }, 0);
    if (next.length > 8 || bytes > 10 * 1024 * 1024) { errors[taskId] = '附件最多8个，总共最多10MB。'; }
    else { attachments[taskId] = next; errors[taskId] = ''; }
    render();
  }
  async function addFiles(files) {
    const taskId = model.taskId;
    if (!model.canSend || sending || !files.length) return;
    uploading++; render();
    try {
      if (files.length > 8) throw Error('最多上传8个附件。');
      const result = [];
      for (const file of Array.from(files)) {
        if (file.size > 5 * 1024 * 1024) throw Error('单个附件不能超过5MB。');
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('无法读取文件')); reader.readAsDataURL(file); });
        result.push({ name: file.name, mime: file.type, data });
      }
      mergeFiles(taskId, result);
    } catch (error) { errors[taskId] = error.message; }
    finally { uploading--; render(); }
  }
  function persist() { vscode.setState({ drafts, opened, selectedTaskId: model?.taskId }); }
  function submit(useSavedContext = false) {
    if (!model?.canSend || sending) return;
    const text = (drafts[model.taskId] || '').trim();
    if (!text && !(attachments[model.taskId] || []).length) return;
    if (uploading) return;
    sending = true;
    pending = { taskId: model.taskId, text };
    errors[model.taskId] = '';
    send({ type: 'send', taskId: model.taskId, text, useSavedContext, attachments: attachments[model.taskId] || [] });
    render();
  }
  function render() {
    if (!model || !app) return;
    const oldScroll = document.getElementById('messages');
    const scroll = oldScroll?.scrollTop || 0;
    const bottom = !oldScroll || oldScroll.scrollHeight - scroll - oldScroll.clientHeight < 80;
    const focused = document.activeElement?.id === 'message';
    const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    for (const id of Object.keys(inflight)) if (!(model.approvals || []).some((a) => a.id === id) || Date.now() - inflight[id] > 4000) delete inflight[id];
    for (const a of model.approvals || []) if (!shownAt[a.id]) { shownAt[a.id] = Date.now(); setTimeout(render, ARM_MS + 20); }
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
    const desc = titled(el('div', model.header.taskDescription || S('chat.empty'), 'clamp'), model.header.taskDescription || '');
    header.append(el('strong', model.header.statusLabel, 'status ' + model.header.statusKind), desc, el('small', model.header.workspaceRoot || ''));
    if (model.taskId) header.append(el('small', S('chat.' + model.mode)));
    if (model.recovered) header.append(el('small', S('chat.recovered'), 'warn'));
    if (model.selectedModel) header.append(el('small', model.selectedModel));
    if (model.profile) header.append(el('small', S(model.profile)));
    const actions = el('div', undefined, 'actions');
    if (model.header.workspaceRoot) actions.append(button(S('chat.project'), () => send({ type: 'project' })));
    if (model.reviewerEnabled && model.hasLocalOperations) actions.append(button(S('chat.localOperations'), () => send({ type: 'localOperation' })));
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
        remember(item, 'turn:' + model.taskId + ':' + turn.number, turn === model.turns[model.turns.length - 1]);
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
      if (approval === model.approvals[0]) item.id = 'first-approval';
      const title = el('p');
      title.append(el('span', approval.cmd ? approval.cmd.summary : approval.description));
      if (approval.cmd && approval.cmd.writes) {
        const pill = el('span', S('c.writes'), 'pill writes');
        pill.title = S('c.heuristicTip') + ': ' + approval.cmd.writeReasons.join('; ');
        title.append(' ', pill);
      }
      item.append(el('strong', S('a.approvalNeeded')), title);
      if (approval.command && !(approval.cmd && approval.cmd.writes)) item.append(el('p', S(approval.cmd && approval.cmd.mayGenerate ? 'c.mayGenerate' : 'c.noWriteDetected'), 'muted'));
      if (approval.command) {
        const d = el('details');
        d.append(el('summary', S(approval.cmd && approval.cmd.embeddedCode ? 'c.fullCommandCode' : 'c.fullCommand')), el('pre', approval.command));
        remember(d, 'cmd:' + approval.id, !(approval.cmd && (approval.cmd.long || approval.cmd.embeddedCode)));
        item.append(d);
      }
      if (approval.conflict) item.append(el('p', S('p.conflict').replace('{what}', approval.conflict), 'error'));
      const edit = approval.editing && approval.edit;
      if (edit && edit.multi) {
        // Multi-file edit before applying: one row per file; switching keeps edits; reset per file.
        item.append(el('p', S('p.filesEditing').replace('{n}', String(edit.files.length)), 'muted'));
        const list = el('ul', undefined, 'edit-files');
        list.setAttribute('role', 'list');
        for (const f of edit.files) {
          const li = el('li', undefined, 'edit-file' + (f.active ? ' active' : '') + (f.edited ? ' edited' : ''));
          const open = button(f.rel, () => send({ type: 'editFile', operationId: approval.id, index: f.index }));
          open.className = 'file-link';
          if (f.active) open.setAttribute('aria-current', 'true');
          if (f.excluded) {
            li.className += ' excluded';
            li.append(open, el('span', ' ' + S('p.fileKept'), 'muted'), ' ', button(S('p.deleteAgain'), () => send({ type: 'excludeDeletion', operationId: approval.id, index: f.index, excluded: false })));
            list.append(li);
            continue;
          }
          if (f.kind === 'delete') li.className += ' delete';
          const kind = f.kind === 'add' ? S('p.fileNew') + ' · ' : f.kind === 'delete' ? S('p.fileDeleted') + ' · ' : '';
          li.append(open, el('span', ' ' + kind + (f.kind === 'delete' ? '' : S(f.edited ? 'p.fileEdited' : 'p.fileProposed') + ' · ') + `+${f.added} −${f.removed}`, 'muted'));
          if (f.kind === 'delete') li.append(' ', titled(button(S('p.keepFile'), () => send({ type: 'excludeDeletion', operationId: approval.id, index: f.index, excluded: true })), S('p.keepFileTip')));
          else if (f.edited) li.append(' ', button(S('p.resetFile'), () => send({ type: 'resetEditFile', operationId: approval.id, index: f.index })));
          list.append(li);
        }
        item.append(list);
        if (!edit.previewed) item.append(el('p', S('p.previewBeforeApply'), 'muted'));
      }
      const row = el('div', undefined, 'actions');
      const feedback = () => (drafts[model.taskId] || '').trim();
      const editable = approval.hasChange && approval.type === 'Edit';
      const busy = !!inflight[approval.id] || !armed(approval.id);
      // While you edit your own version, approving the agent's version would discard it: Apply / Cancel instead.
      row.append(
        approval.hasChange && !approval.editing ? button(S('a.reviewDiff'), () => send({ type: 'action', action: 'review', operationId: approval.id })) : '',
        model.reviewerEnabled && approval.hasChange ? button(S('chat.explainDiff'), () => send({ type: 'localOperation', action: 'explainDiff', operationId: approval.id })) : '',
        model.reviewerEnabled && approval.command ? button(S('c.explain'), () => send({ type: 'localOperation', action: 'explainCommand', operationId: approval.id })) : '',
        !approval.editing ? button(S('a.approve'), () => decide({ type: 'action', action: 'approve', operationId: approval.id }), !!approval.conflict || busy) : '',
        button(S('a.reject'), () => decide({ type: 'action', action: 'reject', operationId: approval.id }), busy),
        edit && edit.multi ? button(S('p.previewAll'), () => send({ type: 'action', action: 'previewEdited', operationId: approval.id })) : '',
        editable ? button(approval.editing ? (edit && edit.multi ? S('p.applyMineN').replace('{n}', String(edit.files.length)) : S('p.applyMine')) : S('p.editFirst'), () => send({ type: 'action', action: approval.editing ? 'applyEdited' : 'editProposal', operationId: approval.id })) : '',
        editable && approval.editing ? button(S('p.cancelEdit'), () => send({ type: 'action', action: 'cancelEdit', operationId: approval.id })) : '',
        button(S('p.regenerate'), () => decide({ type: 'regenerate', operationId: approval.id, feedback: feedback() }), busy),
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
      composer.append(el('small', '拖拽文件、图片到这里，或点击添加附件。文本≤100KB，图片≤5MB；最多8个，总计10MB。PDF/Office请先转为文本。未发送的附件关闭窗口后需重新添加。'));
      main.addEventListener('dragover', (e) => { e.preventDefault(); });
      main.addEventListener('drop', (e) => { e.preventDefault(); if (model.canSend && !sending) { if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); else { const uris = e.dataTransfer.getData('text/uri-list').split(/\r?\n/).filter((u) => u && !u.startsWith('#')); if (uris.length) send({ type: 'dropAttachments', taskId: model.taskId, uris }); } } });
      input.addEventListener('paste', (e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
      const tray = el('div', undefined, 'attachment-tray');
      for (const [index, file] of (attachments[model.taskId] || []).entries()) {
        const chip = el('div', undefined, 'attachment');
        if (file.mime?.startsWith('image/')) { const img = el('img'); img.src = 'data:' + file.mime + ';base64,' + file.data; img.alt = file.name; chip.append(img); }
        chip.append(el('span', file.name), button('×', () => { attachments[model.taskId].splice(index, 1); render(); }, sending)); tray.append(chip);
      }
      if (uploading) tray.append(el('span', '正在读取附件…'));
      composer.append(tray);
      const buttons = el('div', undefined, 'actions');
      buttons.append(button('＋ 添加附件 / Attach', () => send({ type: 'pickAttachments', taskId: model.taskId }), !model.canSend || sending));
      buttons.append(button(S(sending ? 'chat.sending' : 'chat.send'), () => submit(), !model.canSend || sending || uploading > 0));
      if (model.reviewerEnabled) buttons.append(
        button(S('chat.explain'), () => send({ type: 'explain' })),
        button(S('r.impact'), () => send({ type: 'explain', impact: true })),
      );
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
    // A new pending approval is brought into view once laid out (e.g. after the panel was narrowed by a file opened beside it).
    const firstApproval = model.approvals[0] && model.approvals[0].id;
    // Only when a new card arrives: re-scrolling on every update would move buttons under the mouse.
    if (firstApproval && firstApproval !== lastApproval) {
      const card = document.getElementById('first-approval');
      if (card && card.scrollIntoView) (window.requestAnimationFrame || ((f) => f()))(() => card.scrollIntoView({ block: 'nearest' }));
    }
    lastApproval = firstApproval;
    lastTask = model.taskId;
  }
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'attachments') { mergeFiles(data.taskId, data.attachments); }
    else if (data?.type === 'state') { model = data.model; persist(); render(); }
    else if (data?.type === 'sent') {
      sending = false;
      if (data.sent) {
        attachments[data.taskId] = [];
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
