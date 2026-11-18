import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { findCallSites, referencedModuleDefinitions } from '../analysis/staticAnalysis';
import { CodeNavigator } from '../navigation/CodeNavigator';
import { innermost, listFunctionRanges } from '../navigation/symbolSearch';
import { ReferenceNavigator } from '../references/ReferenceNavigator';
import { sanitizeReference } from '../references/codeReference';
import { localizeError, t, UiLanguage } from '../i18n/i18n';
import { ReviewerController } from './ReviewerController';
import {
  buildExplainPrompt,
  buildSynthesisPrompt,
  chunkBudget,
  ExplainMode,
  ExplainScope,
  ExplanationPart,
  ExplanationRecord,
  formatSpan,
  hashText,
  importLines,
  languageFamily,
  LineSpan,
  outline,
  parseSections,
  planChunks,
  renderExplanationMarkdown,
  scopeText,
  uncoveredCode,
} from './explainCode';
import { ExplainPanel } from './ExplainPanel';
import { findImporters } from '../analysis/staticAnalysis';

export interface ExplainArgs {
  uri?: vscode.Uri | string;
  path?: string;
  /** 1-based. */
  line?: number;
  endLine?: number;
  scope?: ExplainScope;
  mode?: ExplainMode;
  taskId?: string;
}

const MODE_KEY = 'visualAgent.explain.mode';
const SYMBOL_KINDS = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Interface,
]);

/**
 * Explain Code in Detail (local Ollama only, explicit user action only).
 *
 * Reads the document text (including unsaved edits) and NEVER writes it.
 * Requests go through ReviewerController.runDirect → ReviewService, i.e. the
 * same local endpoint check, model selection, inference guard and
 * cancellation as the Local AI Reviewer.
 */
export class ExplainController implements vscode.Disposable {
  private readonly records: ExplanationRecord[] = [];
  private currentId: string | undefined;
  private running: { id: string; cancelled: boolean } | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly staleTimers = new Map<string, NodeJS.Timeout>();
  private panel: ExplainPanel | undefined;
  /** Number of local inference requests started by this controller (tests/diagnostics). */
  requests = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly reviewer: ReviewerController,
    private readonly references: ReferenceNavigator,
    private readonly navigator: CodeNavigator,
    private readonly log: vscode.OutputChannel,
    private readonly language: () => UiLanguage,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleStaleCheck(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.scheduleStaleCheck(d)),
    );
    const sub = reviewer.service.onDidChange((s) => {
      // Stream the active part's tokens into the panel.
      const rec = this.running && this.find(this.running.id);
      const part = rec && [...rec.parts, ...(rec.synthesis ? [rec.synthesis] : [])].find((p) => p.status === 'streaming');
      if (part && s.busy && s.current?.kind === 'detail') {
        part.text = s.current.text;
        this.panel?.update();
      } else {
        this.panel?.update();
      }
    });
    this.disposables.push({ dispose: () => sub.dispose() });
  }

  registerCommands(): void {
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('visualAgent.explainCodeInDetail', (arg?: unknown, maybe?: unknown) => this.guard(() => this.explainCommand(arg, maybe)));
    reg('visualAgent.explainReference', (arg?: unknown) => this.guard(() => this.explainReference(arg)));
    // Explorer context menu / editor title: (uri). Structured file explanation; no scope picker.
    reg('visualAgent.explainFile', (arg?: unknown) =>
      this.guard(() => this.explain({ uri: arg instanceof vscode.Uri ? arg : typeof arg === 'string' ? arg : undefined, scope: 'file', mode: 'structured' })),
    );
    reg('visualAgent.explain.cancel', () => this.cancel());
  }

  // ---------------------------------------------------------------- public

  current(): ExplanationRecord | undefined {
    return this.currentId ? this.find(this.currentId) : undefined;
  }

  history(): ExplanationRecord[] {
    return [...this.records];
  }

  find(id: string): ExplanationRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  isRunning(): boolean {
    return !!this.running;
  }

  show(id: string): void {
    if (this.find(id)) {
      this.currentId = id;
      this.panel?.update();
      void this.checkStale(this.find(id)!);
    }
  }

  cancel(): boolean {
    if (!this.running) return false;
    this.running.cancelled = true;
    this.reviewer.service.cancel();
    return true;
  }

  /** Explain the given target. Returns the record (after it finished) or undefined if nothing was chosen. */
  async explain(args: ExplainArgs, options: { noCache?: boolean } = {}): Promise<ExplanationRecord | undefined> {
    if (!vscode.workspace.getConfiguration('visualAgent.reviewer').get<boolean>('enabled', true)) {
      throw new Error('The Local AI Reviewer is disabled (visualAgent.reviewer.enabled).');
    }
    if (this.running || this.reviewer.service.getState().busy) throw new Error('A local AI request is already running. Cancel it first.');
    const doc = await this.document(args);
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const line0 = args.line ? Math.min(args.line, doc.lineCount) - 1 : editor?.selection.active.line ?? 0;
    const selection = this.selectionSpan(args, editor);
    const symbol = await this.symbolAt(doc, line0);
    const scope = args.scope ?? (await this.pickScope(doc, line0, selection, symbol));
    if (!scope) return undefined;
    let target: ExplanationRecord['target'];
    if (scope === 'selection') {
      if (!selection) throw new Error('No code is selected. Select code first, or choose Function / Class or Entire File.');
      target = selection;
    } else if (scope === 'symbol') {
      if (!symbol) throw new Error(`No function or class contains line ${line0 + 1}. Choose Selected Code or Entire File.`);
      target = { startLine: symbol.startLine, endLine: symbol.endLine, symbolName: symbol.name, symbolKind: symbol.kind };
    } else {
      target = { startLine: 1, endLine: doc.lineCount };
    }
    const mode = args.mode ?? this.context.globalState.get<ExplainMode>(MODE_KEY, 'structured');
    return this.run(this.newRecord(doc, scope, mode, target), options.noCache === true);
  }

  /** Re-run (or run for the first time in another mode) the current record's target. */
  async rerun(mode?: ExplainMode): Promise<ExplanationRecord | undefined> {
    const r = this.current();
    if (!r) return undefined;
    return this.explain({ uri: r.file.uri, line: r.target.startLine, endLine: r.target.endLine, scope: r.scope, mode: mode ?? r.mode }, { noCache: true }).then(
      (x) => x,
      (err) => {
        void vscode.window.showWarningMessage(localizeError((err as Error).message, this.language()));
        return undefined;
      },
    );
  }

  /** Show an existing record for the same target in `mode`, without any request. */
  switchMode(mode: ExplainMode): boolean {
    void this.context.globalState.update(MODE_KEY, mode);
    const r = this.current();
    if (!r || r.mode === mode) return false;
    const other = this.records.find((x) => x.file.uri === r.file.uri && x.scope === r.scope && x.target.startLine === r.target.startLine && x.target.endLine === r.target.endLine && x.mode === mode && x.file.hash === r.file.hash);
    if (other) {
      this.currentId = other.id;
      this.panel?.update();
      return true;
    }
    this.panel?.update(mode);
    return false;
  }

  /** Navigate to lines of the analyzed file (from section headers and "Lines X–Y" mentions). */
  async gotoRange(id: string, startLine: number, endLine?: number): Promise<boolean> {
    const r = this.find(id);
    if (!r || !Number.isInteger(startLine) || startLine < 1) return false;
    const end = Number.isInteger(endLine) && endLine! >= startLine ? endLine! : startLine;
    await this.checkStale(r);
    const uri = vscode.Uri.parse(r.file.uri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const column = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === r.file.uri)?.viewColumn;
    const result = await this.navigator.navigate(
      {
        filePath: uri.fsPath,
        workspaceRoot: folder?.uri.fsPath ?? path.dirname(uri.fsPath),
        lineNumber: startLine,
        highlightLines: [{ startLine, endLine: end }],
        label: `◀ ${formatSpan({ startLine, endLine: end })}${r.stale ? ' (source changed since the explanation)' : ''}`,
        allowOutsideWorkspace: true,
      },
      { preserveFocus: false, preview: true, viewColumn: column ?? (this.panel?.column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One) },
    );
    if (!result.ok) void vscode.window.showWarningMessage(result.reason);
    return result.ok;
  }

  async openReference(id: string, input: unknown, side: boolean): Promise<void> {
    const r = this.find(id);
    const ref = sanitizeReference(input);
    if (!r || !ref) return;
    if (ref.line && (input as any)?.self === true) {
      await this.gotoRange(id, ref.line, ref.endLine);
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(r.file.uri));
    await this.references.open(ref, { side, keepVisible: this.panel?.column, extraRoots: [folder?.uri.fsPath ?? path.dirname(r.file.fsPath)] });
  }

  /** Secondary action from a file explanation: pick one function/class and explain its role in the project. */
  async explainFunctionOf(id: string, name?: string): Promise<ExplanationRecord | undefined> {
    const r = this.find(id);
    if (!r) return undefined;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(r.file.uri));
    const defs = listFunctionRanges(doc.getText(), languageFamily(doc.languageId, doc.fileName));
    let def = name ? defs.find((d) => d.name === name) : undefined;
    if (!def) {
      const pick = await vscode.window.showQuickPick(
        defs.map((d) => ({ label: `${d.kind === 'class' ? '$(symbol-class)' : '$(symbol-method)'} ${d.name}`, description: formatSpan({ startLine: d.startLine + 1, endLine: d.endLine + 1 }), d })),
        { title: t('x.pickFunction', this.language()) },
      );
      def = pick?.d;
    }
    if (!def) return undefined;
    return this.explain({ uri: r.file.uri, line: def.startLine + 1, scope: 'symbol', mode: 'structured' });
  }

  openLink(href: unknown): Promise<boolean> {
    return this.references.openLink(href);
  }

  markdown(id?: string): string | undefined {
    const r = id ? this.find(id) : this.current();
    return r ? renderExplanationMarkdown(r) : undefined;
  }

  async copy(id?: string): Promise<void> {
    const md = this.markdown(id);
    if (md) {
      await vscode.env.clipboard.writeText(md);
      vscode.window.setStatusBarMessage('$(check) Explanation copied (Markdown)', 3000);
    }
  }

  async export(id?: string, target?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const r = id ? this.find(id) : this.current();
    if (!r) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(r.file.uri))?.uri.fsPath ?? path.dirname(r.file.fsPath);
    const name = `explain-${path.basename(r.file.relPath).replace(/[^\w.-]+/g, '_')}-${r.scope}-${r.mode}.md`;
    const dest = target ?? (await vscode.window.showSaveDialog({ title: 'Export explanation (Markdown)', filters: { Markdown: ['md'] }, defaultUri: vscode.Uri.file(path.join(folder, name)) }));
    if (!dest) return undefined;
    if (dest.toString() === r.file.uri) throw new Error('Refusing to overwrite the explained source file.');
    await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(renderExplanationMarkdown(r)));
    vscode.window.setStatusBarMessage(`$(check) Exported to ${dest.fsPath}`, 4000);
    return dest;
  }

  dispose(): void {
    this.cancel();
    this.staleTimers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.panel?.dispose();
  }

  // ------------------------------------------------------------ internals

  private async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      void vscode.window.showWarningMessage(`${t('x.title', this.language())}: ${localizeError((err as Error).message, this.language())}`);
      return undefined;
    }
  }

  /** Editor context menu passes (uri); other entry points pass ExplainArgs. */
  private explainCommand(arg: unknown, _second: unknown): Promise<ExplanationRecord | undefined> {
    if (arg instanceof vscode.Uri) return this.explain({ uri: arg });
    if (arg && typeof arg === 'object') {
      const a = arg as Record<string, unknown>;
      const scope = a.scope === 'selection' || a.scope === 'symbol' || a.scope === 'file' ? a.scope : undefined;
      const mode = a.mode === 'structured' || a.mode === 'lineByLine' ? a.mode : undefined;
      const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);
      return this.explain({
        uri: typeof a.uri === 'string' || a.uri instanceof vscode.Uri ? (a.uri as string | vscode.Uri) : undefined,
        path: typeof a.path === 'string' ? a.path : undefined,
        line: num(a.line),
        endLine: num(a.endLine),
        scope,
        mode,
      });
    }
    return this.explain({});
  }

  /** From a file reference in a conversation (context menu): resolve, open, then explain. */
  private async explainReference(arg: unknown): Promise<ExplanationRecord | undefined> {
    const taskId = arg && typeof arg === 'object' && typeof (arg as any).taskId === 'string' ? (arg as any).taskId : undefined;
    const opened = await this.references.open(arg, { taskId });
    if (!opened.ok) return undefined;
    const ref = sanitizeReference(arg)!;
    return this.explain({ uri: opened.uri, line: ref.line ?? 1, endLine: ref.endLine });
  }

  private async document(args: ExplainArgs): Promise<vscode.TextDocument> {
    let uri: vscode.Uri | undefined;
    if (args.uri) uri = typeof args.uri === 'string' ? vscode.Uri.parse(args.uri) : args.uri;
    else if (args.path) {
      if (!path.isAbsolute(args.path)) throw new Error('A file path for explanation must be absolute.');
      uri = vscode.Uri.file(args.path);
    }
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc) throw new Error('Open a source file first.');
    if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') throw new Error('Only files from disk or unsaved editors can be explained.');
    if (doc.lineCount === 0 || !doc.getText().trim()) throw new Error('The file is empty.');
    return doc;
  }

  private selectionSpan(args: ExplainArgs, editor: vscode.TextEditor | undefined): LineSpan | undefined {
    if (args.line && args.endLine && args.endLine >= args.line) return { startLine: args.line, endLine: args.endLine };
    if (args.line || !editor || editor.selection.isEmpty) return undefined;
    const s = editor.selection;
    const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
    return { startLine: s.start.line + 1, endLine: end + 1 };
  }

  /** Innermost function/method/class containing the line: language server first, then the text parser. */
  private async symbolAt(doc: vscode.TextDocument, line0: number): Promise<{ name: string; kind: string; startLine: number; endLine: number } | undefined> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri);
      let best: vscode.DocumentSymbol | undefined;
      const walk = (list?: vscode.DocumentSymbol[]) => {
        for (const s of list ?? []) {
          if (!('range' in s) || s.range.start.line > line0 || s.range.end.line < line0) continue;
          if (SYMBOL_KINDS.has(s.kind) && (!best || best.range.contains(s.range))) best = s;
          walk(s.children);
        }
      };
      walk(symbols);
      if (best) {
        const b = best as vscode.DocumentSymbol;
        return { name: b.name.replace(/\(.*$/, ''), kind: vscode.SymbolKind[b.kind].toLowerCase(), startLine: b.range.start.line + 1, endLine: b.range.end.line + 1 };
      }
    } catch {
      /* no symbol provider */
    }
    const fn = innermost(listFunctionRanges(doc.getText(), languageFamily(doc.languageId, doc.fileName)), line0);
    return fn ? { name: fn.name, kind: fn.kind, startLine: fn.startLine + 1, endLine: fn.endLine + 1 } : undefined;
  }

  private async pickScope(doc: vscode.TextDocument, line0: number, selection: LineSpan | undefined, symbol: { name: string; kind: string; startLine: number; endLine: number } | undefined): Promise<ExplainScope | undefined> {
    const lang = this.language();
    const items: Array<vscode.QuickPickItem & { scope: ExplainScope }> = [];
    if (selection) items.push({ scope: 'selection', label: `$(selection) ${t('x.scope.selection', lang)}`, description: formatSpan(selection) });
    items.push({
      scope: 'symbol',
      label: `$(symbol-method) ${t('x.scope.symbol', lang)}`,
      description: symbol ? `${symbol.kind} ${symbol.name} · ${formatSpan(symbol)}` : t('x.noSymbol', lang, { n: line0 + 1 }),
    });
    items.push({ scope: 'file', label: `$(file-code) ${t('x.scope.file', lang)}`, description: `${path.basename(doc.fileName)} · ${doc.lineCount} lines` });
    const pick = await vscode.window.showQuickPick(items, { title: t('x.pickScope', lang) });
    return pick?.scope;
  }

  private newRecord(doc: vscode.TextDocument, scope: ExplainScope, mode: ExplainMode, target: ExplanationRecord['target']): ExplanationRecord {
    const text = doc.getText();
    const cfg = vscode.workspace.getConfiguration('visualAgent.reviewer');
    const plan = planChunks(text, languageFamily(doc.languageId, doc.fileName), target, {
      maxChunkChars: chunkBudget(cfg.get<number>('contextWindow', 8192), cfg.get<number>('maxContextChars', 12000)),
      maxChunks: Math.max(1, cfg.get<number>('explainMaxParts', 8)),
    });
    const record: ExplanationRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      file: {
        uri: doc.uri.toString(),
        fsPath: doc.uri.fsPath,
        relPath: doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri, vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 1) : path.basename(doc.fileName),
        languageId: doc.languageId,
        version: doc.version,
        hash: hashText(text),
        dirty: doc.isDirty || doc.isUntitled,
        lineCount: doc.lineCount,
      },
      scope,
      mode,
      target,
      model: this.reviewer.service.getState().selectedModel ?? '',
      language: this.reviewer.responseLanguage(),
      plan,
      parts: plan.chunks.map((chunk) => ({ chunk, status: 'pending', text: '', sections: [], gaps: [] })),
      status: 'running',
    };
    this.records.unshift(record);
    if (this.records.length > 20) this.records.pop();
    this.currentId = record.id;
    void this.context.globalState.update(MODE_KEY, mode);
    return record;
  }

  private async run(record: ExplanationRecord, noCache: boolean): Promise<ExplanationRecord> {
    this.panel = ExplainPanel.show(this.context.extensionUri, this, this.reviewer, this.language);
    this.running = { id: record.id, cancelled: false };
    this.panel.update();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(record.file.uri));
    const text = doc.getText();
    // The analysis must use exactly the hashed text; if it changed meanwhile, say so.
    if (hashText(text) !== record.file.hash) record.stale = true;
    const family = languageFamily(record.file.languageId, record.file.fsPath);
    const fileOutline = record.scope === 'file' || record.plan.chunks.length > 1 ? outline(text, family) : undefined;
    const imports = importLines(text);
    const callers = record.scope === 'symbol' && record.target.symbolName && record.target.symbolKind !== 'class' ? await this.callers(record) : undefined;
    const dependents = record.scope !== 'selection' ? await this.dependents(record) : undefined;
    try {
      for (const part of record.parts) {
        if (this.running.cancelled) {
          part.status = 'cancelled';
          continue;
        }
        const code = text.split(/\r?\n/).slice(part.chunk.startLine - 1, part.chunk.endLine).join('\n');
        const moduleLines = [...imports.filter((l) => l.line < part.chunk.startLine || l.line > part.chunk.endLine), ...referencedModuleDefinitions(text, code, family, 10).filter((d) => d.line < part.chunk.startLine || d.line > part.chunk.endLine)];
        const built = buildExplainPrompt({
          filePath: record.file.relPath,
          languageId: record.file.languageId,
          scope: record.scope,
          mode: record.mode,
          text,
          plan: record.plan,
          chunk: part.chunk,
          totalLines: record.file.lineCount,
          symbol: record.target.symbolName ? { name: record.target.symbolName, kind: record.target.symbolKind ?? 'definition' } : undefined,
          moduleLines: moduleLines.slice(0, 40),
          outline: fileOutline,
          callers,
          dependents,
          language: record.language,
          dirty: record.file.dirty,
        });
        await this.runPart(record, part, built, formatSpan(part.chunk), noCache);
        if (part.status !== 'done') break;
      }
      const done = record.parts.filter((p) => p.status === 'done');
      if (record.mode === 'structured' && record.parts.length > 1 && done.length === record.parts.length && !this.running.cancelled) {
        const cfg = vscode.workspace.getConfiguration('visualAgent.reviewer');
        const synthesis: ExplanationPart = { chunk: { index: -1, startLine: record.plan.requested.startLine, endLine: record.plan.requested.endLine, context: [] }, status: 'pending', text: '', sections: [], gaps: [] };
        record.synthesis = synthesis;
        const built = buildSynthesisPrompt({
          filePath: record.file.relPath,
          scopeText: scopeText(record),
          plan: record.plan,
          partTexts: done.map((p) => ({ span: p.chunk, text: p.text })),
          outline: fileOutline,
          language: record.language,
          budgetChars: chunkBudget(cfg.get<number>('contextWindow', 8192), cfg.get<number>('maxContextChars', 12000)),
          scope: record.scope,
        });
        await this.runPart(record, synthesis, built, 'overall', noCache);
      }
      const all = [...record.parts, ...(record.synthesis ? [record.synthesis] : [])];
      record.status = all.some((p) => p.status === 'error') ? 'error' : all.some((p) => p.status === 'cancelled') || this.running.cancelled ? 'cancelled' : 'done';
      record.parts.forEach((p) => {
        if (p.status === 'pending') p.status = 'cancelled';
      });
    } catch (err) {
      record.status = 'error';
      record.error = (err as Error).message;
      for (const p of record.parts) if (p.status === 'pending' || p.status === 'streaming') p.status = 'cancelled';
      void vscode.window.showWarningMessage(localizeError(record.error, this.language()));
    } finally {
      record.finishedAt = new Date().toISOString();
      this.running = undefined;
      await this.checkStale(record);
      this.panel?.update();
      this.log.appendLine(`[explain] ${record.mode} ${record.scope} ${record.file.relPath} ${formatSpan(record.target)}: ${record.status}, ${record.parts.length} part(s)${record.plan.partial ? ', PARTIAL' : ''}`);
    }
    return record;
  }

  private async runPart(record: ExplanationRecord, part: ExplanationPart, built: { messages: any[]; context: string }, label: string, noCache: boolean): Promise<void> {
    part.status = 'streaming';
    part.text = '';
    this.panel?.update();
    this.requests++;
    const result = await this.reviewer.runDirect({
      kind: 'detail',
      title: `Explain in detail · ${record.file.relPath} · ${label}`,
      subject: { filePath: record.file.relPath, functionName: record.target.symbolName, startLine: part.chunk.startLine, endLine: part.chunk.endLine },
      messages: built.messages,
      context: built.context,
      truncated: record.plan.partial,
      language: record.language,
      noCache,
    });
    record.model = result.model;
    part.text = result.text;
    part.cached = result.cached;
    part.durationMs = result.durationMs;
    part.status = result.status === 'done' ? 'done' : result.status === 'cancelled' ? 'cancelled' : result.status === 'error' ? 'error' : 'done';
    part.error = result.error;
    if (part.status === 'cancelled' && this.running) this.running.cancelled = true;
    // Coverage is only computed against the exact analyzed text.
    const current = (await vscode.workspace.openTextDocument(vscode.Uri.parse(record.file.uri))).getText();
    const text = hashText(current) === record.file.hash ? current : '';
    part.sections = parseSections(part.text, part.chunk.index < 0 ? record.plan.requested : part.chunk);
    part.gaps = record.mode === 'lineByLine' && part.status === 'done' && text ? uncoveredCode(part.sections, part.chunk, text) : [];
    this.panel?.update();
  }

  private async callers(record: ExplanationRecord): Promise<Array<{ filePath: string; line: number; snippet: string }>> {
    try {
      const files = await this.reviewer.workspaceSources();
      return findCallSites(record.target.symbolName!, files, 8)
        .filter((c) => !(c.filePath === record.file.relPath && c.line >= record.target.startLine && c.line <= record.target.endLine))
        .map((c) => ({ filePath: c.filePath, line: c.line, snippet: c.snippet }));
    } catch {
      return [];
    }
  }

  /** Project files that import this one (local text search over workspace sources; snippets only). */
  private async dependents(record: ExplanationRecord): Promise<Array<{ filePath: string; line: number; snippet: string }>> {
    if (vscode.Uri.parse(record.file.uri).scheme !== 'file') return [];
    try {
      const files = await this.reviewer.workspaceSources();
      return findImporters(record.file.relPath, files).slice(0, 15);
    } catch {
      return [];
    }
  }

  private scheduleStaleCheck(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.records.some((r) => r.file.uri === key)) return;
    clearTimeout(this.staleTimers.get(key));
    this.staleTimers.set(
      key,
      setTimeout(() => {
        this.staleTimers.delete(key);
        const hash = hashText(doc.getText());
        let changed = false;
        for (const r of this.records) {
          if (r.file.uri !== key) continue;
          const stale = hash !== r.file.hash;
          if (stale !== !!r.stale) {
            r.stale = stale;
            changed = true;
          }
        }
        if (changed) this.panel?.update();
      }, 250),
    );
  }

  /** Compare the analyzed hash with the open buffer, or the file on disk if it is closed. */
  async checkStale(r: ExplanationRecord): Promise<boolean> {
    const uri = vscode.Uri.parse(r.file.uri);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === r.file.uri);
    let text: string | undefined;
    if (open) text = open.getText();
    else if (uri.scheme === 'file') {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        text = undefined;
      }
    }
    const stale = text === undefined ? true : hashText(text) !== r.file.hash;
    if (stale !== !!r.stale) {
      r.stale = stale;
      this.panel?.update();
    }
    return stale;
  }

  onPanelDisposed(): void {
    this.panel = undefined;
  }
}
