import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { AgentController, ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder, RecorderChange } from '../recorder/EventRecorder';
import { CodeNavigator } from '../navigation/CodeNavigator';
import { ChangeReviewManager } from '../review/ChangeReviewManager';
import { RecordDocumentProvider } from '../ui/RecordDocumentProvider';
import { ActivityViewModel, buildActivityViewModel } from '../ui/viewModel';
import { AgentOperation } from '../types/events';
import { CODEX_PROFILES, CodexProfileId } from '../adapters/codex/profiles';
import { localizeError, normalizeLanguage, UiLanguage } from '../i18n/i18n';

export interface TaskStarters {
  demo: () => string;
  /** Throws with a user-facing message if Codex cannot be started. */
  codex: (instructions: string, profile: CodexProfileId) => string;
}

export const CONTROL_ACTIONS = [
  'start',
  'pause',
  'resume',
  'stop',
  'approve',
  'reject',
  'review',
  'reveal',
  'showOutput',
  'summary',
  'startCodex',
  'steer',
  'aiReviewChange',
  'aiExplainError',
  'exportContext',
  'newTask',
  'endSession',
  'conversation',
  'continueHistory',
  'openChat',
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

const FOLLOW_KEY = 'visualAgent.followAgent';
const SELECTED_CONVERSATION_KEY = 'visualAgent.selectedConversation';

/**
 * Human Control Manager.
 *
 * The single place where user gestures (sidebar buttons, commands,
 * notifications) are turned into controller calls. It also owns UI-only
 * state (selection, Follow Agent) and the "follow" behaviour that moves the
 * editor as the agent works. All agent state lives in the controller and
 * recorder; this class only reads it.
 */
export class HumanControlManager implements vscode.Disposable {
  private follow: boolean;
  private selectedTaskId: string | undefined;
  private selectedOperationId: string | undefined;
  private readonly viewEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeView = this.viewEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBar: vscode.StatusBarItem;
  private navigationQueue: Promise<unknown> = Promise.resolve();
  private promptedFor = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: AgentController,
    private readonly recorder: EventRecorder,
    private readonly navigator: CodeNavigator,
    private readonly review: ChangeReviewManager,
    private readonly log: vscode.OutputChannel,
    private readonly starters: TaskStarters,
  ) {
    const configured = vscode.workspace.getConfiguration('visualAgent').get<boolean>('followAgentByDefault', true);
    // Stored in workspaceState (not settings.json) so toggling never writes workspace files.
    this.follow = context.workspaceState.get<boolean>(FOLLOW_KEY, configured);
    this.selectedTaskId = context.workspaceState.get<string>(SELECTED_CONVERSATION_KEY);

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = 'visualAgent.activity.focus';
    this.disposables.push(this.statusBar, this.viewEmitter);

    const recSub = recorder.onDidChange((c) => this.onRecorderChange(c));
    const ctlSub = controller.onDidChangeState((s) => this.onControllerState(s));
    const chgSub = controller.onDidProposeChange((c) => this.review.prepare(c));
    this.disposables.push({ dispose: () => [recSub, ctlSub, chgSub].forEach((d) => d.dispose()) });

    this.onControllerState(controller.getSnapshot());
  }

  // --------------------------------------------------------------- public

  registerCommands(): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));
    reg('visualAgent.startDemo', () => this.runAction('start'));
    // The Codex entry now opens the unified New Agent Task panel (Codex preselected).
    reg('visualAgent.startCodex', () => vscode.commands.executeCommand('visualAgent.newAgentTask', 'codex'));
    reg('visualAgent.endSession', () => this.runAction('endSession'));
    reg('visualAgent.steer', () => this.runAction('steer'));
    reg('visualAgent.pause', () => this.runAction('pause'));
    reg('visualAgent.resume', () => this.runAction('resume'));
    reg('visualAgent.stop', () => this.runAction('stop'));
    reg('visualAgent.approve', (id) => this.runAction('approve', asOperationId(id)));
    reg('visualAgent.reject', (id) => this.runAction('reject', asOperationId(id)));
    reg('visualAgent.review', (id) => this.runAction('review', asOperationId(id)));
    reg('visualAgent.revealOperation', (id) => this.runAction('reveal', asOperationId(id)));
    reg('visualAgent.showCommandOutput', (id) => this.runAction('showOutput', asOperationId(id)));
    reg('visualAgent.showSummary', () => this.runAction('summary'));
    reg('visualAgent.showConversation', () => this.runAction('conversation'));
    reg('visualAgent.followOn', () => this.setFollow(true));
    reg('visualAgent.followOff', () => this.setFollow(false));
    reg('visualAgent.toggleFollow', () => this.setFollow(!this.follow));
    reg('visualAgent.clearHistory', () => this.clearHistory());
    reg('visualAgent.selectLanguage', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '中文', description: 'Simplified Chinese', value: 'zh-CN' },
          { label: 'English', value: 'en' },
          { label: '中英双语', description: 'Bilingual', value: 'bilingual' },
        ].map((x) => ({ ...x, picked: x.value === this.language() })),
        { title: '语言 / Language' },
      );
      if (pick) {
        await this.setLanguage(pick.value);
      }
    });
  }

  /** UI + reviewer language (default 中文). Never affects the coding agent. */
  language(): UiLanguage {
    return normalizeLanguage(vscode.workspace.getConfiguration('visualAgent').get('language'));
  }

  /** Persisted as a user setting, so it survives VS Code restarts. */
  async setLanguage(value: unknown): Promise<void> {
    const lang = normalizeLanguage(value);
    await vscode.workspace.getConfiguration('visualAgent').update('language', lang, vscode.ConfigurationTarget.Global);
    this.viewEmitter.fire();
  }

  refreshView(): void {
    this.viewEmitter.fire();
  }

  getSelection(): { taskId?: string; operationId?: string } {
    return { taskId: this.selectedTaskId, operationId: this.selectedOperationId };
  }

  getViewModel(): ActivityViewModel {
    return buildActivityViewModel(this.recorder, this.controller.getSnapshot(), {
      reviewerEnabled: vscode.workspace.getConfiguration('visualAgent').get<boolean>('reviewer.enabled', true),
      language: this.language(),
      follow: this.follow,
      selectedTaskId: this.selectedTaskId,
      selectedOperationId: this.selectedOperationId,
    });
  }

  selectTask(taskId: string): void {
    if (!this.recorder.getTask(taskId)) {
      return;
    }
    this.selectedTaskId = taskId;
    this.selectedOperationId = undefined;
    void this.context.workspaceState.update(SELECTED_CONVERSATION_KEY, taskId);
    this.viewEmitter.fire();
  }

  selectOperation(operationId: string, opts: { reveal: boolean }): void {
    const op = this.recorder.getOperation(operationId);
    if (!op) {
      return;
    }
    this.selectedTaskId = op.taskId;
    void this.context.workspaceState.update(SELECTED_CONVERSATION_KEY, op.taskId);
    this.selectedOperationId = operationId;
    this.viewEmitter.fire();
    if (opts.reveal && op.filePath) {
      void this.revealOperation(op, true);
    }
  }

  async setFollow(value: boolean): Promise<void> {
    this.follow = value;
    await this.context.workspaceState.update(FOLLOW_KEY, value);
    await vscode.commands.executeCommand('setContext', 'visualAgent.followAgent', value);
    this.viewEmitter.fire();
  }

  async runAction(action: ControlAction, operationId?: string): Promise<void> {
    try {
      switch (action) {
        case 'start':
          return await this.start();
        case 'startCodex':
          return await this.startCodex();
        case 'steer':
          return await this.steer();
        // Local AI / export: explicit user actions only, delegated to their own modules.
        case 'aiReviewChange':
          await vscode.commands.executeCommand('visualAgent.reviewer.reviewChange', operationId);
          return;
        case 'aiExplainError':
          await vscode.commands.executeCommand('visualAgent.reviewer.explainError', operationId);
          return;
        case 'newTask':
          await vscode.commands.executeCommand('visualAgent.newAgentTask');
          return;
        case 'openChat':
          await vscode.commands.executeCommand('visualAgent.openConversations', this.selectedTaskId ?? this.recorder.getTasks()[0]?.taskId);
          return;
        case 'continueHistory':
          await vscode.commands.executeCommand('visualAgent.continueHistory', this.selectedTaskId ?? this.recorder.getTasks()[0]?.taskId);
          return;
        case 'conversation': {
          const id = this.selectedTaskId ?? this.recorder.getTasks()[0]?.taskId;
          if (id) await this.openRecord(RecordDocumentProvider.conversationUri(id), 'markdown');
          return;
        }
        case 'endSession':
          return this.feedback(await this.controller.endSession(), 'No multi-turn session is running.');
        case 'exportContext':
          await vscode.commands.executeCommand('visualAgent.exportReviewContext', operationId);
          return;
        case 'pause':
          return this.feedback(this.controller.pause(), 'There is no running task to pause.');
        case 'resume':
          return this.feedback(this.controller.resume(), 'The task is not paused.');
        case 'stop':
          return this.feedback(this.controller.stop(), 'There is no running task to stop.');
        case 'approve':
          return this.approve(operationId);
        case 'reject':
          return await this.reject(operationId);
        case 'review':
          return await this.reviewOperation(operationId);
        case 'reveal': {
          const op = this.resolveOp(operationId);
          if (op) {
            this.selectOperation(op.operationId, { reveal: false });
            await this.revealOperation(op, true);
          }
          return;
        }
        case 'showOutput': {
          const op = this.resolveOp(operationId);
          if (op?.command) {
            await this.openRecord(RecordDocumentProvider.commandUri(op.operationId), 'log');
          } else {
            void vscode.window.showInformationMessage('This operation has no associated command.');
          }
          return;
        }
        case 'summary': {
          const taskId = this.selectedTaskId ?? this.recorder.getTasks()[0]?.taskId;
          if (!taskId) {
            void vscode.window.showInformationMessage('No tasks recorded yet.');
            return;
          }
          await this.openRecord(RecordDocumentProvider.summaryUri(taskId), 'markdown');
          return;
        }
      }
    } catch (err) {
      this.log.appendLine(`[control] ${action} failed: ${String(err)}`);
      void vscode.window.showErrorMessage(`Visual Agent: ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  // -------------------------------------------------------------- actions

  private async start(): Promise<void> {
    if (this.controller.isActive) {
      void vscode.window.showWarningMessage('A task is already running. Stop it first.');
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      const choice = await vscode.window.showWarningMessage(
        'No folder is open. The demo expects the bundled "demo-workspace" folder; without it, navigation will report missing files.',
        { modal: true },
        'Run Anyway',
      );
      if (choice !== 'Run Anyway') {
        return;
      }
    }
    this.promptedFor.clear();
    const taskId = this.starters.demo();
    this.selectedTaskId = taskId;
    this.selectedOperationId = undefined;
    this.log.appendLine(`[control] started simulated task ${taskId}`);
    this.viewEmitter.fire();
  }

  private async startCodex(): Promise<void> {
    if (this.controller.isActive) {
      void vscode.window.showWarningMessage('A task is already running. Stop it first.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first. Codex runs in the first workspace folder.');
      return;
    }
    const instructions = await vscode.window.showInputBox({
      title: 'Codex task',
      prompt: `Instructions for Codex. It works in ${root}.`,
      placeHolder: 'e.g. Explain what validate_samples() checks',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? (v.length > 4000 ? 'Maximum 4000 characters' : undefined) : 'Enter instructions'),
    });
    if (!instructions) {
      return;
    }
    const preferred = vscode.workspace.getConfiguration('visualAgent').get<string>('codex.defaultProfile', 'observe');
    const items = Object.values(CODEX_PROFILES)
      .sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0))
      .map((p) => ({ label: p.label, detail: p.detail, id: p.id }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Codex safety profile', ignoreFocusOut: true });
    if (!picked) {
      return;
    }
    if (picked.id === 'approve-edits' && !(await this.confirmEditableWorkspace(root))) {
      return;
    }
    this.promptedFor.clear();
    const taskId = this.starters.codex(instructions.trim(), picked.id);
    this.selectedTaskId = taskId;
    this.selectedOperationId = undefined;
    this.log.appendLine(`[control] started Codex task ${taskId} (${picked.id})`);
    this.viewEmitter.fire();
  }

  /** Edits are only offered in git repositories, so every approved patch can be reviewed and reverted. */
  private async confirmEditableWorkspace(root: string): Promise<boolean> {
    const status = await gitStatus(root);
    if (status === undefined) {
      void vscode.window.showErrorMessage(
        '"Approve each command and each edit" requires the workspace to be a git repository, so approved patches can be reviewed and reverted.',
      );
      return false;
    }
    if (status.trim()) {
      const choice = await vscode.window.showWarningMessage(
        'The workspace has uncommitted changes. Patches you approve would be mixed with them. Commit or stash first, or continue anyway?',
        { modal: true },
        'Continue Anyway',
      );
      return choice === 'Continue Anyway';
    }
    return true;
  }

  private async steer(): Promise<void> {
    const s = this.controller.getSnapshot();
    if (!this.controller.isActive || !s.capabilities.steer) {
      void vscode.window.showInformationMessage('No running task accepts instructions.');
      return;
    }
    const text = await vscode.window.showInputBox({
      title: `Send instruction to ${s.adapterName}`,
      prompt: 'Added to the active turn. It cannot change the sandbox or approval policy; pending approvals stay pending.',
      placeHolder: 'e.g. Do not modify tests; only change validation.py',
      ignoreFocusOut: true,
    });
    if (!text?.trim()) {
      return;
    }
    try {
      await this.controller.steer(text);
      vscode.window.setStatusBarMessage('$(check) Instruction delivered to the active turn', 4000);
    } catch (err) {
      void vscode.window.showErrorMessage(`Instruction not delivered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private approve(operationId?: string): void {
    const id = operationId ?? this.controller.getSnapshot().awaitingApprovalFor;
    if (!id || !this.controller.approve(id)) {
      void vscode.window.showWarningMessage(localizeError('That operation is not awaiting approval.', this.language()));
      return;
    }
    this.log.appendLine(`[control] approved ${id}`);
  }

  private async reject(operationId?: string): Promise<void> {
    const id = operationId ?? this.controller.getSnapshot().awaitingApprovalFor;
    if (!id || !this.controller.getSnapshot().pendingApprovals.includes(id)) {
      void vscode.window.showWarningMessage(localizeError('That operation is not awaiting approval.', this.language()));
      return;
    }
    const reason = await vscode.window.showInputBox({
      title: 'Reject proposed operation',
      prompt: 'Optional: why are you rejecting it? (recorded in the audit trail). Press Esc to cancel the rejection.',
      placeHolder: 'Reason (optional)',
    });
    if (reason === undefined) {
      return; // user cancelled the rejection itself
    }
    if (!this.controller.reject(id, reason.trim() || undefined)) {
      void vscode.window.showWarningMessage('The operation is no longer awaiting approval.');
      return;
    }
    this.log.appendLine(`[control] rejected ${id}${reason ? `: ${reason}` : ''}`);
  }

  private async reviewOperation(operationId?: string): Promise<void> {
    const op = this.resolveOp(operationId ?? this.selectedOperationId ?? this.controller.getSnapshot().awaitingApprovalFor);
    if (!op) {
      void vscode.window.showInformationMessage('Select an operation in Agent Activity to review it.');
      return;
    }
    this.selectOperation(op.operationId, { reveal: false });
    const task = this.recorder.getTask(op.taskId);
    this.navigator.setRoot(task?.workspaceRoot ?? task?.launch?.workspaceRoot);
    const changeIds = op.associatedChangeIds ?? (op.associatedChangeId ? [op.associatedChangeId] : []);
    if (changeIds.length > 1) {
      const pick = await vscode.window.showQuickPick(
        changeIds.map((id) => ({ label: this.recorder.getChange(id)?.filePath ?? id, id })),
        { title: 'This patch changes several files. A decision covers all of them.' },
      );
      if (pick) {
        await this.review.showDiff(pick.id, { preserveFocus: false });
      }
    } else if (changeIds.length === 1) {
      await this.review.showDiff(changeIds[0], { preserveFocus: false });
    } else {
      await this.openRecord(RecordDocumentProvider.operationUri(op.operationId), 'markdown');
    }
  }

  private async clearHistory(): Promise<void> {
    if (this.controller.isActive) {
      void vscode.window.showWarningMessage('Stop the running task before clearing history.');
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      'Clear all recorded agent operations for this workspace?',
      { modal: true },
      'Clear History',
    );
    if (ok === 'Clear History') {
      this.recorder.clear();
      this.review.clear();
      this.navigator.clearHighlight();
      this.selectedTaskId = undefined;
      void this.context.workspaceState.update(SELECTED_CONVERSATION_KEY, undefined);
      this.selectedOperationId = undefined;
      this.viewEmitter.fire();
    }
  }

  // ------------------------------------------------------- state handlers

  private onRecorderChange(change: RecorderChange): void {
    if (change.kind === 'reset') {
      this.viewEmitter.fire();
      return;
    }
    if (change.kind !== 'operation') {
      this.viewEmitter.fire();
      return;
    }
    const op = change.operation;
    const isNew = change.previousStatus === undefined;
    const isLive = this.controller.getSnapshot().taskId === op.taskId && this.controller.isActive;

    // Keep the details pane on the agent's latest operation while following.
    if (isNew && isLive && this.follow) {
      this.selectedTaskId = op.taskId;
      this.selectedOperationId = op.operationId;
    }
    this.viewEmitter.fire();

    if (!isLive) {
      return;
    }
    const startedRunning = op.status === 'Running' && change.previousStatus === 'Proposed';
    // Gated operations were already shown when the decision was requested.
    if (this.follow && op.filePath && startedRunning && !op.requiresApproval) {
      this.scheduleFollow(op);
    }
  }

  private followTarget: AgentOperation | undefined;
  private followTimer: NodeJS.Timeout | undefined;
  private lastFollowAt = 0;

  /**
   * Live Follow: coalesce bursts so the editor moves at most once per 300 ms,
   * always to the most recent operation. Recording is unaffected.
   */
  private scheduleFollow(op: AgentOperation): void {
    this.followTarget = op;
    if (this.followTimer) {
      return;
    }
    const wait = Math.max(0, 300 - (Date.now() - this.lastFollowAt));
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      const target = this.followTarget;
      this.followTarget = undefined;
      if (target && this.follow) {
        this.lastFollowAt = Date.now();
        void this.revealOperation(target, false);
      }
    }, wait);
  }

  /** Navigate to one of an edit operation's affected functions. */
  async gotoAffectedFunction(operationId: string, index: number): Promise<void> {
    const op = this.recorder.getOperation(operationId);
    const fn = op?.affectedFunctions?.[index];
    if (!op || !fn) {
      return;
    }
    // A function located on the original side no longer exists after the patch was applied.
    const lineOnly = fn.side === 'old' && op.status === 'Completed';
    const result = await this.navigator.navigate(
      {
        filePath: fn.filePath,
        workspaceRoot: this.recorder.getTask(op!.taskId)?.workspaceRoot ?? this.recorder.getTask(op!.taskId)?.launch?.workspaceRoot,
        functionName: lineOnly ? undefined : fn.name,
        lineNumber: fn.startLine,
        label: `◀ ${fn.name}() changed by operation #${op.sequenceNumber}`,
      },
      { preserveFocus: false, preview: true },
    );
    if (!result.ok) {
      void vscode.window.showWarningMessage(result.reason);
    } else if (result.warning) {
      void vscode.window.showWarningMessage(result.warning);
    }
  }

  /** Called once for every operation that enters the controller's pending-approval list. */
  private onDecisionRequested(op: AgentOperation): void {
    if (this.follow) {
      this.selectedTaskId = op.taskId;
      this.selectedOperationId = op.operationId;
      if (op.filePath) {
        void this.revealOperation(op, false);
      }
      if (op.associatedChangeId) {
        const changeId = op.associatedChangeId;
        this.navigationQueue = this.navigationQueue.then(() =>
          this.review.showDiff(changeId, { preserveFocus: true, viewColumn: vscode.ViewColumn.Beside }),
        );
      }
      this.viewEmitter.fire();
    }
    void this.promptForDecision(op);
  }

  private onControllerState(s: ControllerSnapshot): void {
    const active = s.taskStatus === 'Running';
    void vscode.commands.executeCommand('setContext', 'visualAgent.taskActive', active);
    void vscode.commands.executeCommand('setContext', 'visualAgent.paused', active && s.paused);
    void vscode.commands.executeCommand('setContext', 'visualAgent.awaitingApproval', active && !!s.awaitingApprovalFor);
    void vscode.commands.executeCommand('setContext', 'visualAgent.followAgent', this.follow);
    void vscode.commands.executeCommand('setContext', 'visualAgent.canPause', active && s.capabilities.pause);
    void vscode.commands.executeCommand('setContext', 'visualAgent.canSteer', active && s.capabilities.steer && (!s.capabilities.followUp || s.awaitingInput));
    void vscode.commands.executeCommand('setContext', 'visualAgent.canEndSession', active && !!s.capabilities.followUp && s.awaitingInput);

    for (const id of s.pendingApprovals) {
      if (!this.promptedFor.has(id)) {
        const op = this.recorder.getOperation(id);
        if (op) {
          this.onDecisionRequested(op);
        }
      }
    }

    if (active) {
      const sim = s.simulated ? ' (simulated)' : ' (real)';
      this.statusBar.text = s.awaitingApprovalFor
        ? `$(question) Agent: approval needed${sim}`
        : s.paused
          ? `$(debug-pause) Agent: paused${sim}`
          : s.awaitingInput
            ? `$(comment-discussion) Agent: turn complete · waiting for input${sim}`
          : `$(sync~spin) Agent: running${sim}`;
      this.statusBar.tooltip = 'Visual Agent Workspace: open Agent Activity';
      this.statusBar.show();
    } else {
      this.statusBar.hide();
      if (s.taskStatus !== 'Idle' && s.taskId) {
        void this.notifyFinished(s);
      }
    }
    this.viewEmitter.fire();
  }

  // -------------------------------------------------------------- helpers

  private async promptForDecision(op: AgentOperation): Promise<void> {
    if (this.promptedFor.has(op.operationId)) {
      return;
    }
    this.promptedFor.add(op.operationId);
    const target = [op.filePath, op.functionName && `${op.functionName}()`].filter(Boolean).join(' › ');
    const sim = op.simulated
      ? ' [SIMULATED: nothing will be written to disk]'
      : op.operationType === 'Edit'
        ? ' [REAL: approving lets Codex apply this ENTIRE patch]'
        : ' [REAL: Codex is waiting; approved commands still run in its read-only sandbox]';
    for (;;) {
      const options = op.associatedChangeId ? ['Review Diff', 'Approve', 'Reject'] : ['Approve', 'Reject'];
      const choice = await vscode.window.showInformationMessage(
        `Agent proposes: ${op.description}${target ? ` (${target})` : ''}.${sim}`,
        ...options,
      );
      if (!this.controller.getSnapshot().pendingApprovals.includes(op.operationId)) {
        return; // decided elsewhere (sidebar/command) or task stopped
      }
      if (choice === 'Review Diff') {
        await this.reviewOperation(op.operationId);
        continue; // re-prompt after reviewing
      }
      if (choice === 'Approve') {
        this.approve(op.operationId);
      } else if (choice === 'Reject') {
        await this.reject(op.operationId);
      }
      return; // dismissed: the sidebar still offers Approve/Reject
    }
  }

  private finishedNotified = new Set<string>();
  private async notifyFinished(s: ControllerSnapshot): Promise<void> {
    if (!s.taskId || this.finishedNotified.has(s.taskId)) {
      return;
    }
    this.finishedNotified.add(s.taskId);
    const choice = await vscode.window.showInformationMessage(
      `Agent task ${s.taskStatus.toLowerCase()}${s.simulated ? ' (simulated)' : ''}.`,
      'Show Summary',
    );
    if (choice === 'Show Summary') {
      await this.openRecord(RecordDocumentProvider.summaryUri(s.taskId), 'markdown');
    }
  }

  private revealOperation(op: AgentOperation, userInitiated: boolean): Promise<void> {
    const label = `◀ Agent: ${op.operationType}${op.functionName ? ` ${op.functionName}()` : ''}${op.simulated ? ' (simulated)' : ''}`;
    // Applied patches: highlight the actual changed lines in the file on disk.
    // Not-yet-applied patches: jump to where the change will land (the diff shows the content).
    const applied = op.operationType === 'Edit' && op.status === 'Completed' && !op.simulated;
    const highlightLines = applied
      ? op.changedRanges?.filter((r) => r.side === 'new' && r.filePath === op.filePath)
      : undefined;
    const task = this.navigationQueue.then(async () => {
      const result = await this.navigator.navigate(
        {
          filePath: op.filePath,
          workspaceRoot: this.recorder.getTask(op.taskId)?.workspaceRoot ?? this.recorder.getTask(op.taskId)?.launch?.workspaceRoot,
          functionName: highlightLines?.length ? undefined : op.functionName,
          lineNumber: op.lineNumber,
          label,
          highlightLines,
        },
        { preserveFocus: !userInitiated, preview: true },
      );
      if (!result.ok) {
        if (userInitiated) {
          void vscode.window.showWarningMessage(result.reason);
        } else {
          vscode.window.setStatusBarMessage(`$(warning) ${result.reason}`, 5000);
        }
      } else if (result.warning && userInitiated) {
        void vscode.window.showWarningMessage(result.warning);
      }
    });
    this.navigationQueue = task.catch(() => undefined);
    return task;
  }

  private resolveOp(operationId: string | undefined): AgentOperation | undefined {
    const id = operationId ?? this.selectedOperationId;
    const op = id ? this.recorder.getOperation(id) : undefined;
    if (!op) {
      void vscode.window.showInformationMessage('Select an operation in Agent Activity first.');
    }
    return op;
  }

  private async openRecord(uri: vscode.Uri, languageId: string): Promise<void> {
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== languageId) {
      doc = await vscode.languages.setTextDocumentLanguage(doc, languageId);
    }
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private feedback(ok: boolean, otherwise: string): void {
    if (!ok) {
      void vscode.window.showInformationMessage(otherwise);
    }
  }
}

/** Commands may receive an ID string or a tree node; accept only known shapes. */
function asOperationId(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object' && 'op' in arg) {
    const op = (arg as { op?: { operationId?: unknown } }).op;
    return typeof op?.operationId === 'string' ? op.operationId : undefined;
  }
  return undefined;
}

function gitStatus(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile('git', ['status', '--porcelain'], { cwd, windowsHide: true, timeout: 10_000 }, (err, out) =>
      resolve(err ? undefined : out),
    ),
  );
}
