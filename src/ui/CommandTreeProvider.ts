import * as vscode from 'vscode';
import { EventRecorder } from '../recorder/EventRecorder';
import { AgentOperation, CommandStatus } from '../types/events';

type Node =
  | { kind: 'command'; op: AgentOperation; taskLabel: string }
  | { kind: 'detail'; parentId: string; label: string; value: string; icon?: string }
  | { kind: 'empty' };

const STATUS_ICON: Record<CommandStatus, [string, string?]> = {
  Pending: ['clock'],
  Running: ['sync~spin'],
  Succeeded: ['pass', 'testing.iconPassed'],
  Failed: ['error', 'testing.iconFailed'],
  Cancelled: ['circle-slash'],
  NotRun: ['circle-slash'],
};

/** "Agent Commands" view: every command associated with an operation. */
export class CommandTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: { dispose(): void };
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly recorder: EventRecorder) {
    this.sub = recorder.onDidChange(() => this.scheduleRefresh());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('No commands recorded yet.');
      item.description = 'Start the demo task to see simulated commands';
      return item;
    }
    if (node.kind === 'detail') {
      const item = new vscode.TreeItem(`${node.label}: ${node.value}`);
      item.tooltip = node.value;
      item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
      item.command = { command: 'visualAgent.showCommandOutput', title: 'Show output', arguments: [node.parentId] };
      return item;
    }
    const c = node.op.command!;
    const item = new vscode.TreeItem(c.command, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.op.operationId;
    const exit = c.exitCode !== undefined ? ` · exit ${c.exitCode}` : '';
    item.description = `${c.simulated ? 'SIMULATED · ' : ''}${c.status}${exit}`;
    const [icon, color] = STATUS_ICON[c.status];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = 'vawCommand';
    item.tooltip = new vscode.MarkdownString(
      [
        c.simulated ? '**Simulated** (not executed)' : '**Real execution**',
        `\`${c.command}\``,
        `Task: ${node.taskLabel}`,
        `Operation #${node.op.sequenceNumber}: ${node.op.description}`,
      ].join('\n\n'),
    );
    item.command = { command: 'visualAgent.showCommandOutput', title: 'Show output', arguments: [node.op.operationId] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const tasks = new Map(this.recorder.getTasks().map((t) => [t.taskId, t.description]));
      const ops = this.recorder
        .getOperations()
        .filter((o) => o.command)
        .reverse();
      if (!ops.length) {
        return [{ kind: 'empty' }];
      }
      return ops.map((op) => ({ kind: 'command', op, taskLabel: tasks.get(op.taskId) ?? op.taskId }));
    }
    if (node.kind !== 'command') {
      return [];
    }
    const c = node.op.command!;
    const id = node.op.operationId;
    const firstLine = (s?: string) => {
      const lines = (s ?? '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('[SIMULATED'));
      return lines.length ? lines[lines.length - 1].replace(/=+/g, '').trim() : '(none)';
    };
    const details: Node[] = [
      { kind: 'detail', parentId: id, label: 'Working directory', value: c.workingDirectory, icon: 'folder' },
      { kind: 'detail', parentId: id, label: 'Started', value: c.startedAt ?? '—', icon: 'watch' },
      { kind: 'detail', parentId: id, label: 'Finished', value: c.finishedAt ?? '—', icon: 'watch' },
      { kind: 'detail', parentId: id, label: 'Exit code', value: c.exitCode !== undefined ? String(c.exitCode) : '—', icon: 'symbol-number' },
      { kind: 'detail', parentId: id, label: 'stdout', value: firstLine(c.stdout), icon: 'output' },
      { kind: 'detail', parentId: id, label: 'stderr', value: firstLine(c.stderr), icon: 'warning' },
      { kind: 'detail', parentId: id, label: 'Operation', value: `#${node.op.sequenceNumber} ${node.op.operationType} (${node.op.status})`, icon: 'list-ordered' },
    ];
    return details;
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.emitter.fire(undefined);
    }, 100);
  }
}
