import { AnnouncedOperation, OperationCompletion, OperationSink } from './AgentAdapter';

/**
 * Provider-independent event schema.
 *
 * Every streaming provider translates ITS OWN tool-layer events into these
 * (Codex: App Server notifications; Claude Code: PreToolUse/PostToolUse
 * hooks; a local agent: its tool executor). Only facts reported by the
 * agent's tool layer belong here — never model prose presented as evidence.
 *
 * `key` is the provider's stable id for the operation (Codex item id, Claude
 * tool_use_id, …); the applier maps it to the recorder's operation id.
 */
export type NormalizedAgentEvent =
  | { type: 'operation.announced'; key: string; op: AnnouncedOperation }
  | { type: 'operation.running'; key: string; note?: string }
  | { type: 'operation.completed'; key: string; completion: OperationCompletion }
  | { type: 'log'; message: string };

/** Shared: applies normalized events to the controller's OperationSink. */
export class NormalizedEventApplier {
  private readonly ids = new Map<string, string>();

  constructor(private readonly sink: OperationSink) {}

  apply(e: NormalizedAgentEvent): void {
    switch (e.type) {
      case 'operation.announced':
        if (!this.ids.has(e.key)) {
          this.ids.set(e.key, this.sink.announce(e.op));
        }
        return;
      case 'operation.running': {
        const id = this.ids.get(e.key);
        if (id) {
          this.sink.markRunning(id, e.note);
        }
        return;
      }
      case 'operation.completed': {
        const id = this.ids.get(e.key);
        if (id) {
          this.sink.complete(id, e.completion);
        }
        return;
      }
      case 'log':
        this.sink.log(e.message);
        return;
    }
  }

  operationId(key: string): string | undefined {
    return this.ids.get(key);
  }

  bind(key: string, operationId: string): void {
    if (!this.ids.has(key)) {
      this.ids.set(key, operationId);
    }
  }
}
