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
import { Notice, showNotice } from '../control/notices';
import { applyAll, describeApplyFailure, EditFileInput, EditFileState, EditSession, FileStore } from './multiFileEdit';

/** The user applied their own version of a file instead of the agent's proposal. */
export interface UserVersionApplied {
  taskId: string;
  abs: string;
  rel: string;
  /** What was written (for a kept file: its unchanged content). */
  text: string;
  /** The agent's proposed text ('' for a deletion the user excluded). The user's changes relative to it are protected. */
  agentProposed?: string;
}

interface EditingSession {
  operationId: string;
  model: EditSession;
  /** Editable copy per file (undefined for deletions). */
  temps: Array<vscode.Uri | undefined>;
  dir: vscode.Uri;
  /** Fingerprint of the content whose combined diff was last shown. */
  previewed?: string;
  /** The "editing" hint; closed with the session. */
  notice?: Notice;
}

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
  static readonly previewScheme = 'visual-agent-edit-preview';
  private readonly conflicts = new Map<string, ConflictCheck>();
  private readonly editing = new Map<string, EditingSession>();
  /** Consolidated diff text per operation (memory only; shown read-only). */
  private readonly previews = new Map<string, string>();
  private readonly previewEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly appliedEmitter = new vscode.EventEmitter<UserVersionApplied>();
  /** The user applied their own version of a file (a new baseline for "my changes"). */
  readonly onDidApplyUserVersion = this.appliedEmitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter, this.appliedEmitter, this.previewEmitter];
  private checkTimer: NodeJS.Timeout | undefined;
  private changeTimer: NodeJS.Timeout | undefined;
  private manual: ManualEditGuard | undefined;
  /**
   * Where "apply my version" reads and writes workspace files. Replaceable in
   * tests (e.g. to inject a failing write and verify the rollback).
   */
  fileStore: FileStore = {
    read: async (abs) => (await currentFile(abs)).diskText,
    isDirty: (abs) => vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, abs) && d.isDirty),
    write: async (abs, text) => {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), new TextEncoder().encode(text));
    },
    remove: async (abs) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: false });
    },
  };

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
    let pending = new Set(controller.getSnapshot().pendingApprovals);
    const sub = controller.onDidChangeState((s) => {
      const next = new Set(s.pendingApprovals);
      const resolved = [...pending].filter((id) => !next.has(id));
      pending = next;
      if (resolved.length) void this.review.closeProposalDiffs(resolved.flatMap((id) => {
        const op = this.recorder.getOperation(id);
        return [...(op?.associatedChangeIds ?? []), ...(op?.associatedChangeId ? [op.associatedChangeId] : [])];
      }));
      for (const id of [...this.conflicts.keys()]) if (!s.pendingApprovals.includes(id)) this.conflicts.delete(id);
      // A decision or task stop ends editing, but a dirty copy stays open.
      for (const [id, session] of [...this.editing]) if (!s.pendingApprovals.includes(id)) void this.endSession(session);
      if (s.pendingApprovals.length) this.scheduleRecheck();
    });
    this.disposables.push({ dispose: () => sub.dispose() });
    // Track the user's working text per file, so the file list shows "edited" live and nothing is lost when switching files.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        for (const session of this.editing.values()) {
          const i = session.temps.findIndex((t) => t?.toString() === e.document.uri.toString());
          if (i >= 0 && session.model.setText(i, e.document.getText())) this.scheduleChangeEvent();
        }
      }),
      vscode.workspace.registerTextDocumentContentProvider(ProposalReview.previewScheme, {
        onDidChange: this.previewEmitter.event,
        provideTextDocumentContent: (uri) => this.previews.get(uri.path.split('/')[1]) ?? '# This preview is no longer available.\n',
      }),
    );
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
      // Deletions too: deleting a file removes every manual edit in it.
      if (!reason && this.manual && op && !rawPatchOnly) {
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
    // The approval card shows the conflict with Regenerate / Review diff; this notice closes itself.
    showNotice(`Not applied: ${what}. Applying now could overwrite those changes; see the approval card (Regenerate with feedback, Review diff). / 未应用：文件在显示差异后已改变，应用可能覆盖这些修改。`, { ms: 10_000 });
    return false;
  }

  /** UI state of an edit-before-apply session (undefined when not editing). */
  editState(operationId: string): { multi: boolean; previewed: boolean; files: EditFileState[] } | undefined {
    const s = this.editing.get(operationId);
    return s && { multi: s.model.multi, previewed: s.previewed === s.model.fingerprint(), files: s.model.state() };
  }

  /**
   * Open the proposal as editable copies beside the original snapshots (one
   * per file). Available once generation finished (approval pending).
   * `fileIndex` switches to another file of the same proposal; edits made to
   * the other files are kept. Without an index, an existing multi-file
   * session shows the file list.
   */
  async editBeforeApplying(operationId: string, fileIndex?: number): Promise<boolean> {
    const op = this.pending(operationId);
    let s = this.editing.get(operationId);
    const fresh = !s;
    if (!s) s = await this.startSession(op);
    else if (fileIndex === undefined && s.model.multi) return this.chooseEditAction(operationId);
    await this.openFile(s, fileIndex ?? s.model.active);
    if (!fresh) return true;
    const n = s.model.files.length;
    // Closes after a few seconds, or when editing ends (applied, cancelled, decided elsewhere).
    s.notice = showNotice(
      s.model.multi
        ? `This proposal changes ${n} files. Edit each file on the right; switching files keeps your edits. Nothing is written until you review the combined diff and apply (approval card, or Edit before applying again for the file list). / 此提议修改 ${n} 个文件；查看合并差异并应用之前不会写入。`
        : `Edit the right side, then choose Apply my version on the approval card. Nothing is written to ${s.model.files[0].rel} until you do. / 编辑右侧内容，然后在批准卡片上点击应用；在此之前不会写入文件。`,
      { ms: 8000 },
    );
    return true;
  }

  /** Restore one file's editable copy to the agent's proposed text (other files keep their edits). */
  async resetEditFile(operationId: string, fileIndex: number): Promise<boolean> {
    this.pending(operationId);
    const s = this.session(operationId);
    const text = s.model.reset(fileIndex);
    const temp = s.temps[fileIndex];
    if (!temp) return false;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === temp.toString());
    if (doc) {
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
      await vscode.workspace.applyEdit(we);
      await saveWithin(doc, 1500);
    } else {
      await vscode.workspace.fs.writeFile(temp, new TextEncoder().encode(text));
    }
    s.model.setText(fileIndex, text);
    this.recorder.addNote(operationId, 'user', `Reset ${s.model.files[fileIndex].rel} to the agent's proposed version (not applied yet).`);
    this.emitter.fire();
    return true;
  }

  /** Keep a file the agent proposed to delete (or re-include the deletion), without rejecting the rest. */
  async setDeletionExcluded(operationId: string, fileIndex: number, excluded: boolean): Promise<boolean> {
    this.pending(operationId);
    const s = this.session(operationId);
    s.model.setExcluded(fileIndex, excluded);
    const rel = s.model.files[fileIndex].rel;
    this.recorder.addNote(operationId, 'user', excluded ? `Excluded the proposed deletion of ${rel}: it will be kept (not applied yet).` : `Re-included the proposed deletion of ${rel} (not applied yet).`);
    this.emitter.fire();
    return true;
  }

  /** Show everything "apply" would write, across all files, as one read-only diff. Local only. */
  async previewEditedVersion(operationId: string): Promise<string> {
    this.pending(operationId);
    const s = this.session(operationId);
    await this.sync(s);
    const text = s.model.consolidatedDiff();
    this.previews.set(operationId, text);
    const uri = vscode.Uri.from({ scheme: ProposalReview.previewScheme, path: `/${operationId}/combined-change.diff` });
    this.previewEmitter.fire(uri);
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'diff') doc = await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    // Beside the conversation panel when started from it, so "Apply my version" stays in view.
    const fromPanel = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview;
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: fromPanel ? vscode.ViewColumn.Beside : undefined, preserveFocus: fromPanel });
    s.previewed = s.model.fingerprint();
    this.emitter.fire();
    return text;
  }

  /** Discard the editable copies. Nothing is written; the proposal stays pending. */
  async cancelEditing(operationId: string): Promise<boolean> {
    const s = this.editing.get(operationId);
    if (!s) return false;
    await this.endSession(s, true);
    this.recorder.addNote(operationId, 'user', 'Editing cancelled; nothing was written. The proposal still awaits your decision.');
    this.emitter.fire();
    return true;
  }

  /**
   * Write the user's edited version of every file (after the conflict check)
   * as one unit, then decline the agent's own write with an explanation so it
   * does not overwrite it. A multi-file proposal is written only after the
   * combined diff of exactly this content was shown; the first call shows it.
   * If any write fails, every file already written is restored.
   */
  async applyEditedVersion(operationId: string): Promise<boolean> {
    const op = this.pending(operationId);
    const s = this.editing.get(operationId);
    if (!s) throw new Error('Use "Edit before applying" first.');
    await this.sync(s);
    const n = s.model.files.length;
    if (!s.model.hasWrites()) throw new Error('Every file of this proposal is excluded, so there is nothing to apply. Reject the proposal instead.');
    if (s.model.multi && s.previewed !== s.model.fingerprint()) {
      await this.previewEditedVersion(operationId);
      showNotice(`Review the combined diff of all ${n} files, then choose "Apply my version" again. Nothing has been written. / 请查看 ${n} 个文件的合并差异，然后再次点击“应用我的版本”。尚未写入任何内容。`, { ms: 6000 });
      return false;
    }
    const c = await this.check(operationId);
    if (!c.ok) {
      const what = this.describe(c);
      this.recorder.addNote(operationId, 'controller', `Your version was not applied: ${what}. Nothing was written.`);
      throw new Error(`Not applied: ${what}. Nothing was written.`);
    }
    // The conflict check guarantees no unsaved editor edits and unchanged files; open, clean editors reload from disk.
    const result = await applyAll(s.model.plan(), this.fileStore);
    if (!result.ok) {
      const what = describeApplyFailure(result);
      this.recorder.addNote(operationId, 'controller', `Your version was not applied: ${what}`);
      this.log.appendLine(`[proposal] user version for ${operationId} not applied: ${what}`);
      this.emitter.fire();
      throw new Error(`Not applied: ${what}`);
    }
    const all = s.model.files.map((f, i) => {
      const excluded = s.model.isExcluded(i);
      const text = excluded ? f.original : f.kind === 'delete' ? '' : s.model.text(i);
      return { ...f, text, excluded, stats: diffStats(createUnifiedDiff(f.original, text) ?? ''), edited: s.model.isEdited(i), proposed: f.proposed };
    });
    const what = (f: (typeof all)[number]) =>
      f.excluded ? `${f.rel} (your deletion was NOT applied: the user kept this file; do not delete it)` : f.kind === 'delete' ? `${f.rel} (deleted as proposed)` : `${f.rel} (+${f.stats.added} −${f.stats.removed}${f.edited ? ', edited by the user' : ''})`;
    const files = all.filter((f) => !f.excluded);
    const kept = all.filter((f) => f.excluded);
    // Decline the agent's tool call; the message tells it what happened and to re-read.
    this.controller.reject(
      operationId,
      s.model.multi
        ? `The user did not accept your proposed change as-is. Instead the user applied their own edited version of the ${n} files: ${all.map(what).join('; ')}. Line counts are relative to the original files. Do not re-apply your version${kept.length ? ' and do not delete the kept files' : ''}. Read the latest version of these files before any further change to them and keep the user's edits.`
        : `The user did not accept your proposed change to ${files[0].rel}. Instead the user applied their own edited version (${files[0].stats.added} lines added, ${files[0].stats.removed} removed relative to the original). Do not re-apply your version. Read the latest ${files[0].rel} before any further change to it and keep the user's edits.`,
    );
    const ids = files.map((_, i) => (s.model.multi ? `user-${operationId}-${i}` : `user-${operationId}`));
    const total = files.reduce((a, f) => ({ added: a.added + f.stats.added, removed: a.removed + f.stats.removed }), { added: 0, removed: 0 });
    const userOp = this.recorder.recordOperation(op.taskId, {
      source: 'user',
      simulated: false,
      operationType: 'Edit',
      description: s.model.multi
        ? `You applied your edited version of ${files.length} files (${files.map((f) => f.rel).join(', ')}; +${total.added} −${total.removed} vs original)${kept.length ? `; kept ${kept.map((f) => f.rel).join(', ')} (deletion excluded)` : ''}`
        : `You applied your edited version of ${files[0].rel} (+${total.added} −${total.removed} vs original)`,
      filePath: files[0].rel,
      requiresApproval: false,
      enforcement: 'none',
      associatedChangeId: ids[0],
      associatedChangeIds: s.model.multi ? ids : undefined,
    });
    files.forEach((f, i) => this.review.register({ changeId: ids[i], taskId: op.taskId, operationId: userOp.operationId, filePath: f.rel, changeKind: f.kind }, f.original, f.text));
    this.recorder.updateOperation(
      userOp.operationId,
      { status: 'Completed', resultSummary: `Written by Visual Agent on your request after a conflict check (${n > 1 ? `all ${n} files` : 'file'} unchanged since the proposal${n > 1 ? '; written as one unit with rollback on failure' : ''}). The agent's own write for operation #${op.sequenceNumber} was declined.` },
      { actor: 'user' },
    );
    await this.endSession(s);
    // New baselines, plus what the user changed relative to the agent's proposal (protected against later agent writes).
    for (const f of all) if (f.kind !== 'delete' || f.excluded) this.appliedEmitter.fire({ taskId: op.taskId, abs: f.abs, rel: f.rel, text: f.text, agentProposed: f.excluded ? '' : f.proposed });
    this.emitter.fire();
    this.log.appendLine(`[proposal] user version applied to ${files.map((f) => f.rel).join(', ')}; agent operation ${operationId} declined`);
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
    const s = this.editing.get(operationId);
    if (s) await this.endSession(s);
    this.emitter.fire();
    return true;
  }

  dispose(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ------------------------------------------------------------ edit sessions

  private session(operationId: string): EditingSession {
    const s = this.editing.get(operationId);
    if (!s) throw new Error('Use "Edit before applying" first.');
    return s;
  }

  /** Snapshot every file of the proposal into editable copies (extension storage, never the workspace). */
  private async startSession(op: AgentOperation): Promise<EditingSession> {
    const ids = changeIds(op);
    if (!ids.length) throw new Error('This operation has no proposed file change.');
    const files: EditFileInput[] = [];
    for (const id of ids) {
      const content = await this.review.getContent(id);
      const rel = content?.change.filePath ?? this.recorder.getChange(id)?.filePath ?? id;
      if (!content) throw new Error(`The proposed content of ${rel} is no longer in memory.`);
      if (content.change.unifiedDiff !== undefined && content.proposed === content.change.unifiedDiff && content.change.changeKind !== 'delete') {
        throw new Error(`The patch for ${rel} did not apply to the current file, so there is no complete proposed version to edit. Reject it with feedback instead.`);
      }
      const abs = this.absolute(op, rel);
      if (!abs) throw new Error(`${rel} is outside the workspace, so it cannot be edited here.`);
      files.push({ changeId: id, rel, abs, kind: content.change.changeKind ?? 'update', original: content.original, proposed: content.proposed });
    }
    const c = await this.check(op.operationId);
    if (!c.ok) throw new Error(`Cannot edit: ${this.describe(c)}.`);
    const model = new EditSession(files);
    const dir = vscode.Uri.joinPath(this.storage, 'proposals', op.operationId);
    const temps = files.map((f, i) => (f.kind === 'delete' ? undefined : vscode.Uri.joinPath(dir, String(i), path.basename(f.rel))));
    for (const [i, temp] of temps.entries()) {
      if (!temp) continue;
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(temp, '..'));
      await vscode.workspace.fs.writeFile(temp, new TextEncoder().encode(files[i].proposed));
    }
    const session: EditingSession = { operationId: op.operationId, model, temps, dir };
    this.editing.set(op.operationId, session);
    this.recorder.addNote(
      op.operationId,
      'user',
      model.multi ? `Editing the proposed version of ${files.length} files before applying (not applied yet): ${files.map((f) => f.rel).join(', ')}.` : 'Editing the proposed version before applying (not applied yet).',
    );
    return session;
  }

  /** Show one file: original snapshot ↔ the user's editable copy. Edits to the file being left are kept. */
  private async openFile(s: EditingSession, index: number): Promise<void> {
    await this.sync(s);
    const f = s.model.select(index);
    const temp = s.temps[index];
    const n = s.model.files.length;
    const of = s.model.multi ? ` · file ${index + 1}/${n}` : '';
    // Started from the conversation panel (a webview is active): open beside it, so the file list stays visible.
    const viewColumn = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputWebview ? vscode.ViewColumn.Beside : undefined;
    if (!temp) {
      // A deletion: show what is removed (read-only); it can be kept instead.
      await this.review.showDiff(f.changeId, { preserveFocus: false, viewColumn, pending: () => this.controller.getSnapshot().pendingApprovals.includes(s.operationId) });
    } else {
      await vscode.commands.executeCommand('vscode.diff', this.review.originalUri(f.changeId, f.rel), temp, `${path.basename(f.rel)}: Original ↔ Your version (editable, not applied)${of}`, { preview: false, viewColumn });
    }
    this.emitter.fire();
  }

  /** Pull the working text of every open copy into the session and save the copies (so closing a tab never discards edits). */
  private async sync(s: EditingSession): Promise<void> {
    for (const [i, temp] of s.temps.entries()) {
      if (!temp) continue;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === temp.toString());
      if (doc) {
        // The editor text is authoritative. Saving the copy is only a convenience (closing its tab then loses nothing),
        // so never wait on it: a save can stay pending, e.g. while an input-method composition is open.
        s.model.setText(i, doc.getText());
        if (doc.isDirty) await saveWithin(doc, 1500);
      } else {
        try {
          s.model.setText(i, new TextDecoder().decode(await vscode.workspace.fs.readFile(temp)));
        } catch {
          /* copy missing: keep the session's text */
        }
      }
    }
  }

  /** File list for multi-file proposals (Activity panel, notifications). */
  private async chooseEditAction(operationId: string): Promise<boolean> {
    const s = this.session(operationId);
    await this.sync(s);
    type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> };
    const files = s.model.state();
    const items: Item[] = [
      { label: 'Files', kind: vscode.QuickPickItemKind.Separator },
      ...files.map((f) => ({
        label: `${f.active ? '$(edit) ' : ''}${f.rel}`,
        description: f.excluded ? 'kept: deletion excluded by you' : `${f.kind === 'add' ? 'new file · ' : f.kind === 'delete' ? 'to be deleted · ' : f.edited ? 'edited by you · ' : 'as proposed · '}+${f.added} −${f.removed}`,
        run: () => this.editBeforeApplying(operationId, f.index),
      })),
      { label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
      ...files.filter((f) => f.kind === 'delete').map((f) => (f.excluded
        ? { label: `$(trash) Delete ${f.rel} as proposed`, description: 're-include the deletion', run: () => this.setDeletionExcluded(operationId, f.index, false) }
        : { label: `$(pass) Keep ${f.rel}`, description: 'exclude this deletion; apply the rest', run: () => this.setDeletionExcluded(operationId, f.index, true) })),
      ...files.filter((f) => f.edited && f.kind !== 'delete').map((f) => ({ label: `$(discard) Reset ${f.rel}`, description: "back to the agent's proposal", run: () => this.resetEditFile(operationId, f.index) })),
      { label: '$(diff) Preview combined diff', run: () => this.previewEditedVersion(operationId) },
      { label: `$(check) Apply my version (${files.length} files)`, description: 'shows the combined diff first if it changed', run: () => this.applyEditedVersion(operationId) },
      { label: '$(close) Cancel editing', description: 'nothing is written; the proposal stays pending', run: () => this.cancelEditing(operationId) },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Edit before applying: ${files.length} files / 先编辑再应用：${files.length} 个文件`, placeHolder: 'Choose a file to edit, or an action' });
    if (pick?.run) await pick.run();
    return !!pick;
  }

  /** Close clean copies and retain the storage of any draft still open. */
  private async endSession(s: EditingSession, discard = false): Promise<void> {
    if (this.editing.get(s.operationId) !== s) return;
    this.editing.delete(s.operationId);
    s.notice?.dispose();
    const preview = this.previews.delete(s.operationId);
    const temps = new Set(s.temps.filter((t): t is vscode.Uri => !!t).map((t) => t.toString()));
    if (discard) {
      for (const doc of vscode.workspace.textDocuments) {
        if (temps.has(doc.uri.toString()) && doc.isDirty) await saveWithin(doc, 1500);
      }
    }
    const dirty = new Set(vscode.workspace.textDocuments
      .filter((doc) => temps.has(doc.uri.toString()) && doc.isDirty)
      .map((doc) => doc.uri.toString()));
    const openTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const copyUri = (tab: vscode.Tab): vscode.Uri | undefined => {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) return input.modified;
      if (input instanceof vscode.TabInputText) return input.uri;
      return undefined;
    };
    const tabs = openTabs().filter((tab) => {
      const uri = copyUri(tab);
      if (!uri || tab.isDirty || dirty.has(uri.toString())) return false;
      return temps.has(uri.toString()) || (preview && uri.scheme === ProposalReview.previewScheme && uri.path.startsWith(`/${s.operationId}/`));
    });
    const closed = !tabs.length || await vscode.window.tabGroups.close(tabs, true).then(undefined, () => false);
    if (!closed || dirty.size || openTabs().some((tab) => temps.has(copyUri(tab)?.toString() ?? '')) ||
      vscode.workspace.textDocuments.some((doc) => temps.has(doc.uri.toString()) && doc.isDirty)) return;
    await vscode.workspace.fs.delete(s.dir, { recursive: true, useTrash: false }).then(undefined, () => undefined);
  }

  private scheduleChangeEvent(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.emitter.fire();
    }, 250);
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

/** Save, but give up after `ms` (the save may still finish later). */
async function saveWithin(doc: vscode.TextDocument, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const saved = await Promise.race([doc.save().then((ok) => ok, () => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  clearTimeout(timer);
  return saved;
}

export function changeIds(op: AgentOperation): string[] {
  return op.associatedChangeIds ?? (op.associatedChangeId ? [op.associatedChangeId] : []);
}

async function currentFile(abs: string): Promise<{ diskText?: string; dirty: boolean }> {
  const uri = vscode.Uri.file(abs);
  // Any open copy: on Windows one file can be open as two documents (e.g. "c:" and "C:" in the URI).
  const dirty = vscode.workspace.textDocuments.some((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, uri.fsPath) && d.isDirty);
  let diskText: string | undefined;
  try {
    diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    diskText = undefined;
  }
  return { diskText, dirty };
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
