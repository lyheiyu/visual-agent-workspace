import * as vscode from 'vscode';
import { attachmentMime, validateAttachments } from '../agents/attachments';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentLauncher } from '../agents/AgentLauncher';
import { HumanControlManager } from '../control/HumanControlManager';
import { buildActivityViewModel } from './viewModel';
import { conversation } from '../recorder/conversation';
import { resolveStrings, t } from '../i18n/i18n';
import { isFailedCommand } from '../reviewer/ReviewerController';
import { ReferenceNavigator } from '../references/ReferenceNavigator';
import { ManualChanges } from '../review/ManualChanges';
import { Block, parseMarkdown, parsePlain } from '../references/markdown';

/** Parsed message ASTs, keyed by role + text (messages are immutable once recorded). */
const astCache = new Map<string, Block[]>();
const localActions = [
  ['explainDiff', 'chat.explainDiff'],
  ['reviewChange', 'a.aiReview'],
  ['explainCommand', 'c.explain'],
  ['explainError', 'a.aiError'],
] as const;
export function messageAst(role: string, text: string): Block[] {
  const key = role + '|' + text;
  let ast = astCache.get(key);
  if (!ast) {
    ast = role === 'assistant' ? parseMarkdown(text) : parsePlain(text);
    astCache.set(key, ast);
    if (astCache.size > 500) astCache.delete(astCache.keys().next().value!);
  }
  return ast;
}

/** Main conversation workspace. The audit sidebar remains available alongside it. */
export class ConversationPanel implements vscode.Disposable {
  private static current: ConversationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private taskId?: string;
  private sending = false;
  private timer?: NodeJS.Timeout;

  static async show(uri: vscode.Uri, recorder: EventRecorder, controller: AgentController, launcher: AgentLauncher, controls: HumanControlManager, references: ReferenceNavigator, manual: ManualChanges, taskId?: string): Promise<void> {
    if (!this.current) this.current = new ConversationPanel(uri, recorder, controller, launcher, controls, references, manual);
    if (taskId && recorder.getTask(taskId)) {
      this.current.taskId = taskId;
      controls.selectTask(taskId);
    }
    this.current.panel.reveal(vscode.ViewColumn.Active);
    this.current.post();
    await this.current.revealProject();
  }

  private constructor(uri: vscode.Uri, private readonly recorder: EventRecorder, private readonly controller: AgentController, private readonly launcher: AgentLauncher, private readonly controls: HumanControlManager, private readonly references: ReferenceNavigator, private readonly manual: ManualChanges) {
    const media = vscode.Uri.joinPath(uri, 'media');
    this.panel = vscode.window.createWebviewPanel('visualAgent.conversations', '会话 / Conversations', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    w.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.css'))}"></head><body><div id="app"></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'markdownView.js'))}"></script>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.js'))}"></script></body></html>`;
    this.subscriptions.push(w.onDidReceiveMessage((m) => void this.onMessage(m)), this.panel.onDidDispose(() => this.dispose()), controls.onDidChangeView(() => this.schedule()), manual.onDidChange(() => this.schedule()));
  }

  /** Deliver a message exactly as the webview would (integration tests drive clicks through this). */
  static async receive(message: unknown): Promise<void> {
    await this.current?.onMessage(message);
  }

  static get viewColumn(): vscode.ViewColumn | undefined {
    return this.current?.panel.viewColumn;
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => { this.timer = undefined; this.post(); }, 50);
  }

  private async revealProject(): Promise<void> {
    const task = this.taskId ? this.recorder.getTask(this.taskId) : undefined;
    const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot;
    if (!root) return;
    try { await this.launcher.showProject(root); }
    catch (error) { await this.panel.webview.postMessage({ type: 'error', taskId: this.taskId, message: (error as Error).message }); }
  }

  private post(): void {
    const tasks = this.recorder.getTasks();
    if (!tasks.some((t) => t.taskId === this.taskId)) this.taskId = tasks[0]?.taskId;
    const task = this.taskId ? this.recorder.getTask(this.taskId) : undefined;
    const snapshot = this.controller.getSnapshot();
    const model = buildActivityViewModel(this.recorder, snapshot, { selectedTaskId: this.taskId, follow: false, language: this.controls.language() });
    const live = this.controller.isActive && snapshot.taskId === this.taskId;
    const canSwitch = this.controller.isActive && !live && snapshot.awaitingInput;
    const reviewerEnabled = vscode.workspace.getConfiguration('visualAgent.reviewer').get<boolean>('enabled', true);
    const operations = task ? this.recorder.getOperations(task.taskId) : [];
    void this.panel.webview.postMessage({ type: 'state', model: {
      strings: resolveStrings(this.controls.language()), taskId: this.taskId,
      tasks: tasks.map((t) => ({ taskId: t.taskId, title: t.description.slice(0, 100), project: t.workspaceRoot ?? t.launch?.workspaceRoot, model: t.launch?.model ?? t.adapterName, date: new Date(t.startedAt).toLocaleString(), status: t.taskId === snapshot.taskId && snapshot.awaitingInput ? 'ready' : t.status })),
      header: model.header, reviewerEnabled,
      hasLocalOperations: reviewerEnabled && operations.some((op) => op.command || op.associatedChangeId || op.associatedChangeIds?.length),
      messages: task ? conversation(task, operations).map((m) => ({ ...m, ast: messageAst(m.role, m.text) })) : [],
      turns: (task?.turns ?? []).map((t) => ({ ...t, ast: t.report ? messageAst('report', t.report) : undefined })),
      approvals: live
        ? model.operations.filter((op) => op.awaitingApproval).map((op) => {
            const rec = this.recorder.getOperation(op.id);
            const conflict = this.controls.proposals.conflictFor(op.id);
            return {
              ...op,
              hasChange: !!(rec?.associatedChangeId || rec?.associatedChangeIds?.length),
              conflict: conflict && !conflict.ok ? this.controls.proposals.describe(conflict) : undefined,
              editing: this.controls.proposals.isEditing(op.id),
              edit: this.controls.proposals.editState(op.id),
              fileCount: rec?.associatedChangeIds?.length ?? (rec?.associatedChangeId ? 1 : 0),
              command: rec?.command?.command,
            };
          })
        : [],
      // Display only: the change the model is still generating (never applied, never stored).
      preview: live ? snapshot.preview : undefined,
      manual: task ? { tracked: this.manual.tracked(task.taskId), validating: this.manual.isValidating(task.taskId), last: this.manual.lastResult(task.taskId) } : undefined,
      canSend: !!task && !this.sending && (live ? snapshot.awaitingInput && !snapshot.pendingApprovals.length : (!this.controller.isActive || canSwitch) && !!task.launch),
      canStop: live && !snapshot.awaitingInput, canEnd: live && snapshot.awaitingInput,
      mode: live ? 'live' : task?.session && task.session.provider === task.launch?.provider ? 'native' : 'context',
      // Minimal continuity status: only shown when the agent did NOT get its native session back.
      recovered: task?.session?.continuity === 'reconstructed',
      blocked: this.controller.isActive ? live ? snapshot.awaitingInput ? '' : 'chat.busy' : canSwitch ? '' : 'chat.other' : '',
      canFallback: !!task?.session && !this.controller.isActive,
      needsConfiguration: !!task && !task.launch,
      selectedModel: task?.launch?.model,
      profile: task?.launch ? ['approved-write', 'approve-edits'].includes(task.launch.profile) ? 'chat.approvedWrites' : 'chat.readOnly' : undefined,
    } });
  }

  private async onMessage(m: any): Promise<void> {
    if (!m || typeof m !== 'object') return;
    try {
      if (m.type === 'ready') {
        if (typeof m.taskId === 'string' && this.recorder.getTask(m.taskId) && !this.taskId) this.taskId = m.taskId;
        this.post();
      } else if (m.type === 'select' && typeof m.taskId === 'string' && this.recorder.getTask(m.taskId)) {
        this.taskId = m.taskId;
        this.controls.selectTask(m.taskId);
        this.post();
        await this.revealProject();
      } else if ((m.type === 'pickAttachments' || m.type === 'dropAttachments') && m.taskId === this.taskId) {
        if (m.type === 'dropAttachments' && (!Array.isArray(m.uris) || m.uris.length > 8 || m.uris.some((u: unknown) => typeof u !== 'string' || u.length > 8192 || vscode.Uri.parse(u).scheme !== 'file'))) throw new Error('只能拖入本地文件。');
        const uris: vscode.Uri[] | undefined = m.type === 'dropAttachments' ? m.uris.map((u: string) => vscode.Uri.parse(u)) : await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, title: '添加附件 / Add attachments' });
        if (!uris) return;
        const attachments = [];
        if (uris.length > 8) throw new Error('最多选择 8 个附件。');
        for (const uri of uris) {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File || stat.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5MB 的文件。');
          const name = path.basename(uri.fsPath);
          const mime = attachmentMime(name);
          attachments.push({ name, mime, data: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64') });
        }
        await this.panel.webview.postMessage({ type: 'attachments', taskId: m.taskId, attachments: validateAttachments(attachments) });
      } else if (m.type === 'new') {
        await vscode.commands.executeCommand('visualAgent.newAgentTask');
      } else if (m.type === 'send' && typeof m.text === 'string' && m.taskId === this.taskId && !this.sending && this.taskId) {
        const taskId = this.taskId;
        this.sending = true;
        this.post();
        try {
          const sent = await this.launcher.send(taskId, m.text, m.useSavedContext === true, validateAttachments(m.attachments));
          await this.panel.webview.postMessage({ type: 'sent', taskId, sent });
        } finally { this.sending = false; this.post(); }
      } else if (m.type === 'regenerate' && typeof m.operationId === 'string' && this.recorder.getOperation(m.operationId)?.taskId === this.taskId) {
        await this.controls.proposals.regenerate(m.operationId, typeof m.feedback === 'string' ? m.feedback.slice(0, 2000) : undefined);
        await this.panel.webview.postMessage({ type: 'regenerated', taskId: this.taskId });
      } else if (m.type === 'manual' && (m.kind === 'check' || m.kind === 'continue') && this.taskId && !this.sending) {
        const taskId = this.taskId;
        this.sending = true;
        this.post();
        try {
          const r = m.kind === 'check' ? await this.manual.check(taskId) : await this.manual.continueFrom(taskId, typeof m.text === 'string' ? m.text : undefined);
          if (!r.sent && r.reason) await this.panel.webview.postMessage({ type: 'error', taskId, message: r.reason });
          else await this.panel.webview.postMessage({ type: 'sent', taskId, sent: r.sent, clearDraft: m.kind === 'continue' });
        } finally { this.sending = false; this.post(); }
      } else if ((m.type === 'editFile' || m.type === 'resetEditFile') && typeof m.operationId === 'string' && Number.isInteger(m.index) && m.index >= 0 && m.index < 1000 && this.recorder.getOperation(m.operationId)?.taskId === this.taskId) {
        // Switch to / reset one file of a multi-file proposal being edited. Only touches the editable copies.
        if (m.type === 'editFile') await this.controls.proposals.editBeforeApplying(m.operationId, m.index);
        else await this.controls.proposals.resetEditFile(m.operationId, m.index);
      } else if (m.type === 'excludeDeletion' && typeof m.operationId === 'string' && typeof m.excluded === 'boolean' && Number.isInteger(m.index) && m.index >= 0 && m.index < 1000 && this.recorder.getOperation(m.operationId)?.taskId === this.taskId) {
        // Keep a file the agent proposed to delete (or re-include the deletion). Nothing is written here.
        await this.controls.proposals.setDeletionExcluded(m.operationId, m.index, m.excluded);
      } else if (m.type === 'action' && ['approve', 'reject', 'review', 'stop', 'endSession', 'editProposal', 'applyEdited', 'previewEdited', 'cancelEdit'].includes(m.action)) {
        const snapshot = this.controller.getSnapshot();
        if (snapshot.taskId !== this.taskId) return;
        if (m.operationId && this.recorder.getOperation(m.operationId)?.taskId !== this.taskId) return;
        this.controls.selectTask(this.taskId!);
        await this.controls.runAction(m.action, m.operationId);
      } else if (m.type === 'explain' || m.type === 'localOperation') {
        if (!this.taskId || !vscode.workspace.getConfiguration('visualAgent.reviewer').get<boolean>('enabled', true)) return;
        if (m.type === 'explain') {
          await vscode.commands.executeCommand('visualAgent.explainInConversation', this.taskId, m.impact === true);
        } else {
          await this.runLocalOperation(this.taskId, m.operationId, m.action);
        }
      } else if (m.type === 'configure' && this.taskId) {
        await vscode.commands.executeCommand('visualAgent.continueHistory', this.taskId);
      } else if (m.type === 'openReference') {
        // Validated again by ReferenceNavigator; the only effect is opening a text editor.
        const result = await this.references.open(m.ref, { side: m.side === true, taskId: this.taskId, keepVisible: this.panel.viewColumn, quiet: true });
        if (!result.ok && !result.cancelled) await this.panel.webview.postMessage({ type: 'error', taskId: this.taskId, message: result.reason });
      } else if (m.type === 'openLink') {
        await this.references.openLink(m.href);
      } else if (m.type === 'project') {
        await this.revealProject();
      }
    } catch (err) {
      await this.panel.webview.postMessage({ type: 'error', taskId: this.taskId, message: (err as Error).message });
    }
  }

  private async runLocalOperation(taskId: string, operationId: unknown, action: unknown): Promise<void> {
    const operations = this.recorder.getOperations(taskId);
    const items = operations.slice().reverse().flatMap((op) => {
      if (operationId !== undefined && op.operationId !== operationId) return [];
      const hasChange = !!(op.associatedChangeId || op.associatedChangeIds?.length);
      const available = [hasChange, hasChange, !!op.command, isFailedCommand(op)];
      return localActions.filter(([id], index) => available[index] && (action === undefined || action === id)).map(([id, label]) => ({
        id,
        operationId: op.operationId,
        label: t(label, this.controls.language()),
        description: `#${op.sequenceNumber} ${op.description.slice(0, 120)}`,
      }));
    });
    const selected = operationId !== undefined && action !== undefined
      ? items[0]
      : await vscode.window.showQuickPick(items, { title: t('chat.localOperations', this.controls.language()) });
    if (selected && taskId === this.taskId) {
      await vscode.commands.executeCommand(`visualAgent.reviewer.${selected.id}`, selected.operationId);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.splice(0).forEach((s) => s.dispose());
    ConversationPanel.current = undefined;
  }
}
