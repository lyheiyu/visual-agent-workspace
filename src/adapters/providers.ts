/**
 * Provider registry: what each agent integration can and cannot do.
 * "planned" entries document the intended mapping onto the shared
 * interfaces; they are NOT implemented and are not offered in the UI.
 */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  status: 'available' | 'planned';
  adapterKind: 'pull' | 'streaming';
  /** Where operation facts come from (must be the agent's tool layer). */
  eventSource: string;
  /** What Visual Agent can enforce. */
  interception: string;
  notes?: string;
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    id: 'mock',
    displayName: 'Mock demo',
    status: 'available',
    adapterKind: 'pull',
    eventSource: 'Scripted scenario (simulated)',
    interception: 'Controller dispatches every step (simulated)',
  },
  {
    id: 'codex',
    displayName: 'Codex App Server',
    status: 'available',
    adapterKind: 'streaming',
    eventSource: 'codex app-server JSON-RPC notifications (item/started, item/completed, outputDelta) → CodexEventTranslator',
    interception: 'Real, when Codex requests approval (commandExecution/fileChange requestApproval); otherwise observed only',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    status: 'planned',
    adapterKind: 'streaming',
    eventSource: 'PreToolUse / PostToolUse hooks → normalized events (tool_use_id as key; Edit/Write inputs → changes; Bash → command)',
    interception: 'PreToolUse hook reply (allow/deny) driven by OperationSink.requestDecision',
    notes: 'Requires a hook bridge process; sessions not started with the bridge cannot be intercepted.',
  },
  {
    id: 'local-agent',
    displayName: 'Local coding agent (Ollama/Qwen)',
    status: 'planned',
    adapterKind: 'streaming',
    eventSource: "The agent's own tool executor (file writes, process exits). Model output alone is not evidence of execution.",
    interception: "Only if the agent's executor calls back before running a tool",
    notes: 'Visual Agent will not implement its own coding agent.',
  },
];
