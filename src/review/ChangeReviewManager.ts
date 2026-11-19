import * as vscode from 'vscode';
import * as path from 'node:path';
import { ProposedChangeContent } from '../types/events';
import { CodeNavigator } from '../navigation/CodeNavigator';
import { guessLanguage, replaceFunction } from '../navigation/symbolSearch';
import { applyUnifiedDiff } from './unifiedDiff';

interface PreparedChange {
  change: ProposedChangeContent;
  original: string;
  proposed: string;
  note?: string;
}

/**
 * Change Review Manager.
 *
 * Holds proposed changes in memory and exposes them as read-only virtual
 * documents (`visual-agent-change:` scheme) so they can be shown in VS Code's
 * diff editor. It never writes to the workspace: the "original" side is a
 * snapshot taken when the change was proposed and the "proposed" side exists
 * only in memory.
 */
export class ChangeReviewManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'visual-agent-change';

  private readonly prepared = new Map<string, Promise<PreparedChange>>();
  private readonly displayed = new Set<string>();

  hasDisplayed(changeId: string): boolean {
    return this.displayed.has(changeId);
  }
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly navigator: CodeNavigator,
    private readonly log: vscode.OutputChannel,
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(ChangeReviewManager.scheme, this);
  }

  /** Snapshot the target file and compute the proposed full-file text. */
  prepare(change: ProposedChangeContent): void {
    this.displayed.delete(change.changeId);
    this.prepared.set(change.changeId, this.compute(change));
  }

  has(changeId: string): boolean {
    return this.prepared.has(changeId);
  }

  /** Read-only access to a change's original/proposed text (memory only; undefined after reload). */
  async getContent(changeId: string): Promise<{ change: ProposedChangeContent; original: string; proposed: string } | undefined> {
    const entry = this.prepared.get(changeId);
    if (!entry) {
      return undefined;
    }
    const p = await entry;
    return { change: p.change, original: p.original, proposed: p.proposed };
  }

  async showDiff(changeId: string, options: { preserveFocus: boolean; viewColumn?: vscode.ViewColumn }): Promise<boolean> {
    const entry = this.prepared.get(changeId);
    if (!entry) {
      void vscode.window.showWarningMessage(
        'The content of this proposed change is no longer available (changes are kept in memory only for the current session).',
      );
      return false;
    }
    const p = await entry;
    const base = path.basename(p.change.filePath);
    const target = p.change.functionName ? `${base} › ${p.change.functionName}()` : base;
    const title = p.change.unifiedDiff !== undefined
      ? `${target}: Current ↔ Codex patch`
      : `${target}: Original ↔ Proposed (not applied)`;
    await vscode.commands.executeCommand('vscode.diff', this.uriFor(changeId, 'original', base), this.uriFor(changeId, 'proposed', base), title, {
      preview: false,
      preserveFocus: options.preserveFocus,
      viewColumn: options.viewColumn,
    } satisfies vscode.TextDocumentShowOptions);
    this.displayed.add(changeId);
    if (p.note) {
      void vscode.window.showWarningMessage(p.note);
    }
    return true;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Path shape: /<changeId>/<side>/<basename>
    const [, changeId, side] = uri.path.split('/');
    const entry = this.prepared.get(changeId);
    if (!entry) {
      return '// This proposed change is no longer available.';
    }
    const p = await entry;
    return side === 'original' ? p.original : p.proposed;
  }

  /** Read-only 'original' side of a change (the snapshot its diff was computed against). */
  originalUri(changeId: string, filePath: string): vscode.Uri {
    return this.uriFor(changeId, 'original', path.basename(filePath));
  }

  /** Register an already-applied change (e.g. the user's edited version) so its diff can be shown. */
  register(change: ProposedChangeContent, original: string, proposed: string): void {
    this.prepared.set(change.changeId, Promise.resolve({ change, original, proposed }));
  }

    clear(): void {
    this.prepared.clear();
    this.displayed.clear();
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
    this.prepared.clear();
  }

  private uriFor(changeId: string, side: 'original' | 'proposed', basename: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ChangeReviewManager.scheme, path: `/${changeId}/${side}/${basename}` });
  }

  private async compute(change: ProposedChangeContent): Promise<PreparedChange> {
    const resolved = this.navigator.resolve(change.filePath);
    let original: string | undefined;
    let readProblem: string | undefined;
    if (!resolved.ok) {
      readProblem = `Cannot compare against ${change.filePath}: ${resolved.reason}`;
    } else {
      try {
        // Read-only access; the workspace file is never written by this extension.
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved.absolutePath));
        original = new TextDecoder('utf-8').decode(bytes);
      } catch {
        readProblem = change.changeKind === 'add' ? undefined : `File not found: ${change.filePath}.`;
      }
    }

    // Agent-supplied unified diff (Codex fileChange).
    if (change.unifiedDiff !== undefined) {
      if (change.changeKind === 'delete') {
        return { change, original: original ?? '', proposed: '', note: readProblem };
      }
      const base = change.changeKind === 'add' ? '' : original;
      const applied = base === undefined ? undefined : applyUnifiedDiff(base, change.unifiedDiff);
      if (applied !== undefined) {
        return { change, original: base ?? '', proposed: applied, note: readProblem };
      }
      // Could not reconstruct the new file: show the raw patch instead (never guess).
      return {
        change,
        original: original ?? '',
        proposed: change.unifiedDiff,
        note: `${readProblem ?? ''} The patch did not apply cleanly to the current file; the right side shows the raw patch exactly as Codex sent it.`.trim(),
      };
    }

    const replacement = change.replacementText ?? '';
    if (original === undefined) {
      return { change, original: '', proposed: replacement, note: `${readProblem} Showing the proposed code only.` };
    }
    if (!change.functionName) {
      return { change, original, proposed: replacement };
    }
    const replaced = replaceFunction(original, change.functionName, replacement, guessLanguage(change.filePath));
    if (!replaced) {
      this.log.appendLine(`[review] ${change.functionName}() not found in ${change.filePath}`);
      return {
        change,
        original,
        proposed: replacement,
        note: `Function ${change.functionName}() was not found in ${change.filePath}. The diff shows the whole file against the proposed function only.`,
      };
    }
    return { change, original, proposed: replaced.text };
  }
}
