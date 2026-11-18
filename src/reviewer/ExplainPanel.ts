import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { resolveStrings, UiLanguage } from '../i18n/i18n';
import { Block, parseInline, parseMarkdown, textOf } from '../references/markdown';
import type { ExplainController } from './ExplainController';
import type { ReviewerController } from './ReviewerController';
import { ExplainMode, ExplanationPart, ExplanationRecord, formatSpan, parseSections, scopeText } from './explainCode';

const astCache = new Map<string, Block[]>();
function ast(text: string, relPath: string): Block[] {
  const key = relPath + '|' + text;
  let a = astCache.get(key);
  if (!a) {
    a = parseMarkdown(text, { lineRefsFor: relPath });
    astCache.set(key, a);
    if (astCache.size > 400) astCache.delete(astCache.keys().next().value!);
  }
  return a;
}

/**
 * "Explain Code in Detail" panel. Renders ExplainController state; every
 * message from the webview is validated and mapped to a fixed action.
 * Opens beside the source editor so both stay visible.
 */
export class ExplainPanel implements vscode.Disposable {
  static readonly viewType = 'visualAgent.explanation';
  private static instance: ExplainPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pendingMode: ExplainMode | undefined;

  static show(extensionUri: vscode.Uri, controller: ExplainController, reviewer: ReviewerController, language: () => UiLanguage): ExplainPanel {
    if (!this.instance) this.instance = new ExplainPanel(extensionUri, controller, reviewer, language);
    else this.instance.panel.reveal(undefined, true);
    return this.instance;
  }

  static get current(): ExplainPanel | undefined {
    return this.instance;
  }

  /** Deliver a message exactly as the webview would (integration tests). */
  static async receive(message: unknown): Promise<void> {
    await this.instance?.onMessage(message);
  }

  /** Last state posted to the webview (integration tests). */
  lastState: any;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly controller: ExplainController,
    private readonly reviewer: ReviewerController,
    private readonly language: () => UiLanguage,
  ) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(ExplainPanel.viewType, '详细解释 / Explanation', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    w.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'conversation.css'))}">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, 'explain.css'))}"></head><body><div id="app"></div>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'markdownView.js'))}"></script>
<script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, 'explain.js'))}"></script></body></html>`;
    this.disposables.push(w.onDidReceiveMessage((m) => void this.onMessage(m)), this.panel.onDidDispose(() => this.dispose()));
    if (reviewer.service.getState().connection === 'unknown') void reviewer.service.refreshModels(); // GET /api/tags only, no inference
  }

  get column(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  /** Coalesced re-render; `pendingMode` = mode chosen in the selector that has no result yet. */
  update(pendingMode?: ExplainMode): void {
    if (pendingMode !== undefined) this.pendingMode = pendingMode;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.post();
    }, 60);
  }

  private post(): void {
    const r = this.controller.current();
    if (r && this.pendingMode === r.mode) this.pendingMode = undefined;
    const s = this.reviewer.service.getState();
    const lang = this.language();
    if (r) this.panel.title = `${r.mode === 'structured' ? '详解' : '逐行'}: ${r.file.relPath.split(/[\\/]/).pop()}`;
    const model = {
      strings: resolveStrings(lang),
      connection: s.connection,
      error: s.error,
      models: s.models.map((m) => m.name),
      selectedModel: s.selectedModel,
      busy: this.controller.isRunning() || s.busy,
      running: this.controller.isRunning(),
      mode: this.pendingMode ?? r?.mode ?? 'structured',
      needsRun: !!this.pendingMode && this.pendingMode !== r?.mode,
      record: r && this.serialize(r),
      history: this.controller.history().map((h) => ({ id: h.id, label: `${h.file.relPath} · ${scopeText(h)} · ${h.mode === 'structured' ? 'structured' : 'line-by-line'} · ${h.status}` })),
    };
    this.lastState = model;
    void this.panel.webview.postMessage({ type: 'state', model });
  }

  private serialize(r: ExplanationRecord) {
    const part = (p: ExplanationPart) => {
      const span = p.chunk.index < 0 ? r.plan.requested : p.chunk;
      const sections = p.status === 'done' ? p.sections : parseSections(p.text, span);
      return {
        index: p.chunk.index,
        startLine: p.chunk.startLine,
        endLine: p.chunk.endLine,
        context: p.chunk.context,
        status: p.status,
        error: p.error,
        cached: p.cached,
        durationMs: p.durationMs,
        gaps: p.gaps.map(formatSpan),
        sections: sections.map((x) => ({
          title: x.title ? textOf(parseInline(x.title)) : '',
          startLine: x.startLine,
          endLine: x.endLine,
          rangeValid: x.rangeValid,
          ast: ast(x.body.length > 60_000 ? x.body.slice(0, 60_000) + '\n…' : x.body, r.file.relPath),
        })),
      };
    };
    return {
      id: r.id,
      file: { relPath: r.file.relPath, fsPath: r.file.fsPath, languageId: r.file.languageId, version: r.file.version, hash: r.file.hash.slice(0, 12), dirty: r.file.dirty, lineCount: r.file.lineCount },
      stale: !!r.stale,
      scope: r.scope,
      scopeLabel: scopeText(r),
      target: r.target,
      mode: r.mode,
      model: r.model,
      language: r.language,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      plan: { partial: r.plan.partial, analyzed: r.plan.analyzed.map(formatSpan), omitted: r.plan.omitted.map(formatSpan), parts: r.plan.chunks.length },
      parts: r.parts.map(part),
      synthesis: r.synthesis && part(r.synthesis),
    };
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    const id = typeof m.id === 'string' && /^[\w-]{1,64}$/.test(m.id) ? m.id : undefined;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000_000 ? v : undefined);
    switch (m.type) {
      case 'ready':
        this.post();
        return;
      case 'refreshModels':
        await this.reviewer.service.refreshModels();
        return;
      case 'selectModel':
        if (typeof m.name === 'string' && !this.controller.isRunning()) this.reviewer.service.selectModel(m.name);
        this.update();
        return;
      case 'setMode':
        if (m.mode === 'structured' || m.mode === 'lineByLine') this.controller.switchMode(m.mode);
        return;
      case 'run': // explicit user click: (re-)run the current target in the selected mode
        if (m.mode === 'structured' || m.mode === 'lineByLine') await this.controller.rerun(m.mode);
        return;
      case 'cancel':
        this.controller.cancel();
        return;
      case 'explainFunction':
        if (id && !this.controller.isRunning()) await this.controller.explainFunctionOf(id, typeof m.name === 'string' ? m.name : undefined).catch((e) => vscode.window.showWarningMessage((e as Error).message));
        return;
      case 'copy':
        await this.controller.copy(id);
        return;
      case 'export':
        await this.controller.export(id);
        return;
      case 'show':
        if (id) this.controller.show(id);
        return;
      case 'gotoRange': {
        const start = int(m.startLine);
        if (id && start) await this.controller.gotoRange(id, start, int(m.endLine));
        return;
      }
      case 'openReference':
        if (id) await this.controller.openReference(id, m.ref, m.side === true);
        return;
      case 'openLink':
        await this.controller.openLink(m.href); // http(s)/mailto only, after a confirmation dialog
        return;
      default:
        return;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.splice(0).forEach((d) => d.dispose());
    this.panel.dispose();
    ExplainPanel.instance = undefined;
    this.controller.onPanelDisposed();
  }
}
