import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventRecorder } from '../recorder/EventRecorder';
import { ChangeReviewManager } from '../review/ChangeReviewManager';
import { createUnifiedDiff } from '../review/unifiedDiff';
import { guessLanguage, listFunctionRanges } from '../navigation/symbolSearch';
import { findCallSites } from '../analysis/staticAnalysis';
import { AgentOperation } from '../types/events';
import { ReviewerController } from '../reviewer/ReviewerController';
import { buildReviewContextMarkdown, ExportChange, ExportInput } from './reviewContext';

/**
 * "Export Review Context": builds Markdown from recorded evidence, shows a
 * read-only preview, and only then copies or saves it on explicit request.
 * Nothing is sent to any model or service.
 */
export class ExportController implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'visual-agent-export';
  private readonly docs = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly recorder: EventRecorder,
    private readonly changes: ChangeReviewManager,
    private readonly reviewer: ReviewerController,
    private readonly selection: () => { taskId?: string; operationId?: string },
  ) {
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(ExportController.scheme, this));
  }

  registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('visualAgent.exportReviewContext', (opId?: string) => this.run(typeof opId === 'string' ? opId : undefined)),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path.replace(/^\//, '').replace(/\.md$/, '')) ?? 'Export no longer available.';
  }

  /** Build without UI (used by tests and by run()). */
  async build(scope: ExportInput['scope'], opts: { operationIds?: string[]; taskId?: string }): Promise<string> {
    const input = await this.collect(scope, opts);
    return buildReviewContextMarkdown(input);
  }

  async run(operationId?: string): Promise<void> {
    const sel = this.selection();
    const opId = operationId ?? sel.operationId;
    const op = opId ? this.recorder.getOperation(opId) : undefined;
    const taskId = op?.taskId ?? sel.taskId ?? this.recorder.getTasks()[0]?.taskId;
    const editor = vscode.window.activeTextEditor;
    type Item = vscode.QuickPickItem & { scope: ExportInput['scope'] };
    const items: Item[] = [];
    if (op && (op.associatedChangeId || op.associatedChangeIds?.length)) {
      items.push({ label: `Change of operation #${op.sequenceNumber}`, description: op.description, scope: 'change' });
    }
    if (editor?.document.uri.scheme === 'file') {
      items.push({ label: 'Function at the cursor', description: vscode.workspace.asRelativePath(editor.document.uri), scope: 'function' });
    }
    if (taskId) {
      items.push({ label: 'Choose operations…', description: 'pick several operations of the task', scope: 'operations' });
      items.push({ label: 'Entire task', description: this.recorder.getTask(taskId)?.description, scope: 'task' });
    }
    if (!items.length) {
      void vscode.window.showInformationMessage('Nothing to export yet: run a task or open a source file.');
      return;
    }
    const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Export review context: what to include?' });
    if (!picked) {
      return;
    }
    let operationIds: string[] | undefined = op ? [op.operationId] : undefined;
    if (picked.scope === 'operations') {
      const ops = this.recorder.getOperations(taskId);
      const chosen = await vscode.window.showQuickPick(
        ops.map((o) => ({ label: `#${o.sequenceNumber} ${o.operationType} · ${o.status}`, description: o.description, picked: o.operationId === opId, id: o.operationId })),
        { canPickMany: true, title: 'Operations to include' },
      );
      if (!chosen?.length) {
        return;
      }
      operationIds = chosen.map((c) => c.id);
    }
    let markdown: string;
    try {
      markdown = await this.build(picked.scope, { operationIds, taskId });
    } catch (err) {
      void vscode.window.showWarningMessage(`Export: ${(err as Error).message}`);
      return;
    }
    await this.preview(markdown);
  }

  async preview(markdown: string): Promise<string> {
    const id = randomUUID();
    this.docs.set(id, markdown);
    if (this.docs.size > 20) {
      this.docs.delete(this.docs.keys().next().value!);
    }
    let doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: ExportController.scheme, path: `/${id}.md` }));
    doc = await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: true });
    void vscode.window
      .showInformationMessage(
        `Review context preview (${markdown.length.toLocaleString()} characters, secrets redacted). Nothing has been sent anywhere.`,
        'Copy to Clipboard',
        'Save As…',
      )
      .then(async (choice) => {
        if (choice === 'Copy to Clipboard') {
          await vscode.env.clipboard.writeText(markdown);
          vscode.window.setStatusBarMessage('$(check) Review context copied', 3000);
        } else if (choice === 'Save As…') {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('node:os').homedir();
          const target = await vscode.window.showSaveDialog({
            filters: { Markdown: ['md'] },
            defaultUri: vscode.Uri.file(path.join(root, `review-context-${new Date().toISOString().slice(0, 10)}.md`)),
          });
          if (target) {
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(markdown));
          }
        }
      });
    return id;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ internals

  private async collect(scope: ExportInput['scope'], opts: { operationIds?: string[]; taskId?: string }): Promise<ExportInput> {
    const generatedAt = new Date().toISOString();
    if (scope === 'function') {
      const t = await this.reviewer.functionAtCursor();
      const code = t.document.getText().split(/\r?\n/).slice(t.startLine, t.endLine + 1).join('\n');
      const edits = this.recorder
        .getOperations()
        .filter((o) => (o.affectedFunctions ?? []).some((f) => f.name === t.name && samePath(f.filePath, t.relPath)) || (t.name && o.functionName === t.name && samePath(o.filePath ?? '', t.relPath)))
        .filter((o) => o.associatedChangeId || o.associatedChangeIds?.length);
      const task = edits.length ? this.recorder.getTask(edits[edits.length - 1].taskId) : undefined;
      const files = t.name ? await this.reviewer.workspaceSources() : [];
      return {
        scope,
        title: t.name ? `${t.name}() in ${t.relPath}` : `selection in ${t.relPath}`,
        generatedAt,
        task,
        operations: edits,
        changes: await this.changesFor(edits, t.relPath, t.name),
        fn: { name: t.name, code: { filePath: t.relPath, startLine: t.startLine + 1, code }, nameSource: t.source },
        related: t.name ? { callers: findCallSites(t.name, files, 10), source: 'text search across workspace source files (heuristic)' } : undefined,
      };
    }
    const taskId = opts.taskId ?? this.recorder.getTasks()[0]?.taskId;
    const task = taskId ? this.recorder.getTask(taskId) : undefined;
    if (!task) {
      throw new Error('No task recorded.');
    }
    const all = this.recorder.getOperations(task.taskId);
    const ops = scope === 'task' ? all : all.filter((o) => opts.operationIds?.includes(o.operationId));
    if (!ops.length) {
      throw new Error('No operations selected.');
    }
    const first = ops[0];
    return {
      scope,
      title: scope === 'task' ? `task "${task.description}"` : scope === 'change' ? `change of operation #${first.sequenceNumber}` : `${ops.length} operations of "${task.description}"`,
      generatedAt,
      task,
      operations: ops,
      changes: await this.changesFor(ops.filter((o) => o.associatedChangeId || o.associatedChangeIds?.length)),
    };
  }

  private async changesFor(ops: AgentOperation[], onlyFile?: string, onlyFn?: string): Promise<ExportChange[]> {
    const out: ExportChange[] = [];
    for (const op of ops) {
      for (const changeId of op.associatedChangeIds ?? [op.associatedChangeId!]) {
        const record = this.recorder.getChange(changeId);
        if (!record || (onlyFile && !samePath(record.filePath, onlyFile))) {
          continue;
        }
        const content = await this.changes.getContent(changeId);
        if (!content) {
          out.push({ record, operation: op, diffSource: 'recorded', functions: [], contentAvailable: false });
          continue;
        }
        const lang = guessLanguage(record.filePath);
        const recorded = content.change.unifiedDiff;
        const names = onlyFn
          ? [onlyFn]
          : [...new Set([...(op.affectedFunctions ?? []).filter((f) => samePath(f.filePath, record.filePath) && f.kind !== 'class').map((f) => f.name), ...(op.functionName ? [op.functionName] : [])])];
        const slice = (text: string, name: string) => {
          const r = listFunctionRanges(text, lang).find((d) => d.name === name);
          return r ? { filePath: record.filePath, startLine: r.startLine + 1, code: text.split(/\r?\n/).slice(r.startLine, Math.min(r.endLine, r.startLine + 200) + 1).join('\n') } : undefined;
        };
        out.push({
          record,
          operation: op,
          diff: recorded ?? createUnifiedDiff(content.original, content.proposed),
          diffSource: recorded !== undefined ? 'recorded' : 'derived',
          functions: names.map((name) => ({
            name,
            original: content.change.changeKind === 'add' ? undefined : slice(content.original, name),
            modified: content.change.changeKind === 'delete' ? undefined : slice(content.proposed, name),
          })),
          contentAvailable: true,
        });
      }
    }
    return out;
  }
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return n(a) === n(b);
}
