import * as vscode from 'vscode';
import { resolveWorkspacePath, PathResolution } from './pathSafety';
import { findFunctionRange, guessLanguage } from './symbolSearch';

export interface NavigationTarget {
  workspaceRoot?: string;
  filePath?: string;
  functionName?: string;
  /** 1-based. */
  lineNumber?: number;
  label?: string;
  /** 1-based line ranges to highlight instead of the located function (e.g. actual changed lines). */
  highlightLines?: Array<{ startLine: number; endLine: number }>;
  /** 1-based column for the cursor when `lineNumber` is given. */
  column?: number;
  /** The user explicitly confirmed opening a file outside the workspace. */
  allowOutsideWorkspace?: boolean;
}

export interface NavigationOptions {
  /** Keep keyboard focus where it is (used when following the agent). */
  preserveFocus: boolean;
  /** Open in a preview tab (reused by the next navigation). */
  preview?: boolean;
  viewColumn?: vscode.ViewColumn;
}

export type NavigationResult =
  | { ok: true; uri: vscode.Uri; range: vscode.Range; matchedBy: 'symbol' | 'text' | 'line' | 'file'; warning?: string }
  | { ok: false; reason: string };

/**
 * Code Navigator: opens files, finds functions and highlights them.
 *
 * Lookup order: language-server document symbols → text search → line number
 * → top of file. All paths are validated against the workspace first.
 */
export class CodeNavigator implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly labelDecoration: vscode.TextEditorDecorationType;
  private lastHighlight: { uri: string; ranges: vscode.Range[]; label?: string } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.OutputChannel) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      borderWidth: '0 0 0 3px',
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.labelDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 2em',
      },
    });
    // Re-apply the highlight when the editor is re-shown (decorations are per editor instance).
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (!this.lastHighlight) {
          return;
        }
        for (const e of editors) {
          if (e.document.uri.toString() === this.lastHighlight.uri) {
            this.applyHighlight(e, this.lastHighlight.ranges, this.lastHighlight.label);
          }
        }
      }),
    );
  }

  private rootOverride: string | undefined;

  /** Root of the workspace folder the current agent task runs in (multi-root workspaces). */
  setRoot(root: string | undefined): void {
    this.rootOverride = root;
  }

  workspaceRoot(): string | undefined {
    return this.rootOverride ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  resolve(filePath: string, workspaceRoot?: string, allowOutsideOverride = false): PathResolution {
    const allowOutside = allowOutsideOverride || vscode.workspace
      .getConfiguration('visualAgent')
      .get<boolean>('allowNavigationOutsideWorkspace', false);
    return resolveWorkspacePath(workspaceRoot ?? this.workspaceRoot(), filePath, { allowOutsideWorkspace: allowOutside });
  }

  async navigate(target: NavigationTarget, options: NavigationOptions): Promise<NavigationResult> {
    if (!target.filePath) {
      return { ok: false, reason: 'This operation is not associated with a file.' };
    }
    const resolved = this.resolve(target.filePath, target.workspaceRoot, target.allowOutsideWorkspace === true);
    if (!resolved.ok) {
      return this.fail(resolved.reason);
    }
    const uri = vscode.Uri.file(resolved.absolutePath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        return this.fail(`"${target.filePath}" is a directory.`);
      }
    } catch {
      return this.fail(`File not found: ${resolved.relativePath}`);
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      return this.fail(`Could not open ${resolved.relativePath}: ${String(err)}`);
    }

    const located = await this.locate(document, target);
    const editor = await vscode.window.showTextDocument(document, {
      preserveFocus: options.preserveFocus,
      preview: options.preview ?? true,
      viewColumn: options.viewColumn,
      selection: options.preserveFocus ? undefined : new vscode.Range(located.range.start, located.range.start),
    });
    if (located.matchedBy === 'line' && target.column && target.column > 1 && !options.preserveFocus) {
      const col = Math.min(target.column - 1, document.lineAt(located.range.start.line).text.length);
      const at = new vscode.Position(located.range.start.line, col);
      editor.selection = new vscode.Selection(at, at);
    }
    const ranges = this.clampRanges(document, target.highlightLines) ?? [located.range];
    editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.applyHighlight(editor, ranges, target.label);
    this.lastHighlight = { uri: uri.toString(), ranges, label: target.label };
    if (located.warning) {
      this.log.appendLine(`[navigate] ${located.warning}`);
    }
    return { ok: true, uri, range: located.range, matchedBy: located.matchedBy, warning: located.warning };
  }

  clearHighlight(): void {
    this.lastHighlight = undefined;
    for (const e of vscode.window.visibleTextEditors) {
      e.setDecorations(this.decoration, []);
      e.setDecorations(this.labelDecoration, []);
    }
  }

  dispose(): void {
    this.decoration.dispose();
    this.labelDecoration.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ internals

  private async locate(
    document: vscode.TextDocument,
    target: NavigationTarget,
  ): Promise<{ range: vscode.Range; matchedBy: 'symbol' | 'text' | 'line' | 'file'; warning?: string }> {
    if (target.functionName) {
      const symbolRange = await this.findSymbol(document, target.functionName);
      if (symbolRange) {
        return { range: symbolRange, matchedBy: 'symbol' };
      }
      const lang = document.languageId === 'python' ? 'python' : guessLanguage(document.fileName);
      const textRange = findFunctionRange(document.getText(), target.functionName, lang);
      if (textRange) {
        return {
          range: new vscode.Range(textRange.startLine, 0, textRange.endLine, document.lineAt(textRange.endLine).text.length),
          matchedBy: 'text',
        };
      }
    }
    const missingFn = target.functionName
      ? `Function "${target.functionName}" was not found in ${vscode.workspace.asRelativePath(document.uri)}`
      : undefined;
    if (target.lineNumber && target.lineNumber >= 1) {
      const line = Math.min(target.lineNumber, document.lineCount) - 1;
      return {
        range: document.lineAt(line).range,
        matchedBy: 'line',
        warning: missingFn ? `${missingFn}; showing line ${line + 1} instead.` : undefined,
      };
    }
    return {
      range: document.lineAt(0).range,
      matchedBy: 'file',
      warning: missingFn ? `${missingFn}; showing top of file.` : undefined,
    };
  }

  private async findSymbol(document: vscode.TextDocument, name: string): Promise<vscode.Range | undefined> {
    try {
      const symbols = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined
      >('vscode.executeDocumentSymbolProvider', document.uri);
      if (!symbols) {
        return undefined;
      }
      const stack: Array<vscode.DocumentSymbol | vscode.SymbolInformation> = [...symbols];
      while (stack.length) {
        const s = stack.shift()!;
        const bare = s.name.replace(/\(.*\)$/, '');
        if (bare === name) {
          return 'range' in s ? s.range : s.location.range;
        }
        if ('children' in s && s.children) {
          stack.push(...s.children);
        }
      }
    } catch {
      /* no symbol provider: fall back to text search */
    }
    return undefined;
  }

  private clampRanges(document: vscode.TextDocument, lines?: Array<{ startLine: number; endLine: number }>): vscode.Range[] | undefined {
    const out = (lines ?? [])
      .filter((r) => r.startLine >= 1 && r.startLine <= document.lineCount)
      .slice(0, 200)
      .map((r) => new vscode.Range(r.startLine - 1, 0, Math.min(Math.max(r.endLine, r.startLine), document.lineCount) - 1, Number.MAX_SAFE_INTEGER));
    return out.length ? out : undefined;
  }

  private applyHighlight(editor: vscode.TextEditor, ranges: vscode.Range[], label?: string): void {
    const range = ranges[0];
    // Only one highlight at a time across editors.
    for (const e of vscode.window.visibleTextEditors) {
      if (e !== editor) {
        e.setDecorations(this.decoration, []);
        e.setDecorations(this.labelDecoration, []);
      }
    }
    editor.setDecorations(this.decoration, ranges);
    editor.setDecorations(
      this.labelDecoration,
      label
        ? [{ range: new vscode.Range(range.start.line, Number.MAX_SAFE_INTEGER, range.start.line, Number.MAX_SAFE_INTEGER), renderOptions: { after: { contentText: label } } }]
        : [],
    );
  }

  private fail(reason: string): NavigationResult {
    this.log.appendLine(`[navigate] ${reason}`);
    return { ok: false, reason };
  }
}
