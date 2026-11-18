import * as vscode from 'vscode';
import * as path from 'node:path';
import { CodeNavigator } from '../navigation/CodeNavigator';
import { CodeReference, formatReference, sanitizeReference } from './codeReference';
import { RefResolution, resolveReference } from './referenceResolver';

export interface OpenReferenceOptions {
  /** Open in a new editor group to the side. */
  side?: boolean;
  /** Conversation the reference came from (its project is the primary root). */
  taskId?: string;
  /** Editor group to keep visible (the conversation panel). */
  keepVisible?: vscode.ViewColumn;
  /** Do not show warning popups (the caller shows the reason inline). */
  quiet?: boolean;
  /** Additional roots searched right after the conversation's project (e.g. the explained file's folder). */
  extraRoots?: string[];
}

export type OpenReferenceResult =
  | { ok: true; uri: vscode.Uri; line?: number }
  | { ok: false; reason: string; cancelled?: boolean };

/**
 * Opens file references from agent conversations and explanations.
 *
 * Every input is re-validated (sanitizeReference) because it may come from a
 * webview. The only side effect is opening a text editor: no commands are
 * executed, no URLs opened, and nothing is written.
 */
export class ReferenceNavigator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly navigator: CodeNavigator,
    private readonly taskRoot: (taskId?: string) => string | undefined,
    private readonly log: vscode.OutputChannel,
  ) {}

  registerCommands(): void {
    const reg = (id: string, fn: (...a: any[]) => unknown) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    // From webview context menus (args = merged data-vscode-context) or programmatic callers.
    reg('visualAgent.openReference', (arg?: unknown, opts?: unknown) => this.openFromArg(arg, { ...(isObject(opts) ? opts : {}), side: isObject(opts) && opts.side === true }));
    reg('visualAgent.openReferenceToSide', (arg?: unknown) => this.openFromArg(arg, { side: true }));
    reg('visualAgent.copyReferencePath', async (arg?: unknown) => {
      const ref = sanitizeReference(arg);
      if (ref) await vscode.env.clipboard.writeText(formatReference(ref));
    });
  }

  private openFromArg(arg: unknown, opts: OpenReferenceOptions): Promise<OpenReferenceResult> {
    const taskId = isObject(arg) && typeof arg.taskId === 'string' ? arg.taskId : opts.taskId;
    return this.open(arg, { ...opts, taskId });
  }

  /** Roots in priority order: the conversation's project, the navigator's current root, all workspace folders. */
  roots(taskId?: string, extraRoots: string[] = []): string[] {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    return [this.taskRoot(taskId), ...extraRoots, this.navigator.workspaceRoot(), ...folders].filter((r): r is string => !!r);
  }

  async resolve(input: unknown, taskId?: string, extraRoots?: string[]): Promise<{ ref?: CodeReference; resolution: RefResolution }> {
    const ref = sanitizeReference(input);
    if (!ref) return { resolution: { kind: 'invalid', reason: 'Not a valid file reference.' } };
    return { ref, resolution: await resolveReference(ref, { roots: this.roots(taskId, extraRoots) }) };
  }

  async open(input: unknown, opts: OpenReferenceOptions = {}): Promise<OpenReferenceResult> {
    const { ref, resolution } = await this.resolve(input, opts.taskId, opts.extraRoots);
    const fail = (reason: string, cancelled = false): OpenReferenceResult => {
      this.log.appendLine(`[reference] ${ref ? formatReference(ref) : String((input as any)?.path ?? '')}: ${reason}`);
      if (!opts.quiet && !cancelled) void vscode.window.showWarningMessage(reason);
      return { ok: false, reason, cancelled };
    };
    if (!ref) return fail(resolution.kind === 'invalid' ? resolution.reason : 'Not a valid file reference.');
    let target: { absolutePath: string; root?: string; outside?: boolean };
    switch (resolution.kind) {
      case 'file':
        target = resolution;
        break;
      case 'ambiguous': {
        const pick = await vscode.window.showQuickPick(
          resolution.candidates.map((c) => ({ label: path.basename(c.absolutePath), description: path.relative(c.root, c.absolutePath), detail: c.root, c })),
          { title: `"${ref.path}" matches ${resolution.candidates.length} files — choose one / 匹配到多个文件，请选择`, matchOnDescription: true },
        );
        if (!pick) return fail('Ambiguous reference: no file chosen.', true);
        target = pick.c;
        break;
      }
      case 'outside': {
        const allowed = vscode.workspace.getConfiguration('visualAgent').get<boolean>('allowNavigationOutsideWorkspace', false);
        if (!allowed) {
          const choice = await vscode.window.showWarningMessage(
            `${resolution.absolutePath} is outside the open project folders. Open it anyway? / 该文件不在当前项目内，仍要打开吗？`,
            { modal: true },
            'Open / 打开',
          );
          if (!choice) return fail('Outside the workspace: not opened.', true);
        }
        target = { absolutePath: resolution.absolutePath, outside: true };
        break;
      }
      default:
        return fail(resolution.reason);
    }
    const result = await this.navigator.navigate(
      {
        filePath: target.absolutePath,
        workspaceRoot: target.root,
        lineNumber: ref.line,
        column: ref.column,
        highlightLines: ref.line ? [{ startLine: ref.line, endLine: ref.endLine ?? ref.line }] : undefined,
        allowOutsideWorkspace: target.outside === true || !target.root,
      },
      { preserveFocus: false, preview: !opts.side, viewColumn: this.column(opts) },
    );
    if (!result.ok) return fail(result.reason);
    if (ref.line && ref.line > result.range.start.line + 1) {
      const doc = await vscode.workspace.openTextDocument(result.uri);
      if (ref.line > doc.lineCount) {
        const note = `${path.basename(result.uri.fsPath)} has only ${doc.lineCount} lines; line ${ref.line} does not exist (showing the last line).`;
        void vscode.window.showInformationMessage(note); // the file did open; tell the user why the cursor is elsewhere
        this.log.appendLine(`[reference] ${note}`);
      }
    }
    return { ok: true, uri: result.uri, line: ref.line };
  }

  /** External http(s)/mailto links are opened only after an explicit confirmation. */
  async openLink(href: unknown): Promise<boolean> {
    if (typeof href !== 'string' || href.length > 2048) return false;
    let url: vscode.Uri;
    try {
      url = vscode.Uri.parse(href, true);
    } catch {
      return false;
    }
    if (!['http', 'https', 'mailto'].includes(url.scheme)) return false;
    const choice = await vscode.window.showInformationMessage(`Open external link? / 打开外部链接？\n${href}`, { modal: true }, 'Open / 打开');
    return choice ? vscode.env.openExternal(url) : false;
  }

  /** Keep the conversation visible: use another editor group, or open one beside it. */
  private column(opts: OpenReferenceOptions): vscode.ViewColumn {
    if (opts.side) return vscode.ViewColumn.Beside;
    const group = vscode.window.tabGroups.activeTabGroup;
    const keep = opts.keepVisible ?? (group.activeTab?.input instanceof vscode.TabInputWebview ? group.viewColumn : undefined);
    const other = vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined && e.viewColumn !== keep && e.document.uri.scheme === 'file')?.viewColumn;
    if (other) return other;
    return keep === undefined ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}
