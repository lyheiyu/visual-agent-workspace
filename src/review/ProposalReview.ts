import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentController } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentOperation } from '../types/events';
import { ChangeReviewManager } from './ChangeReviewManager';
import { ConflictReason, snapshotConflict } from './proposalGuard';
import { createUnifiedDiff, diffStats } from './unifiedDiff';
import { isInside } from '../navigation/pathSafety';
import { describeCommand } from '../analysis/commandInfo';

export interface ConflictCheck {
  ok: boolean;
  files: Array<{ rel: string; abs?: string; reason?: ConflictReason; detail?: string }>;
}

/** Supplied by ManualChanges: hunks of the user's manual edits that applying `proposed` would undo. */
export interface ManualEditGuard {
  wouldUndo(taskId: string, abs: string, proposed: string): Promise<Array<{ line: number; added: string[]; removed: string[] }>>;
  hasManualEdits(taskId: string, abs: string): Promise<boolean>;
}

const REASON_TEXT: Record<ConflictReason, string> = {
  changed: 'changed on disk since the diff was computed',
  unsaved: 'has unsaved edits in the editor',
  created: 'was created since the proposal',
  deleted: 'was deleted since the proposal',
  unavailable: 'the proposal snapshot is no longer available',
  'undoes-manual': 'would undo your manual edits',
  'command-writes-edited': 'is a write target of this command and has your manual or unsaved edits (detected heuristically from the command text)',
};

/**
 * Review before writing: accept / reject / edit before applying /
 * regenerate with feedback, plus a conflict check on every path that would
 * write. The agent's change is still applied by the agent itself (approve);
 * "apply my version" writes the user's edited text and declines the agent's
 * tool call with an explanation. Nothing is written if the target changed
 * since the diff was shown.
 */
export class ProposalReview implements vscode.Disposable {
  private readonly conflicts = new Map<string, ConflictCheck>();
  private readonly editing = new Map<string, { temp: vscode.Uri; changeId: string; rel: string; abs: string; taskId: string }>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly appliedEmitter = new vscode.EventEmitter<{ taskId: string; abs: string; rel: string; text: string }>();
  /** The user applied their own version of a file (a new baseline for "my changes"). */
  readonly onDidApplyUserVersion = this.appliedEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter, this.appliedEmitter];
  private checkTimer: NodeJS.Timeout | undefined;
  private manual: ManualEditGuard | undefined;

  setManualEditGuard(guard: ManualEditGuard): void {
    this.manual = guard;
  }

  constructor(
    private readonly storage: vscode.Uri,
    private readonly controller: AgentController,
    private readonly recorder: EventRecorder,
    private readonly review: ChangeReviewManager,
    private readonly log: vscode.OutputChannel,
  ) {
    const recheck = () => {
      if (this.controller.getSnapshot().pendingApprovals.length) this.scheduleRecheck();
    };
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(recheck), vscode.workspace.onDidSaveTextDocument(recheck));
    const sub = controller.onDidChangeState((s) => {
      for (const id of [...this.conflicts.keys()]) if (!s.pendingApprovals.includes(id)) this.conflicts.delete(id);
      if (s.pendingApprovals.length) this.scheduleRecheck();
    });
    this.disposables.push({ dispose: () => sub.dispose() });
  }

  conflictFor(operationId: string): ConflictCheck | undefined {
    return this.conflicts.get(operationId);
  }

  isEditing(operationId: string): boolean {
    return this.editing.has(operationId);
  }

  /** Compare every file of the proposal with the snapshot its diff was built from. */
  async check(operationId: string): Promise<ConflictCheck> {
    const op = this.recorder.getOperation(operationId);
    const ids = op ? changeIds(op) : [];
    const files: ConflictCheck['files'] = op && !ids.length && op.command ? await this.commandTargets(op) : [];
    for (const id of ids) {
      const content = await this.review.getContent(id);
      const rel = content?.change.filePath ?? this.recorder.getChange(id)?.filePath ?? '?';
      const abs = op ? this.absolute(op, rel) : undefined;
      if (!content || !abs) {
        files.push({ rel, abs, reason: 'unavailable' });
        continue;
      }
      // Codex's own fallback (raw patch shown because it did not apply) has no reliable snapshot.
      let reason: ConflictReason | undefined = snapshotConflict(content.original, content.change.changeKind, await currentFile(abs));
      let detail: string | undefined;
      // Prevent the write BEFORE it happens if it would remove the user's manual edits.
      const rawPatchOnly = content.change.unifiedDiff !== undefined && content.proposed === content.change.unifiedDiff;
      if (!reason && this.manual && op && !rawPatchOnly && content.change.changeKind !== 'delete') {
        const lost = await this.manual.wouldUndo(op.taskId, abs, content.proposed);
        if (lost.length) {
          reason = 'undoes-manual';
          detail = lost.map((l) => `near line ${l.line}: ${(l.added.find((x) => x.trim()) ?? l.removed.find((x) => x.trim()) ?? '').trim().slice(0, 80)}`).join('; ');
        }
      }
      files.push({ rel, abs, reason, detail });
    }
    const result = { ok: files.every((f) => !f.reason), files };
    const before = JSON.stringify(this.conflicts.get(operationId));
    if (result.ok) this.conflicts.delete(operationId);
    else this.conflicts.set(operationId, result);
    if (before !== JSON.stringify(this.conflicts.get(operationId))) this.emitter.fire();
    return result;
  }

  describe(c: ConflictCheck): string {
    return c.files.filter((f) => f.reason).map((f) => `${f.rel} ${REASON_TEXT[f.reason!]}${f.detail ? ` (${f.detail})` : ''}`).join('; ');
  }

  /** Approval gate: returns true only if nothing changed since the diff was shown. */
  async guardApproval(operationId: string): Promise<boolean> {
    const op = this.recorder.getOperation(operationId);
    if (!op || (!changeIds(op).length && !op.command)) return true;
    const c = await this.check(operationId);
    if (c.ok) return true;
    const what = this.describe(c);
    this.recorder.addNote(operationId, 'controller', `Approval blocked: ${what}. Nothing was written.`);
    this.log.appendLine(`[proposal] approval blocked for ${operationId}: ${what}`);
    // Do not block the approval call on the user's choice.
    void vscode.window
      .showWarningMessage(
        `Not applied: ${what}. Applying now could overwrite those changes. / 未应用：文件在显示差异后已改变，应用可能覆盖这些修改。`,
        'Regenerate with feedback / 带反馈重新生成',
        'Show diff / 查看差异',
      )
      .then((choice) => {
        if (choice?.startsWith('Regenerate')) return this.regenerate(operationId, c.files.some((f) => f.reason === 'undoes-manual' || f.reason === 'command-writes-edited') ? `Your proposal would remove my manual edits (${what}). Read the latest file and keep my edits.` : `The file changed after your proposal (${what}). Keep those changes.`).catch(() => false);
        if (choice?.startsWith('Show')) return this.review.showDiff(changeIds(op)[0], { preserveFocus: false });
        return undefined;
      });
    return false;
  }

  /** Open the proposal as an editable copy beside the original snapshot. Available once generation finished (approval pending). */
  async editBeforeApplying(operationId: string): Promise<boolean> {
    const op = this.pending(operationId);
    const ids = changeIds(op);
    if (ids.length !== 1) throw new Error(ids.length ? 'This proposal changes several files; edit-before-apply supports one file at a time. Reject it with feedback instead.' : 'This operation has no proposed file change.');
    const content = await this.review.getContent(ids[0]);
    if (!content) throw new Error('The proposed content is no longer in memory.');
    if (content.change.unifiedDiff !== undefined && content.proposed === content.change.unifiedDiff) throw new Error('The patch did not apply to the current file, so there is no complete proposed version to edit.');
    const c = await this.check(operationId);
    if (!c.ok) throw new Error(`Cannot edit: ${this.describe(c)}.`);
    const rel = content.change.filePath;
    const abs = this.absolute(op, rel)!;
    const temp = vscode.Uri.joinPath(this.storage, 'proposals', operationId, path.basename(rel));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(temp, '..'));
    const existing = this.editing.get(operationId);
    if (!existing) await vscode.workspace.fs.writeFile(temp, new TextEncoder().encode(content.proposed));
    this.editing.set(operationId, { temp, changeId: ids[0], rel, abs, taskId: op.taskId });
    this.recorder.addNote(operationId, 'user', 'Editing the proposed version before applying (not applied yet).');
    await vscode.commands.executeCommand('vscode.diff', this.review.originalUri(ids[0], rel), temp, `${path.basename(rel)}: Original ↔ Your version (editable, not applied)`, { preview: false });
    this.emitter.fire();
    void vscode.window
      .showInformationMessage(`Edit the right side, then apply it. Nothing is written to ${rel} until you do. / 编辑右侧内容，然后点击应用；在此之前不会写入文件。`, 'Apply my version / 应用我的版本')
      .then((x) => (x ? this.applyEditedVersion(operationId).catch((e) => vscode.window.showWarningMessage((e as Error).message)) : undefined));
    return true;
  }

  /**
   * Write the user's edited version (after the conflict check), then decline
   * the agent's own write with an explanation so it does not overwrite it.
   */
  async applyEditedVersion(operationId: string): Promise<boolean> {
    const op = this.pending(operationId);
    const e = this.editing.get(operationId);
    if (!e) throw new Error('Use "Edit before applying" first.');
    const tempDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.temp.toString());
    const text = tempDoc ? tempDoc.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(e.temp));
    const c = await this.check(operationId);
    if (!c.ok) {
      const what = this.describe(c);
      this.recorder.addNote(operationId, 'controller', `Your version was not applied: ${what}.`);
      throw new Error(`Not applied: ${what}. Nothing was written.`);
    }
    const original = (await this.review.getContent(e.changeId))!.original;
    const uri = vscode.Uri.file(e.abs);
    // The conflict check guarantees no unsaved editor edits and an unchanged file; an open, clean editor reloads from disk.
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    const written = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    if (written !== text) throw new Error(`${e.rel} does not contain your version after writing; check the file.`);
    const diff = createUnifiedDiff(original, text) ?? '';
    const stats = diffStats(diff);
    // Decline the agent's tool call; the message tells it what happened and to re-read.
    this.controller.reject(
      operationId,
      `The user did not accept your proposed change to ${e.rel}. Instead the user applied their own edited version (${stats.added} lines added, ${stats.removed} removed relative to the original). Do not re-apply your version. Read the latest ${e.rel} before any further change to it and keep the user's edits.`,
    );
    const userOp = this.recorder.recordOperation(op.taskId, {
      source: 'user',
      simulated: false,
      operationType: 'Edit',
      description: `You applied your edited version of ${e.rel} (+${stats.added} −${stats.removed} vs original)`,
      filePath: e.rel,
      requiresApproval: false,
      enforcement: 'none',
      associatedChangeId: `user-${operationId}`,
    });
    this.review.register({ changeId: `user-${operationId}`, taskId: op.taskId, operationId: userOp.operationId, filePath: e.rel, changeKind: 'update' }, original, text);
    this.recorder.updateOperation(userOp.operationId, { status: 'Completed', resultSummary: `Written by Visual Agent on your request after a conflict check (file unchanged since the proposal). The agent's own write for operation #${op.sequenceNumber} was declined.` }, { actor: 'user' });
    this.editing.delete(operationId);
    void vscode.workspace.fs.delete(vscode.Uri.joinPath(e.temp, '..'), { recursive: true }).then(undefined, () => undefined);
    this.appliedEmitter.fire({ taskId: op.taskId, abs: e.abs, rel: e.rel, text });
    this.emitter.fire();
    this.log.appendLine(`[proposal] user version applied to ${e.rel}; agent operation ${operationId} declined`);
    return true;
  }

  /** Decline with feedback; the agent proposes again in the same turn. */
  async regenerate(operationId: string, feedback?: string): Promise<boolean> {
    const op = this.pending(operationId);
    let text = feedback?.trim();
    if (!text) {
      text = (await vscode.window.showInputBox({ title: 'Regenerate with feedback / 带反馈重新生成', prompt: 'What should be different? The agent receives this and proposes again.', placeHolder: 'e.g. keep the existing function signature' }))?.trim();
      if (!text) return false;
    }
    const target = op.operationType === 'Edit' && op.filePath ? `Re-read the latest ${op.filePath} first, then propose a new change.` : 'Propose a different approach.';
    if (!this.controller.reject(operationId, `Regenerate requested by the user. Feedback: ${text.slice(0, 1500)}. ${target}`)) return false;
    this.editing.delete(operationId);
    this.emitter.fire();
    return true;
  }

  dispose(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ internals

  private pending(operationId: string): AgentOperation {
    const op = this.recorder.getOperation(operationId);
    if (!op || !this.controller.getSnapshot().pendingApprovals.includes(operationId)) throw new Error('That operation is not awaiting approval.');
    return op;
  }

  private absolute(op: AgentOperation, rel: string): string | undefined {
    const task = this.recorder.getTask(op.taskId);
    const root = task?.workspaceRoot ?? task?.launch?.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (path.isAbsolute(rel)) return path.normalize(rel);
    if (!root) return undefined;
    const abs = path.resolve(root, rel);
    return isInside(root, abs) ? abs : undefined;
  }

  /** Commands: files they would write (heuristic) that have manual or unsaved edits. */
  private async commandTargets(op: AgentOperation): Promise<ConflictCheck['files']> {
    const out: ConflictCheck['files'] = [];
    const info = describeCommand(op.command!.command);
    const cwd = op.command!.workingDirectory || this.absolute(op, '.') || '';
    for (const t of info.writeTargets) {
      const abs = path.isAbsolute(t) ? path.normalize(t) : cwd ? path.resolve(cwd, t) : undefined;
      if (!abs) continue;
      const now = await currentFile(abs);
      if (now.dirty || (this.manual && (await this.manual.hasManualEdits(op.taskId, abs)))) out.push({ rel: t, abs, reason: 'command-writes-edited' });
    }
    return out;
  }

  private scheduleRecheck(): void {
    if (this.checkTimer) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      for (const id of this.controller.getSnapshot().pendingApprovals) {
        const op = this.recorder.getOperation(id);
        if (op && (changeIds(op).length || op.command)) void this.check(id);
      }
    }, 300);
  }
}

export function changeIds(op: AgentOperation): string[] {
  return op.associatedChangeIds ?? (op.associatedChangeId ? [op.associatedChangeId] : []);
}

async function currentFile(abs: string): Promise<{ diskText?: string; dirty: boolean }> {
  const uri = vscode.Uri.file(abs);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, uri.fsPath));
  let diskText: string | undefined;
  try {
    diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    diskText = undefined;
  }
  return { diskText, dirty: !!open?.isDirty };
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
