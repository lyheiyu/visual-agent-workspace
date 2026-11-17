import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentLauncher } from '../agents/AgentLauncher';
import { HumanControlManager } from '../control/HumanControlManager';
import { buildActivityViewModel } from './viewModel';
import { conversation } from '../recorder/conversation';
import { resolveStrings } from '../i18n/i18n';

/** Main conversation workspace. The audit sidebar remains available alongside it. */
export class ConversationPanel implements vscode.Disposable {
  private static current: ConversationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private taskId?: string;
  private sending = false;
  private timer?: NodeJS.Timeout;

  static async show(uri: vscode.Uri, recorder: EventRecorder, controller: AgentController, launcher: AgentLauncher, controls: HumanControlManager, taskId?: string): Promise<void> {
    if (!this.current) this.current = new ConversationPanel(uri, recorder, controller, launcher, controls);
    if (taskId && recorder.getTask(taskId)) {
      this.current.taskId = taskId;
      controls.selectTask(taskId);
    }
    this.current.panel.reveal(vscode.ViewColumn.Active);
    this.current.post();
    await this.current.revealProject();
  }

  private constructor(uri: vscode.Uri, private readonly recorder: EventRecorder, private readonly controller: AgentController, private readonly launcher: AgentLauncher, private readonly controls: HumanControlManager) {
    const media = vscode.Uri.joinPath(uri, 'media');
    this.panel = vscode.window.createWebviewPanel('visualAgent.conversations', '会话 / Conversations', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    w.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.css'))}"></head><body><div id="app"></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.js'))}"></script></body></html>`;
    this.subscriptions.push(w.onDidReceiveMessage((m) => void this.onMessage(m)), this.panel.onDidDispose(() => this.dispose()), controls.onDidChangeView(() => this.schedule()));
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
      header: model.header, messages: task ? conversation(task, this.recorder.getOperations(task.taskId)) : [], turns: task?.turns ?? [],
      approvals: live ? model.operations.filter((op) => op.awaitingApproval) : [],
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
      } else if (m.type === 'action' && ['approve', 'reject', 'review', 'stop', 'endSession'].includes(m.action)) {
        const snapshot = this.controller.getSnapshot();
        if (snapshot.taskId !== this.taskId) return;
        if (m.operationId && this.recorder.getOperation(m.operationId)?.taskId !== this.taskId) return;
        this.controls.selectTask(this.taskId!);
        await this.controls.runAction(m.action, m.operationId);
      } else if (m.type === 'explain') {
        await vscode.commands.executeCommand('visualAgent.explainInConversation', this.taskId);
      } else if (m.type === 'configure' && this.taskId) {
        await vscode.commands.executeCommand('visualAgent.continueHistory', this.taskId);
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
