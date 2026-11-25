import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTaskContext, OperationSink, StreamingAgentAdapter, StreamingRunResult } from '../../adapters/AgentAdapter';
import { createUnifiedDiff } from '../../review/unifiedDiff';

export type FixtureChange = { rel: string; kind: 'add' | 'delete' | 'update'; after?: (before: string) => string };

/** A streaming agent that proposes multi-file patches and waits for the decision (like Codex fileChange approvals). */
export class MultiFileAgent implements StreamingAgentAdapter {
  readonly kind = 'streaming';
  readonly id = 'local';
  readonly displayName = 'Multi-file fixture agent';
  readonly simulated = false;
  readonly capabilities = { pause: false, interrupt: true, steer: false };
  readonly boundary = 'Fixture: proposes patches, writes only after approval';
  readonly replies: Array<{ decision: string; reason?: string }> = [];
  constructor(private readonly root: string, private readonly proposals: FixtureChange[][]) {}
  async run(_ctx: AgentTaskContext, sink: OperationSink): Promise<StreamingRunResult> {
    for (const proposal of this.proposals) {
      const read = (rel: string) => { try { return fs.readFileSync(path.join(this.root, rel), 'utf8'); } catch { return ''; } };
      const changes = proposal.map((c) => {
        const before = c.kind === 'add' ? '' : read(c.rel);
        const after = c.kind === 'delete' ? '' : c.after!(before);
        return { filePath: c.rel, changeKind: c.kind, unifiedDiff: createUnifiedDiff(before, after) ?? '', after };
      });
      const id = sink.announce({ operationType: 'Edit', description: `Edit ${changes.length} files`, filePath: changes[0].filePath, changes: changes.map(({ after: _a, ...c }) => c) });
      const r = await sink.requestDecision(id, 'Patch requires approval');
      this.replies.push(r);
      if (r.decision === 'cancelled') {
        sink.complete(id, { outcome: 'Cancelled' });
        return { outcome: 'interrupted' };
      }
      if (r.decision === 'approved') {
        for (const c of changes) {
          const abs = path.join(this.root, c.filePath);
          if (c.changeKind === 'delete') fs.rmSync(abs, { force: true });
          else fs.writeFileSync(abs, c.after);
        }
        sink.complete(id, { outcome: 'Completed' });
      } else {
        sink.complete(id, { outcome: 'Rejected' });
      }
    }
    return { outcome: 'completed' };
  }
  async interrupt(): Promise<void> {}
}
