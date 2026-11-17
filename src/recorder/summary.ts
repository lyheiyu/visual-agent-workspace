import { AgentOperation, ChangeRecord, TaskRecord, TaskStatus } from '../types/events';

/**
 * Builds a factual task summary from recorded events (not from model-generated
 * prose), so the summary is only as good as — and never better than — the
 * audit trail.
 */
export function buildTaskSummary(
  task: TaskRecord,
  finalStatus: TaskStatus,
  operations: AgentOperation[],
  changes: ChangeRecord[],
  error?: string,
): string {
  const lines: string[] = [];
  const label = task.simulated ? ' (SIMULATED — no real files changed, no real commands run)' : '';
  lines.push(`# Task summary${label}`);
  lines.push('');
  lines.push(`- **Task:** ${task.description}`);
  lines.push(`- **Agent:** ${task.adapterName}`);
  lines.push(`- **Final status:** ${finalStatus}`);
  lines.push(`- **Started:** ${task.startedAt}`);
  if (error) {
    lines.push(`- **Error:** ${error}`);
  }
  lines.push('');

  const counts = new Map<string, number>();
  for (const op of operations) {
    counts.set(op.status, (counts.get(op.status) ?? 0) + 1);
  }
  lines.push(
    `**Operations:** ${operations.length} total — ` +
      ([...counts.entries()].map(([s, n]) => `${n} ${s}`).join(', ') || 'none'),
  );
  lines.push('');

  const files = [...new Set(operations.map((o) => o.filePath).filter((f): f is string => !!f))];
  if (files.length) {
    lines.push('**Files accessed:** ' + files.map((f) => `\`${f}\``).join(', '));
    lines.push('');
  }

  if (changes.length) {
    lines.push('## Proposed changes');
    for (const c of changes) {
      const target = c.functionName ? `${c.filePath} › ${c.functionName}()` : c.filePath;
      const reason = c.decisionReason ? ` — ${c.decisionReason}` : '';
      lines.push(`- \`${target}\`: **${c.decision}**${reason}`);
    }
    lines.push('');
  }

  const commands = operations.filter((o) => o.command);
  if (commands.length) {
    lines.push('## Commands');
    for (const o of commands) {
      const c = o.command!;
      const sim = c.simulated ? ' [simulated]' : '';
      const exit = c.exitCode !== undefined ? `, exit ${c.exitCode}` : '';
      lines.push(`- \`${c.command}\`${sim}: ${c.status}${exit}`);
    }
    lines.push('');
  }

  lines.push('## Timeline');
  for (const o of operations) {
    const where = [o.filePath, o.functionName && `${o.functionName}()`].filter(Boolean).join(' › ');
    lines.push(`${o.sequenceNumber}. [${o.status}] ${o.operationType}: ${o.description}${where ? ` (${where})` : ''}`);
  }
  return lines.join('\n');
}
