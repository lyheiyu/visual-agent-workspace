import { AgentOperation } from '../types/events';
import {
  AgentAdapter,
  AgentTaskContext,
  ExecutionResult,
  OperationDecision,
  OperationRequest,
} from './AgentAdapter';
import { DEMO_SCENARIO, MockScenario, MockScenarioState } from './demoScenario';

export interface MockAdapterOptions {
  /** Multiplier applied to each step's simulated duration (0 in tests). */
  durationScale?: number;
}

/**
 * Mock Agent Adapter: replays a scripted scenario.
 *
 * Safety: this adapter never touches the filesystem and never spawns a
 * process. Every result it returns is fabricated from the scenario and
 * flagged `simulated`.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly displayName = 'Mock Agent (simulated)';
  readonly simulated = true;

  private index = 0;
  /** Step being handled. The controller handles one operation at a time. */
  private currentStep: number | undefined;
  private state: MockScenarioState = { workspaceRoot: '' };
  private readonly scale: number;

  constructor(
    private readonly scenario: MockScenario = DEMO_SCENARIO,
    options: MockAdapterOptions = {},
  ) {
    this.scale = options.durationScale ?? 1;
  }

  async beginTask(ctx: AgentTaskContext): Promise<void> {
    this.index = 0;
    this.currentStep = undefined;
    this.state = { workspaceRoot: ctx.workspaceRoot };
  }

  async nextOperation(): Promise<OperationRequest | undefined> {
    const step = this.scenario.steps[this.index];
    if (!step) {
      return undefined;
    }
    this.currentStep = this.index;
    this.index++;
    return step.request(this.state);
  }

  onDecision(op: Readonly<AgentOperation>, decision: OperationDecision): void {
    if (op.associatedChangeId) {
      this.state.editDecision = decision;
    }
  }

  async execute(_op: Readonly<AgentOperation>, signal: AbortSignal): Promise<ExecutionResult> {
    const step = this.currentStep === undefined ? undefined : this.scenario.steps[this.currentStep];
    const startedAt = new Date().toISOString();
    await abortableDelay((step?.durationMs ?? 300) * this.scale, signal);
    const sim = step?.simulate?.(this.state) ?? { outcome: 'Completed' as const };
    return {
      outcome: sim.outcome,
      resultSummary: sim.resultSummary,
      command: sim.command && {
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: sim.command.exitCode,
        stdout: sim.command.stdout,
        stderr: sim.command.stderr,
      },
    };
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
