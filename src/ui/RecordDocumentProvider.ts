import * as vscode from 'vscode';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentOperation } from '../types/events';
import { conversationDocument } from '../recorder/conversation';

/**
 * Read-only virtual documents rendered from recorded history:
 *   /command/<operationId>.log   full command record + output
 *   /operation/<operationId>.md  operation details and audit trail
 *   /summary/<taskId>.md         task summary
 */
export class RecordDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'visual-agent-record';

  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly recorder: EventRecorder) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(RecordDocumentProvider.scheme, this),
      this.emitter,
    );
    const sub = recorder.onDidChange(() => {
      // Refresh any record documents currently open.
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === RecordDocumentProvider.scheme) {
          this.emitter.fire(doc.uri);
        }
      }
    });
    this.disposables.push({ dispose: () => sub.dispose() });
  }

  static commandUri(operationId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path: `/command/${operationId}.log` });
  }
  static operationUri(operationId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path: `/operation/${operationId}.md` });
  }
  static summaryUri(taskId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path: `/summary/${taskId}.md` });
  }
  static conversationUri(taskId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: this.scheme, path: `/conversation/${taskId}.md` });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const m = /^\/(command|operation|summary|conversation)\/([\w-]+)\.(log|md)$/.exec(uri.path);
    if (!m) {
      return 'Unknown record.';
    }
    const [, kind, id] = m;
    if (kind === 'conversation') {
      const task = this.recorder.getTask(id);
      return task ? conversationDocument(task, this.recorder.getOperations(id)) : 'Task not found.';
    }
    if (kind === 'summary') {
      const task = this.recorder.getTask(id);
      return task?.summary ?? (task ? `Task "${task.description}" is still ${task.status.toLowerCase()}…` : 'Task not found.');
    }
    const op = this.recorder.getOperation(id);
    if (!op) {
      return 'Operation not found (history may have been cleared).';
    }
    return kind === 'command' ? renderCommand(op) : renderOperation(op, this.recorder);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

function renderCommand(op: AgentOperation): string {
  const c = op.command;
  if (!c) {
    return 'This operation has no associated command.';
  }
  const lines = [
    c.simulated
      ? '##### SIMULATED COMMAND: nothing was executed. Output below is fabricated by the mock adapter. #####'
      : '##### Command record #####',
    '',
    `Command:           ${c.command}`,
    `Working directory: ${c.workingDirectory}`,
    `Status:            ${c.status}`,
    `Exit code:         ${c.exitCode ?? '—'}`,
    `Started:           ${c.startedAt ?? '—'}`,
    `Finished:          ${c.finishedAt ?? '—'}`,
    `Task:              ${op.taskId}`,
    `Operation:         #${op.sequenceNumber} ${op.operationId} (${op.operationType}: ${op.description})`,
    '',
    '----- stdout -----',
    c.stdout?.trim() ? c.stdout : '(none)',
    '',
    '----- stderr -----',
    c.stderr?.trim() ? c.stderr : '(none)',
  ];
  return lines.join('\n');
}

function renderOperation(op: AgentOperation, recorder: EventRecorder): string {
  const change = op.associatedChangeId ? recorder.getChange(op.associatedChangeId) : undefined;
  const lines = [
    `# Operation #${op.sequenceNumber}: ${op.operationType}${op.simulated ? ' (SIMULATED)' : ''}`,
    '',
    `- **Description:** ${op.description}`,
    `- **Status:** ${op.status}`,
    op.rationale ? `- **Rationale:** ${op.rationale}` : '',
    op.filePath ? `- **File:** \`${op.filePath}\`` : '',
    op.functionName ? `- **Function:** \`${op.functionName}()\`` : '',
    op.lineNumber ? `- **Line hint:** ${op.lineNumber}` : '',
    op.resultSummary ? `- **Result:** ${op.resultSummary}` : '',
    op.command ? `- **Command:** \`${op.command.command}\` (${op.command.status}, exit ${op.command.exitCode ?? '—'})` : '',
    change ? `- **Proposed change:** ${change.decision}${change.decisionReason ? ` — ${change.decisionReason}` : ''}` : '',
    `- **Source:** ${op.source}`,
    `- **Task ID:** ${op.taskId}`,
    `- **Operation ID:** ${op.operationId}`,
    '',
    '## Audit trail',
    ...op.history.map((h) => `- ${h.timestamp} — **${h.status}** by ${h.actor}${h.note ? `: ${h.note}` : ''}`),
  ];
  return lines.filter((l) => l !== '').join('\n').replace('## Audit trail', '\n## Audit trail');
}
