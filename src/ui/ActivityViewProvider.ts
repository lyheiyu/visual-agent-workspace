import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { HumanControlManager, ControlAction, CONTROL_ACTIONS } from '../control/HumanControlManager';

/**
 * Agent Activity sidebar (webview view).
 *
 * Security:
 * - Strict CSP: no inline script except the nonce'd bundle from /media, no
 *   remote content, no eval.
 * - The webview renders data with DOM APIs/textContent only (never innerHTML).
 * - Every inbound message is shape-checked; IDs must refer to known records.
 *
 * The view is a pure renderer of `HumanControlManager.getViewModel()`; it
 * owns no agent state.
 */
export class ActivityViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'visualAgent.activity';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private pending: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controls: HumanControlManager,
  ) {
    this.disposables.push(controls.onDidChangeView(() => this.schedulePost()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.disposables.push(
      view.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      view.onDidChangeVisibility(() => view.visible && this.post()),
      view.onDidDispose(() => (this.view = undefined)),
    );
  }

  /** Keep the observer visible in a separate editor group while Explorer is open. */
  showBeside(): void {
    if (this.panel) {
      // Already visible: just refresh. Hidden behind another tab (e.g. the conversation in the same group):
      // show it beside the active group instead of on top of what the user is looking at.
      if (!this.panel.visible) this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'visualAgent.activityObserver', 'Agent Activity',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, vscode.Uri.joinPath(this.extensionUri, 'media'));
    const messages = panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    const visibility = panel.onDidChangeViewState(() => panel.visible && this.post());
    panel.onDidDispose(() => {
      messages.dispose();
      visibility.dispose();
      if (this.panel === panel) this.panel = undefined;
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
    if (this.pending) {
      clearTimeout(this.pending);
    }
  }

  private schedulePost(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 40);
  }

  private post(): void {
    if (!this.view && !this.panel) {
      return;
    }
    const message = { type: 'state', model: this.controls.getViewModel() };
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as Record<string, unknown>;
    const id = typeof m.operationId === 'string' && /^[\w-]{1,100}$/.test(m.operationId) ? m.operationId : undefined;
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'expand':
        this.controls.setExpanded(typeof m.operationId === 'string' ? m.operationId : undefined);
        return;
      case 'select':
        if (id) {
          this.controls.selectOperation(id, { reveal: m.reveal === true });
        }
        return;
      case 'gotoFunction':
        if (id && typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 1000) {
          void this.controls.gotoAffectedFunction(id, m.index);
        }
        return;
      case 'copy':
        if (id && (m.what === 'command' || m.what === 'output')) {
          void this.controls.copyFromOperation(id, m.what);
        }
        return;
      case 'explainFunction':
        if (id && typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 1000) {
          void this.controls.explainAffectedFunction(id, m.index);
        }
        return;
      case 'selectTask':
        if (typeof m.taskId === 'string' && /^[\w-]{1,100}$/.test(m.taskId)) {
          this.controls.selectTask(m.taskId);
          void vscode.commands.executeCommand('visualAgent.openConversations', m.taskId);
        }
        return;
      case 'setLanguage':
        void this.controls.setLanguage(m.value);
        return;
      case 'setFollow':
        if (typeof m.value === 'boolean') {
          void this.controls.setFollow(m.value);
        }
        return;
      case 'action':
        if (typeof m.action === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(m.action)) {
          void this.controls.runAction(m.action as ControlAction, id);
        }
        return;
      default:
        return;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'activity.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'activity.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Agent Activity</title>
</head>
<body>
<div id="app" aria-live="polite"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
