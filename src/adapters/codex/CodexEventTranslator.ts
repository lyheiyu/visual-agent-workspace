import { NormalizedAgentEvent } from '../normalizedEvents';
import { CodexItemMapper } from './CodexItemMapper';
import { ItemNotification, OutputDeltaNotification, RpcNotification, ThreadItem } from './protocol';

/**
 * Codex-specific: App Server notifications → normalized events.
 * Pure (no I/O besides the mapper's injected file reader) and side-effect
 * free towards Codex: translating never sends anything to the agent.
 */
export class CodexEventTranslator {
  private readonly announced = new Set<string>();
  /** fileChange item id → raw paths it will touch (for approval checks). */
  readonly patchPaths = new Map<string, string[]>();

  constructor(private readonly mapper: CodexItemMapper) {}

  translate(n: RpcNotification, wasDecided: (itemId: string) => boolean): NormalizedAgentEvent[] {
    switch (n.method) {
      case 'item/started': {
        const { item } = n.params as ItemNotification;
        const op = this.mapper.announce(item);
        if (!op || this.announced.has(item.id)) {
          return [];
        }
        this.announced.add(item.id);
        if (item.type === 'fileChange') {
          this.patchPaths.set(item.id, ((item as Extract<ThreadItem, { type: 'fileChange' }>).changes ?? []).map((c) => c.path));
        }
        return [{ type: 'operation.announced', key: item.id, op }];
      }
      case 'item/commandExecution/outputDelta': {
        const p = n.params as OutputDeltaNotification;
        return [
          {
            type: 'operation.running',
            key: p.itemId,
            note: wasDecided(p.itemId) ? 'Output received' : 'Output received: Codex is running this without having asked (observed only)',
          },
        ];
      }
      case 'item/completed': {
        const { item } = n.params as ItemNotification;
        if (this.announced.has(item.id)) {
          return [{ type: 'operation.completed', key: item.id, completion: this.mapper.completion(item) }];
        }
        const late = this.mapper.announceOnCompletion(item);
        if (!late) {
          return [];
        }
        this.announced.add(item.id);
        return [
          { type: 'operation.announced', key: item.id, op: late.op },
          { type: 'operation.completed', key: item.id, completion: late.completion },
        ];
      }
      case 'error': {
        const p = n.params as { error?: { message?: string }; willRetry?: boolean };
        return [{ type: 'log', message: `[codex] error${p.willRetry ? ' (retrying)' : ''}: ${p.error?.message ?? 'unknown'}` }];
      }
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
        return [{ type: 'log', message: `[codex] ${n.method}: ${JSON.stringify(n.params).slice(0, 300)}` }];
      default:
        // Deltas, token usage, status changes: not needed for the timeline.
        return [];
    }
  }

  /** Record that an operation was created outside item/started (approval arrived first). */
  markAnnounced(itemId: string): void {
    this.announced.add(itemId);
  }
}
