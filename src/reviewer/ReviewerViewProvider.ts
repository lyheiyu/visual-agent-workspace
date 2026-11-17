import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ReviewerController } from './ReviewerController';
import { ReviewService } from './ReviewService';
import { normalizeLanguage, resolveStrings, UiLanguage } from '../i18n/i18n';

const ACTIONS: Record<string, string> = {
  explain: 'visualAgent.reviewer.explainFunction',
  review: 'visualAgent.reviewer.reviewChange',
  impact: 'visualAgent.reviewer.impactAnalysis',
  error: 'visualAgent.reviewer.explainError',
};

/**
 * "Local AI Reviewer" sidebar panel. Pure renderer of ReviewService state.
 * Model discovery (GET /api/tags) happens only when this panel is first shown
 * or on Refresh — never at activation — and never when the reviewer is disabled.
 */
export class ReviewerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'visualAgent.reviewer';
  private view: vscode.WebviewView | undefined;
  private discovered = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: ReviewService,
    private readonly controller: ReviewerController,
    private readonly enabled: () => boolean,
    private readonly selectionLabel: () => string | undefined,
    private readonly language: () => UiLanguage,
    private readonly setLanguage: (lang: UiLanguage) => Thenable<void>,
  ) {
    const sub = service.onDidChange(() => this.post());
    this.disposables.push({ dispose: () => sub.dispose() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';`;
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'activity.css'))}">
<link rel="stylesheet" href="${view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'reviewer.css'))}">
<title>Local AI Reviewer</title></head>
<body><div id="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'reviewer.js'))}"></script></body></html>`;
    this.disposables.push(
      view.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      view.onDidChangeVisibility(() => view.visible && this.onShown()),
    );
    this.onShown();
  }

  /** Re-render (e.g. selection or settings changed). */
  refresh(): void {
    this.post();
  }

  resetDiscovery(): void {
    this.discovered = false;
    if (this.view?.visible) {
      this.onShown();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private onShown(): void {
    if (!this.discovered && this.enabled()) {
      this.discovered = true;
      void this.service.refreshModels();
    }
    this.post();
  }

  private post(): void {
    if (!this.view) {
      return;
    }
    const s = this.service.getState();
    const trim = (t: string) => (t.length > 60_000 ? '…' + t.slice(-60_000) : t);
    const lang = this.language();
    void this.view.webview.postMessage({
      type: 'state',
      model: {
        language: lang,
        strings: resolveStrings(lang),
        errorKey: errorKey(s.error),
        enabled: this.enabled(),
        connection: s.connection,
        endpoint: s.endpoint,
        error: s.error,
        models: s.models.map((m) => ({ name: m.name, detail: [m.parameterSize, m.quantization].filter(Boolean).join(' · ') })),
        selectedModel: s.selectedModel,
        busy: s.busy,
        selection: this.selectionLabel(),
        current: s.current && {
          id: s.current.id,
          title: s.current.title,
          model: s.current.model,
          status: s.current.status,
          cached: s.current.cached,
          text: trim(s.current.text),
          thinking: trim(s.current.thinking),
          error: s.current.error,
          durationMs: s.current.durationMs,
          truncated: s.current.truncated,
          language: s.current.language,
          view: s.current.view,
          translations: Object.fromEntries(
            Object.entries(s.current.translations).map(([k, v]) => [
              k,
              { status: v!.status, text: trim(v!.text), model: v!.model, cached: v!.cached, codeSpansPreserved: v!.codeSpansPreserved },
            ]),
          ),
        },
        history: s.history.slice(0, 10).map((h) => ({ id: h.id, title: h.title, model: h.model, status: h.status })),
      },
    });
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as Record<string, unknown>;
    const id = typeof m.id === 'string' && /^[\w-]{1,64}$/.test(m.id) ? m.id : undefined;
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'refresh':
        void this.service.refreshModels();
        return;
      case 'selectModel':
        if (typeof m.name === 'string') {
          this.service.selectModel(m.name);
        }
        return;
      case 'run':
        if (typeof m.kind === 'string' && ACTIONS[m.kind]) {
          void vscode.commands.executeCommand(ACTIONS[m.kind]);
        }
        return;
      case 'cancel':
        this.service.cancel();
        return;
      case 'copy':
        void this.controller.copyResult(id);
        return;
      case 'export':
        void this.controller.exportResult(id);
        return;
      case 'open':
        void this.controller.openResult(id, true);
        return;
      case 'setLanguage':
        void this.setLanguage(normalizeLanguage(m.value));
        return;
      case 'translate':
        if (id && (m.target === 'zh-CN' || m.target === 'en')) {
          void vscode.commands.executeCommand('visualAgent.reviewer.translateResult', id, m.target);
        }
        return;
      case 'showVersion':
        if (id && (m.view === 'original' || m.view === 'bilingual' || m.view === 'zh-CN' || m.view === 'en')) {
          this.service.showVersion(id, m.view);
        }
        return;
      case 'settings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'visualAgent.reviewer');
        return;
    }
  }
}

/** Map raw (English) client errors to a localized hint; the raw message is shown too. */
function errorKey(error: string | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  if (/Cannot reach Ollama|did not respond/.test(error)) {
    return 'err.ollamaUnreachable';
  }
  if (/no models installed/.test(error)) {
    return 'err.noModels';
  }
  if (/not installed in Ollama/.test(error)) {
    return 'err.notInstalled';
  }
  if (/not a local address|Invalid Ollama endpoint|Unsupported protocol|Credentials/.test(error)) {
    return 'err.endpoint';
  }
  return undefined;
}
