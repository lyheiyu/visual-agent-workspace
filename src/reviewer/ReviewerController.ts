import * as vscode from 'vscode';
import * as path from 'node:path';
import { EventRecorder } from '../recorder/EventRecorder';
import { ChangeReviewManager } from '../review/ChangeReviewManager';
import { createUnifiedDiff } from '../review/unifiedDiff';
import { FunctionRange, guessLanguage, innermost, listFunctionRanges } from '../navigation/symbolSearch';
import { extractErrorLocations, findCallees, findCallSites, referencedModuleDefinitions, SourceFile } from '../analysis/staticAnalysis';
import { AgentOperation } from '../types/events';
import { ReviewRequest, ReviewResult, ReviewService } from './ReviewService';
import { CodeBlock, explainErrorPrompt, explainFunctionPrompt, impactPrompt, reviewChangePrompt } from './prompts';
import { redactSecrets } from '../recorder/redaction';
import { localizeError, normalizeLanguage, t, UiLanguage } from '../i18n/i18n';
import { TranslationTarget } from './ReviewService';

export interface FunctionTarget {
  document: vscode.TextDocument;
  relPath: string;
  name?: string;
  enclosing?: string;
  /** 0-based inclusive lines. */
  startLine: number;
  endLine: number;
  source: 'symbols' | 'parser' | 'selection';
}

const SOURCE_GLOB = '**/*.{py,ts,tsx,js,jsx,mjs,cjs}';
const EXCLUDE_GLOB = '**/{node_modules,.git,out,dist,build,.venv,venv,__pycache__,.vscode-test}/**';

/**
 * VS Code side of the Local AI Reviewer: resolves what the user selected,
 * gathers minimal context with local analysis, runs ONE request on explicit
 * user action, and shows the result read-only beside the code.
 *
 * It never edits files, never runs commands, and never talks to the coding
 * agent's session.
 */
export class ReviewerController implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'visual-agent-review';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly service: ReviewService,
    private readonly recorder: EventRecorder,
    private readonly changes: ChangeReviewManager,
    private readonly log: vscode.OutputChannel,
    private readonly selectedOperationId: () => string | undefined,
  ) {
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(ReviewerController.scheme, this), this.emitter);
    const sub = service.onDidChange((s) => {
      if (s.current) {
        this.emitter.fire(ReviewerController.resultUri(s.current.id));
      }
    });
    this.disposables.push({ dispose: () => sub.dispose() });
  }

  static resultUri(id: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ReviewerController.scheme, path: `/${id}.md` });
  }

  registerCommands(): void {
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('visualAgent.reviewer.explainFunction', () => this.guard(() => this.explainFunction()));
    reg('visualAgent.reviewer.reviewChange', (opId?: string) => this.guard(() => this.reviewChange(typeof opId === 'string' ? opId : undefined)));
    reg('visualAgent.reviewer.impactAnalysis', () => this.guard(() => this.impactAnalysis()));
    reg('visualAgent.reviewer.explainError', (opId?: string) => this.guard(() => this.explainError(typeof opId === 'string' ? opId : undefined)));
    reg('visualAgent.reviewer.cancel', () => this.service.cancel());
    reg('visualAgent.reviewer.refreshModels', () => this.service.refreshModels());
    reg('visualAgent.reviewer.selectModel', () => this.pickModel());
    reg('visualAgent.reviewer.copyResult', (id?: string) => this.copyResult(id));
    reg('visualAgent.reviewer.exportResult', (id?: string) => this.exportResult(id));
    reg('visualAgent.reviewer.openResult', (id?: string) => this.openResult(id, false));
    reg('visualAgent.reviewer.translateResult', (id?: string, target?: TranslationTarget) =>
      this.translateResult(typeof id === 'string' ? id : undefined, target === 'zh-CN' || target === 'en' ? target : undefined),
    );
  }

  // ------------------------------------------------------------- actions

  async explainFunction(): Promise<ReviewResult | undefined> {
    const t = await this.functionAtCursor();
    const budget = this.budget();
    const lang = t.document.languageId;
    const built = explainFunctionPrompt(
      {
        fn: { ...this.block(t), name: t.name },
        language: lang,
        imports: this.importsBlock(t.document),
        enclosing: t.enclosing,
        moduleDefs: referencedModuleDefinitions(t.document.getText(), this.block(t).code, guessLanguage(t.document.fileName)),
      },
      budget,
      this.responseLanguage(),
    );
    return this.execute({
      kind: 'explain',
      title: `Explain ${t.name ? `${t.name}()` : 'selection'} · ${t.relPath}`,
      subject: { filePath: t.relPath, functionName: t.name, startLine: t.startLine + 1, endLine: t.endLine + 1 },
      ...built,
    });
  }

  async reviewChange(operationId?: string): Promise<ReviewResult | undefined> {
    let op: AgentOperation | undefined;
    let fnName: string | undefined;
    let relPath: string | undefined;
    const fromId = operationId ?? this.selectedEditOperation();
    if (fromId) {
      op = this.recorder.getOperation(fromId);
    } else {
      const t = await this.functionAtCursor();
      fnName = t.name;
      relPath = t.relPath;
      op = this.latestEditTouching(t.relPath, t.name);
      if (!op) {
        throw new Error(`No change recorded by a coding agent touches ${t.name ? `${t.name}() in ` : ''}${t.relPath} in this session.`);
      }
    }
    if (!op || (!op.associatedChangeId && !op.associatedChangeIds?.length)) {
      throw new Error('Select an Edit operation (in Agent Activity) or place the cursor in a changed function.');
    }
    const ids = op.associatedChangeIds ?? [op.associatedChangeId!];
    const changeRecords = ids.map((id) => this.recorder.getChange(id)).filter(Boolean);
    const changeId = (relPath && changeRecords.find((c) => samePath(c!.filePath, relPath!))?.changeId) ?? ids[0];
    const content = await this.changes.getContent(changeId);
    if (!content) {
      throw new Error('The content of this change is no longer in memory (changes are kept only for the current session).');
    }
    const file = content.change.filePath;
    const lang = guessLanguage(file);
    const fns = (op.affectedFunctions ?? []).filter((f) => samePath(f.filePath, file) && f.kind !== 'class');
    fnName ??= fns.length === 1 ? fns[0].name : op.functionName;
    const diff = content.change.unifiedDiff ?? createUnifiedDiff(content.original, content.proposed) ?? '';
    const pick = (text: string): CodeBlock | undefined => {
      const r = fnName ? listFunctionRanges(text, lang).find((d) => d.name === fnName) : undefined;
      return r ? { filePath: file, startLine: r.startLine + 1, code: sliceLines(text, r.startLine, r.endLine) } : undefined;
    };
    const built = reviewChangePrompt(
      {
        filePath: file,
        functionName: fnName,
        diff,
        original: content.change.changeKind === 'add' ? undefined : pick(content.original),
        modified: content.change.changeKind === 'delete' ? undefined : pick(content.proposed),
        operationRef: `operation #${op.sequenceNumber} (${op.status})`,
        moduleDefs: referencedModuleDefinitions(content.proposed || content.original, (pick(content.proposed) ?? pick(content.original))?.code ?? diff, lang),
      },
      this.budget(),
      this.responseLanguage(),
    );
    return this.execute({
      kind: 'review',
      title: `Review change ${fnName ? `${fnName}() · ` : ''}${file} (op #${op.sequenceNumber})`,
      subject: { filePath: file, functionName: fnName, operationId: op.operationId, taskId: op.taskId },
      ...built,
    });
  }

  async impactAnalysis(): Promise<ReviewResult | undefined> {
    const t = await this.functionAtCursor();
    if (!t.name) {
      throw new Error('Place the cursor inside a named function for impact analysis.');
    }
    const files = await this.workspaceSources();
    const fnCode = sliceLines(t.document.getText(), t.startLine, t.endLine);
    let callers = await this.referenceCallers(t);
    let evidence = 'language-server references';
    let complete = true;
    if (!callers.length) {
      callers = findCallSites(t.name, files);
      evidence = 'text search (heuristic: dynamic calls and same-named functions are not distinguished)';
      complete = false;
    }
    const built = impactPrompt(
      { fn: { ...this.block(t), name: t.name }, callers, callees: findCallees(fnCode, files, t.name), evidenceSource: evidence, complete },
      this.budget(),
      this.responseLanguage(),
    );
    return this.execute({
      kind: 'impact',
      title: `Impact of ${t.name}() · ${t.relPath}`,
      subject: { filePath: t.relPath, functionName: t.name, startLine: t.startLine + 1, endLine: t.endLine + 1 },
      ...built,
    });
  }

  async explainError(operationId?: string): Promise<ReviewResult | undefined> {
    let op = this.recorder.getOperation(operationId ?? this.selectedOperationId() ?? '');
    if (!op || !isFailedCommand(op)) {
      op = await this.pickFailedCommand();
      if (!op) {
        return undefined;
      }
    }
    const root = workspaceRoot();
    const output = [op.command!.stdout, op.command!.stderr].filter(Boolean).join('\n');
    const related: CodeBlock[] = [];
    for (const loc of extractErrorLocations(output, root, op.command!.workingDirectory, 3)) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, loc.filePath))));
        const fn = innermost(listFunctionRanges(text, guessLanguage(loc.filePath)), loc.line - 1);
        const [s, e] = fn ? [fn.startLine, Math.min(fn.endLine, fn.startLine + 80)] : [Math.max(0, loc.line - 8), loc.line + 6];
        related.push({ filePath: loc.filePath, startLine: s + 1, code: sliceLines(text, s, e), label: fn ? `${fn.name}() (referenced at line ${loc.line})` : `around line ${loc.line}` });
      } catch {
        /* file not readable: skip */
      }
    }
    const built = explainErrorPrompt(
      { command: op.command!.command, exitCode: op.command!.exitCode, cwd: op.command!.workingDirectory, output, related },
      this.budget(),
      this.responseLanguage(),
    );
    return this.execute({
      kind: 'error',
      title: `Explain failure of op #${op.sequenceNumber}: ${truncate(op.command!.command, 60)}`,
      subject: { operationId: op.operationId, taskId: op.taskId },
      ...built,
    });
  }

  // ------------------------------------------------------- result display

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.replace(/^\//, '').replace(/\.md$/, '');
    const r = this.find(id);
    return r ? renderResultMarkdown(r) : 'Review result not found (results are kept for the current session only).';
  }

  async openResult(id?: string, beside = true): Promise<void> {
    const r = this.find(id);
    if (!r) {
      return;
    }
    let doc = await vscode.workspace.openTextDocument(ReviewerController.resultUri(r.id));
    if (doc.languageId !== 'markdown') {
      doc = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    }
    await vscode.window.showTextDocument(doc, { viewColumn: beside ? vscode.ViewColumn.Beside : undefined, preserveFocus: beside, preview: true });
  }

  async copyResult(id?: string): Promise<void> {
    const r = this.find(id);
    if (r) {
      await vscode.env.clipboard.writeText(renderResultMarkdown(r));
      vscode.window.setStatusBarMessage('$(check) Review copied (Markdown)', 3000);
    }
  }

  async exportResult(id?: string): Promise<void> {
    const r = this.find(id);
    if (!r) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: 'Export local AI review',
      filters: { Markdown: ['md'] },
      defaultUri: vscode.Uri.file(path.join(workspaceRoot() || require('node:os').homedir(), `review-${r.kind}-${r.startedAt.slice(0, 10)}.md`)),
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderResultMarkdown(r)));
      vscode.window.setStatusBarMessage(`$(check) Exported to ${target.fsPath}`, 4000);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ internals

  private async guard(fn: () => Promise<ReviewResult | undefined>): Promise<ReviewResult | undefined> {
    try {
      return await fn();
    } catch (err) {
      void vscode.window.showWarningMessage(`${t('r.title', this.responseLanguage())}: ${localizeError((err as Error).message, this.responseLanguage())}`);
      return undefined;
    }
  }

  /** Reviewer answer language = the UI language setting (default 中文). */
  responseLanguage(): UiLanguage {
    return normalizeLanguage(vscode.workspace.getConfiguration('visualAgent').get('language'));
  }

  /** Translate a previous result (explicit user action; cached; cancellable). */
  async translateResult(id?: string, target?: TranslationTarget): Promise<void> {
    const r = this.find(id);
    if (!r) {
      return;
    }
    let to = target;
    if (!to) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '中文', target: 'zh-CN' as const },
          { label: 'English', target: 'en' as const },
        ].filter((x) => x.target !== r.language),
        { title: 'Translate / 翻译' },
      );
      to = pick?.target;
    }
    if (!to) {
      return;
    }
    try {
      const tr = await this.service.translate(r.id, to);
      if (tr && tr.status === 'done' && tr.codeSpansPreserved === false) {
        void vscode.window.showWarningMessage(t('r.codeChanged', this.responseLanguage()));
      }
      if (tr?.status === 'error') {
        void vscode.window.showWarningMessage(`Local AI Reviewer: ${tr.error}`);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`${t('r.title', this.responseLanguage())}: ${localizeError((err as Error).message, this.responseLanguage())}`);
    }
  }

  private inferenceGuard: ((model: string) => Promise<boolean>) | undefined;

  /** Called before each local review; may veto loading another model. */
  setInferenceGuard(guard: (model: string) => Promise<boolean>): void {
    this.inferenceGuard = guard;
  }

  private async execute(req: ReviewRequest): Promise<ReviewResult> {
    req.language ??= this.responseLanguage();
    const model = this.service.getState().selectedModel;
    if (model && this.inferenceGuard && !(await this.inferenceGuard(model))) {
      throw new Error('Cancelled: the review would load another local model.');
    }
    const running = this.service.run(req);
    // Show the streaming result beside the code without stealing focus.
    setTimeout(() => {
      const id = this.service.getState().current?.id;
      if (id) {
        void this.openResult(id, true);
      }
    }, 50);
    const result = await running;
    this.log.appendLine(`[reviewer] ${result.kind} with ${result.model}: ${result.status}${result.cached ? ' (cached)' : ''} in ${result.durationMs ?? 0} ms`);
    if (result.status === 'error') {
      void vscode.window.showWarningMessage(`Local AI Reviewer: ${result.error}`);
    }
    return result;
  }

  private find(id?: string): ReviewResult | undefined {
    const s = this.service.getState();
    return id ? (s.current?.id === id ? s.current : s.history.find((h) => h.id === id)) : s.current;
  }

  private budget(): number {
    return Math.max(2000, vscode.workspace.getConfiguration('visualAgent').get<number>('reviewer.maxContextChars', 12000));
  }

  private block(t: FunctionTarget): CodeBlock {
    return { filePath: t.relPath, startLine: t.startLine + 1, code: sliceLines(t.document.getText(), t.startLine, t.endLine) };
  }

  private importsBlock(doc: vscode.TextDocument): CodeBlock | undefined {
    const lines: string[] = [];
    let first = -1;
    for (let i = 0; i < Math.min(doc.lineCount, 80) && lines.length < 30; i++) {
      const l = doc.lineAt(i).text;
      if (/^\s*(import\s|from\s+\S+\s+import\s|const\s+\w+\s*=\s*require\(|#include\s)/.test(l)) {
        if (first < 0) {
          first = i;
        }
        lines.push(l);
      }
    }
    return lines.length ? { filePath: vscode.workspace.asRelativePath(doc.uri), startLine: first + 1, code: lines.join('\n'), label: 'Imports (non-contiguous)' } : undefined;
  }

  /** Function at the cursor: language-server symbols first, then the text parser, then the selection. */
  async functionAtCursor(): Promise<FunctionTarget> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      throw new Error('Open a source file and place the cursor inside a function.');
    }
    const doc = editor.document;
    const pos = editor.selection.active;
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri);
      const kinds = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
      let best: { s: vscode.DocumentSymbol; parent?: vscode.DocumentSymbol } | undefined;
      const walk = (list: vscode.DocumentSymbol[] | undefined, parent?: vscode.DocumentSymbol) => {
        for (const s of list ?? []) {
          if (!('range' in s) || !s.range.contains(pos)) {
            continue;
          }
          if (kinds.has(s.kind) && (!best || best.s.range.contains(s.range))) {
            best = { s, parent };
          }
          walk(s.children, s);
        }
      };
      walk(symbols);
      if (best) {
        return { document: doc, relPath, name: best.s.name.replace(/\(.*$/, ''), enclosing: best.parent?.name, startLine: best.s.range.start.line, endLine: best.s.range.end.line, source: 'symbols' };
      }
    } catch {
      /* no symbol provider */
    }
    const defs = listFunctionRanges(doc.getText(), doc.languageId === 'python' ? 'python' : guessLanguage(doc.fileName));
    const fn = innermost(defs.filter((d) => d.kind !== 'class'), pos.line) as FunctionRange | undefined;
    if (fn) {
      const parent = innermost(defs.filter((d) => d.kind === 'class' && d.startLine < fn.startLine), fn.startLine);
      return { document: doc, relPath, name: fn.name, enclosing: parent?.name, startLine: fn.startLine, endLine: fn.endLine, source: 'parser' };
    }
    if (!editor.selection.isEmpty) {
      return { document: doc, relPath, startLine: editor.selection.start.line, endLine: editor.selection.end.line, source: 'selection' };
    }
    throw new Error('No function found at the cursor. Place the cursor inside a function or select some code.');
  }

  private selectedEditOperation(): string | undefined {
    const id = this.selectedOperationId();
    const op = id ? this.recorder.getOperation(id) : undefined;
    return op && (op.associatedChangeId || op.associatedChangeIds?.length) ? op.operationId : undefined;
  }

  private latestEditTouching(relPath: string, fnName?: string): AgentOperation | undefined {
    const edits = this.recorder.getOperations().filter((o) => o.associatedChangeId || o.associatedChangeIds?.length).reverse();
    return (
      (fnName && edits.find((o) => (o.affectedFunctions ?? []).some((f) => f.name === fnName && samePath(f.filePath, relPath)))) ||
      (fnName && edits.find((o) => o.functionName === fnName && samePath(o.filePath ?? '', relPath))) ||
      edits.find((o) => samePath(o.filePath ?? '', relPath) || (o.changedRanges ?? []).some((r) => samePath(r.filePath, relPath)))
    );
  }

  private async referenceCallers(t: FunctionTarget): Promise<Array<{ filePath: string; line: number; callerFunction?: string; snippet: string }>> {
    const defLine = t.document.lineAt(t.startLine).text;
    const col = defLine.indexOf(t.name!);
    if (col < 0) {
      return [];
    }
    try {
      const locs = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        t.document.uri,
        new vscode.Position(t.startLine, col),
      );
      const out: Array<{ filePath: string; line: number; callerFunction?: string; snippet: string }> = [];
      for (const loc of (locs ?? []).slice(0, 30)) {
        if (loc.uri.toString() === t.document.uri.toString() && loc.range.start.line === t.startLine) {
          continue; // the definition itself
        }
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const defs = listFunctionRanges(doc.getText(), doc.languageId === 'python' ? 'python' : guessLanguage(doc.fileName));
        out.push({
          filePath: vscode.workspace.asRelativePath(loc.uri),
          line: loc.range.start.line + 1,
          callerFunction: innermost(defs, loc.range.start.line)?.name,
          snippet: doc.lineAt(loc.range.start.line).text.trim().slice(0, 200),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Workspace source files for local text analysis (bounded: 400 files, 300 KB each). */
  async workspaceSources(): Promise<SourceFile[]> {
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, 400);
    const out: SourceFile[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 300_000) {
          continue;
        }
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        out.push({ filePath: vscode.workspace.asRelativePath(uri), text, language: guessLanguage(uri.fsPath) });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  private async pickFailedCommand(): Promise<AgentOperation | undefined> {
    const failed = this.recorder.getOperations().filter(isFailedCommand).reverse().slice(0, 30);
    if (!failed.length) {
      void vscode.window.showInformationMessage('No failed commands or tests have been recorded.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      failed.map((o) => ({
        label: truncate(o.command!.command, 80),
        description: `exit ${o.command!.exitCode ?? '?'} · op #${o.sequenceNumber}${o.simulated ? ' · simulated' : ''}`,
        op: o,
      })),
      { title: 'Explain which failure?' },
    );
    return pick?.op;
  }

  private async pickModel(): Promise<void> {
    await this.service.refreshModels();
    const s = this.service.getState();
    if (!s.models.length) {
      void vscode.window.showWarningMessage(`Local AI Reviewer: ${s.error ?? 'no models found'}`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      s.models.map((m) => ({ label: m.name, description: [m.parameterSize, m.quantization].filter(Boolean).join(' · '), picked: m.name === s.selectedModel })),
      { title: 'Local model for reviews' },
    );
    if (pick) {
      this.service.selectModel(pick.label);
    }
  }
}

export function isFailedCommand(op: AgentOperation): boolean {
  return !!op.command && (op.status === 'Failed' || (op.command.exitCode !== undefined && op.command.exitCode !== 0));
}

export function renderResultMarkdown(r: ReviewResult): string {
  const subject = [r.subject.filePath, r.subject.functionName && `${r.subject.functionName}()`, r.subject.startLine && `lines ${r.subject.startLine}–${r.subject.endLine}`]
    .filter(Boolean)
    .join(' · ');
  const status = r.status === 'streaming' ? '⏳ streaming…' : r.status === 'done' ? (r.cached ? 'done (cached result)' : 'done') : r.status === 'cancelled' ? 'cancelled' : `error: ${r.error}`;
  return redactSecrets(
    [
      `# ${r.title}`,
      '',
      `> **Model-generated by the local model \`${r.model}\`. Not verified by execution; treat as a hypothesis.**`,
      '',
      `- Status: ${status}`,
      `- Started: ${r.startedAt}${r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)} s` : ''}${r.outputTokens ? ` · ${r.promptTokens ?? '?'} prompt / ${r.outputTokens} output tokens (local)` : ''}`,
      subject && `- Subject: ${subject}`,
      r.subject.operationId && `- Operation: ${r.subject.operationId}`,
      '',
      ...shownVersion(r),
      '',
      '---',
      '',
      `<details><summary>Context sent to the local model${r.truncated ? ' (truncated to the size limit)' : ''}</summary>`,
      '',
      r.context,
      '',
      '</details>',
    ]
      .filter((l): l is string => typeof l === 'string')
      .join('\n'),
  );
}

function sliceLines(text: string, start: number, end: number): string {
  return text.split(/\r?\n/).slice(start, end + 1).join('\n');
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return n(a) === n(b);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/** Markdown for the version being shown; translations always keep the original alongside. */
function shownVersion(r: ReviewResult): string[] {
  const original = r.text || (r.status === 'streaming' ? '_waiting for the first tokens…_' : '_(no output)_');
  const name = (l: string) => (l === 'zh-CN' ? '中文' : l === 'en' ? 'English' : '中文 + English');
  const tr = r.view === 'zh-CN' || r.view === 'en' ? r.translations[r.view] : undefined;
  if (r.view === 'bilingual') {
    const other = r.translations[r.language === 'zh-CN' ? 'en' : 'zh-CN'];
    return ['## Result (original)', '', original, ...(other?.text ? ['', `## Translation (${name(other.target)}, local model \`${other.model}\`)`, '', other.text] : [])];
  }
  if (tr) {
    return [
      `## Result (${name(tr.target)}, translated by local model \`${tr.model}\`${tr.status === 'streaming' ? ', in progress' : ''})`,
      '',
      tr.text,
      ...(tr.codeSpansPreserved === false ? ['', '> ⚠ Some code spans differ from the original; compare below.'] : []),
      '',
      `## Original (${name(r.language)})`,
      '',
      original,
    ];
  }
  return ['## Result', '', original];
}
