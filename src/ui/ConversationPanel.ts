import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentLauncher } from '../agents/AgentLauncher';
import { HumanControlManager } from '../control/HumanControlManager';
import { buildActivityViewModel } from './viewModel';
import { conversation } from '../recorder/conversation';
import { resolveStrings } from '../i18n/i18n';
import { ReferenceNavigator } from '../references/ReferenceNavigator';
import { ManualChanges } from '../review/ManualChanges';
import { Block, parseMarkdown, parsePlain } from '../references/markdown';

/** Parsed message ASTs, keyed by role + text (messages are immutable once recorded). */
const astCache = new Map<string, Block[]>();
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
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
    void this.panel.webview.postMessage({ type: 'state', model: {
      strings: resolveStrings(this.controls.language()), taskId: this.taskId,
      tasks: tasks.map((t) => ({ taskId: t.taskId, title: t.description.slice(0, 100), project: t.workspaceRoot ?? t.launch?.workspaceRoot, model: t.launch?.model ?? t.adapterName, date: new Date(t.startedAt).toLocaleString(), status: t.taskId === snapshot.taskId && snapshot.awaitingInput ? 'ready' : t.status })),
      header: model.header,
      messages: task ? conversation(task, this.recorder.getOperations(task.taskId)).map((m) => ({ ...m, ast: messageAst(m.role, m.text) })) : [],
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
              command: rec?.command?.command,
            };
          })
        : [],
      // Display only: the change the model is still generating (never applied, never stored).
      preview: live ? snapshot.preview : undefined,
      manual: task ? { tracked: this.manual.tracked(task.taskId), validating: this.manual.isValidating(task.taskId), last: this.manual.lastResult(task.taskId) } : undefined,
      canSend: !!task && !this.sending && (live ? snapshot.awaitingInput && !snapshot.pendingApprovals.length : (!this.controller.isActive || canSwitch) && !!task.launch),
      canStop: live && !snapshot.awaitingInput, canEnd: live && snapshot.awaitingInput,
      mode: live ? 'live' : task?.session?.provider === 'local' ? 'native' : 'context',
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
      } else if (m.type === 'new') {
        await vscode.commands.executeCommand('visualAgent.newAgentTask');
      } else if (m.type === 'send' && typeof m.text === 'string' && m.taskId === this.taskId && !this.sending && this.taskId) {
        const taskId = this.taskId;
        this.sending = true;
        this.post();
        try {
          const sent = await this.launcher.send(taskId, m.text, m.useSavedContext === true);
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
      } else if (m.type === 'action' && ['approve', 'reject', 'review', 'stop', 'endSession', 'editProposal', 'applyEdited'].includes(m.action)) {
        const snapshot = this.controller.getSnapshot();
        if (snapshot.taskId !== this.taskId) return;
        if (m.operationId && this.recorder.getOperation(m.operationId)?.taskId !== this.taskId) return;
        this.controls.selectTask(this.taskId!);
        await this.controls.runAction(m.action, m.operationId);
      } else if (m.type === 'explain') {
        await vscode.commands.executeCommand('visualAgent.explainInConversation', this.taskId);
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

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.splice(0).forEach((s) => s.dispose());
    ConversationPanel.current = undefined;
  }
}
