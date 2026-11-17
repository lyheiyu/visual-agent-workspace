import { redactSecrets } from '../recorder/redaction';
import { tailLines } from '../reviewer/prompts';
import { AgentOperation, ChangeRecord, TaskRecord } from '../types/events';

/**
 * Builds a self-contained Markdown "review context" from recorded evidence.
 * Pure; never sends anything anywhere. Every item is labelled:
 *   [verified] recorded from the agent's tool events or read from disk
 *   [derived]  computed deterministically from verified data (e.g. applying a recorded diff)
 *   [inferred] local parsing/heuristics; may be incomplete
 * No model-generated text is ever included.
 */

export type ExportScope = 'function' | 'change' | 'operations' | 'task';

export interface ExportCode {
  filePath: string;
  startLine: number; // 1-based
  code: string;
}

export interface ExportChange {
  record: ChangeRecord;
  operation?: AgentOperation;
  diff?: string;
  diffSource: 'recorded' | 'derived';
  /** Per affected function: code before and after (when available in memory). */
  functions: Array<{ name: string; original?: ExportCode; modified?: ExportCode }>;
  contentAvailable: boolean;
}

export interface ExportInput {
  scope: ExportScope;
  title: string;
  generatedAt: string;
  task?: TaskRecord;
  operations: AgentOperation[];
  changes: ExportChange[];
  fn?: { name?: string; code: ExportCode; nameSource: 'symbols' | 'parser' | 'selection' };
  related?: { callers: Array<{ filePath: string; line: number; callerFunction?: string; snippet: string }>; source: string };
  maxOutputLines?: number;
}

const FENCE = '```';

export function buildReviewContextMarkdown(input: ExportInput): string {
  const L: string[] = [];
  const outLines = input.maxOutputLines ?? 60;
  L.push(`# Review context: ${input.title}`);
  L.push('');
  L.push(`> Exported by Visual Agent Workspace on ${input.generatedAt}. Scope: **${input.scope}**.`);
  L.push('> Labels: **[verified]** recorded from the coding agent\'s tool events or read from disk · **[derived]** computed from verified data · **[inferred]** local parsing/heuristics, may be incomplete.');
  L.push('> Contains no model-generated text. Secrets matching common patterns are redacted.');
  L.push('');

  if (input.task) {
    const t = input.task;
    L.push('## Session [verified]');
    L.push('');
    L.push(`- Task: ${t.description}`);
    L.push(`- Agent: ${t.adapterName}${t.simulated ? ' — **SIMULATED** (mock demo: no real files changed, no real commands run)' : ''}`);
    L.push(`- Status: ${t.status} · started ${t.startedAt}${t.finishedAt ? ` · finished ${t.finishedAt}` : ''}`);
    L.push(`- Task ID: \`${t.taskId}\``);
    L.push('');
  }

  if (input.fn) {
    const f = input.fn;
    const nameLabel = f.nameSource === 'symbols' ? '[verified: language-server symbol]' : f.nameSource === 'parser' ? '[inferred: text parser]' : '';
    L.push(`## Function ${f.name ? `\`${f.name}\` ${nameLabel}` : '(selected code)'}`);
    L.push('');
    L.push(`- Location [verified, read from disk at export time]: \`${f.code.filePath}\` lines ${f.code.startLine}–${f.code.startLine + lineCount(f.code.code) - 1}`);
    L.push('');
    L.push(codeBlock(f.code));
    L.push('');
  }

  if (input.changes.length) {
    L.push('## Code changes');
    L.push('');
    for (const c of input.changes) {
      const op = c.operation;
      L.push(`### \`${c.record.filePath}\`${op ? ` — operation #${op.sequenceNumber}` : ''}`);
      L.push('');
      L.push(`- Decision [verified]: ${c.record.decision}${c.record.decisionReason ? ` — ${c.record.decisionReason}` : ''}${c.record.decidedAt ? ` (${c.record.decidedAt})` : ''}`);
      if (op) {
        L.push(`- Operation [verified]: ${op.operationType} · ${op.status} · control: ${controlText(op)} · \`${op.operationId}\``);
        const fns = (op.affectedFunctions ?? []).filter((f) => f.filePath === c.record.filePath);
        if (fns.length) {
          L.push(`- Affected functions [inferred: ${fns[0].source === 'symbols' ? 'language-server symbols' : 'text parser'}]: ${fns.map((f) => `\`${f.name}\` (${f.side === 'old' ? 'original' : 'patched'} file, lines ${f.startLine}–${f.endLine})`).join(', ')}`);
        }
        const ranges = (op.changedRanges ?? []).filter((r) => r.filePath === c.record.filePath);
        if (ranges.length) {
          L.push(`- Changed lines [derived from the diff]: ${ranges.map((r) => `${r.startLine}–${r.endLine}${r.side === 'old' ? ' (removed, original)' : ''}`).join(', ')}`);
        }
      }
      L.push('');
      if (!c.contentAvailable) {
        L.push('_Change content is no longer in memory (only kept during the session that recorded it); metadata only._');
        L.push('');
        continue;
      }
      if (c.diff) {
        L.push(`**Diff** [${c.diffSource === 'recorded' ? 'verified: exactly as reported by the agent' : 'derived: computed from the recorded before/after text'}]`);
        L.push('');
        L.push(`${FENCE}diff\n${c.diff.trim()}\n${FENCE}`);
        L.push('');
      }
      for (const f of c.functions) {
        if (f.original) {
          L.push(`**Original \`${f.name}\`** [verified: file snapshot taken when the change was proposed]`);
          L.push('');
          L.push(codeBlock(f.original));
          L.push('');
        }
        if (f.modified) {
          L.push(`**Modified \`${f.name}\`** [derived: snapshot with the recorded diff applied]`);
          L.push('');
          L.push(codeBlock(f.modified));
          L.push('');
        }
      }
    }
  }

  const commands = input.operations.filter((o) => o.command);
  if (commands.length) {
    L.push('## Commands and results');
    L.push('');
    for (const o of commands) {
      const c = o.command!;
      L.push(`### Operation #${o.sequenceNumber}: \`${c.command}\``);
      L.push('');
      L.push(`- ${c.simulated ? '**SIMULATED** [mock demo: not executed]' : '[verified: recorded from the agent tool layer]'}`);
      L.push(`- Status: ${c.status} · exit code: ${c.exitCode ?? '—'} · cwd: \`${c.workingDirectory}\``);
      L.push(`- Started: ${c.startedAt ?? '—'} · finished: ${c.finishedAt ?? '—'} · control: ${controlText(o)}`);
      const output = [c.stdout, c.stderr].filter(Boolean).join('\n');
      if (output.trim()) {
        L.push('');
        L.push(`Output${c.outputCombined ? ' (stdout+stderr combined, as reported)' : ''}, last ${outLines} lines:`);
        L.push('');
        L.push(`${FENCE}text\n${tailLines(output, outLines)}\n${FENCE}`);
      }
      L.push('');
    }
  }

  if (input.related && input.related.callers.length) {
    L.push(`## Related call sites [inferred: ${input.related.source}]`);
    L.push('');
    for (const c of input.related.callers) {
      L.push(`- \`${c.filePath}:${c.line}\`${c.callerFunction ? ` in \`${c.callerFunction}\`` : ''}: \`${c.snippet}\``);
    }
    L.push('');
  }

  if (input.operations.length) {
    L.push('## Operations [verified]');
    L.push('');
    L.push('| # | Type | Status | Control | Description | File |');
    L.push('|---|---|---|---|---|---|');
    for (const o of input.operations) {
      L.push(`| ${o.sequenceNumber} | ${o.operationType} | ${o.status} | ${controlText(o)} | ${cell(o.description)} | ${cell(o.filePath ?? '')} |`);
    }
    L.push('');
    L.push(`Operation IDs: ${input.operations.map((o) => `\`${o.operationId}\``).join(', ')}`);
    L.push('');
  }

  return redactSecrets(L.join('\n'));
}

function controlText(o: AgentOperation): string {
  const e = o.enforcement ?? 'controller';
  return e === 'none' ? 'observed' : e === 'agent-approval' ? 'intercepted' : o.simulated ? 'simulated' : 'controller';
}

function codeBlock(c: ExportCode): string {
  const lang = c.filePath.endsWith('.py') ? 'python' : /\.(ts|tsx)$/.test(c.filePath) ? 'typescript' : /\.(js|jsx|mjs|cjs)$/.test(c.filePath) ? 'javascript' : '';
  return `\`${c.filePath}:${c.startLine}\`\n\n${FENCE}${lang}\n${c.code.replace(/\r\n/g, '\n').replace(/\n$/, '')}\n${FENCE}`;
}

function lineCount(s: string): number {
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
}
