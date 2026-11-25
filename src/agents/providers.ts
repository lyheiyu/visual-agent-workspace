import { CodexRpcClient, StdioTransport } from '../adapters/codex/CodexRpcClient';
import { CodexLocation, codexEnvironment } from '../adapters/codex/codexLocator';
import { ISOLATION_ARGS } from '../adapters/codex/CodexSession';
import { CODEX_PROFILES } from '../adapters/codex/profiles';
import { claudeAuthFromEnv, SdkQueryFn, SdkUserMessage } from './claude/ClaudeCodeAdapter';
import type { ClaudeAuthentication } from './claude/ClaudeCodeAdapter';

export type ProviderId = 'codex' | 'claude-code' | 'local';

export interface ModelOption {
  id: string;
  label: string;
  detail?: string;
  /** False = shown but not selectable, with `reason`. */
  compatible: boolean;
  reason?: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
  contextLength?: number;
  sizeBytes?: number;
}

export interface ProfileOption {
  id: string;
  label: string;
  detail: string;
  writes: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  available: boolean;
  experimental: boolean;
  reason?: string;
  auth?: string;
  profiles: ProfileOption[];
}

export const LOCAL_PROFILES: ProfileOption[] = [
  { id: 'read-only', label: 'Read-only analysis', detail: 'Read, search and list only. Edits, shell commands, web and sub-agents are denied by the agent runtime.', writes: false },
  {
    id: 'approved-write',
    label: 'Approve each edit and command',
    detail: 'Every file edit (with its diff) and every shell command blocks until you approve it. Web, sub-agents, outside-workspace paths and secret files are denied.',
    writes: true,
  },
];

export function codexProfiles(): ProfileOption[] {
  return Object.values(CODEX_PROFILES).map((p) => ({ id: p.id, label: p.label, detail: p.detail, writes: p.fileChanges === 'ask-user' }));
}

// ------------------------------------------------------------------ Codex

export async function discoverCodexModels(location: CodexLocation, cwd: string): Promise<ModelOption[]> {
  const client = new CodexRpcClient(new StdioTransport(location.executable, [...ISOLATION_ARGS, 'app-server'], { cwd, env: codexEnvironment(location) }));
  try {
    await client.request('initialize', { clientInfo: { name: 'visual-agent-workspace', title: 'Visual Agent Workspace', version: '0.4.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }, 20_000);
    client.notify('initialized', {});
    const res = await client.request<{ data: Array<{ model: string; displayName?: string; description?: string; hidden: boolean; isDefault: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }>; defaultReasoningEffort?: string }> }>('model/list', {}, 20_000);
    return res.data
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.model,
        label: m.displayName ? `${m.displayName} (${m.model})` : m.model,
        detail: m.description,
        compatible: true,
        efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
        defaultEffort: m.defaultReasoningEffort,
        isDefault: m.isDefault,
      }));
  } finally {
    await client.close();
  }
}

// ------------------------------------------------------------------ Local (Ollama)

export interface OllamaModelInfo {
  name: string;
  size?: number;
  capabilities?: string[];
  contextLength?: number;
  parameterSize?: string;
  family?: string;
}

export async function discoverOllamaCodingModels(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<ModelOption[]> {
  const base = endpoint.replace(/\/+$/, '');
  const tags = (await (await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: Array<any> };
  const loaded = await loadedOllamaModels(base, fetchImpl).catch(() => []);
  const out: ModelOption[] = [];
  for (const m of tags.models ?? []) {
    let caps: string[] | undefined;
    let ctx: number | undefined;
    try {
      const show = (await (await fetchImpl(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(5000) })).json()) as any;
      caps = Array.isArray(show.capabilities) ? show.capabilities : undefined;
      const mi = show.model_info ?? {};
      const k = Object.keys(mi).find((x) => x.endsWith('.context_length'));
      const declared = k ? Number(mi[k]) : NaN;
      const configured = Number(/^num_ctx\s+(\d+)\s*$/m.exec(String(show.parameters ?? ''))?.[1]);
      const running = loaded.find((entry) => entry.name === m.name)?.contextLength ?? NaN;
      const known = [declared, configured, running].filter((n) => Number.isSafeInteger(n) && n > 0);
      ctx = known.length ? Math.min(...known) : undefined;
    } catch {
      /* show failed: compatibility unknown */
    }
    const tools = caps?.includes('tools');
    const embedding = caps?.includes('embedding') && !caps.includes('completion');
    out.push({
      id: m.name,
      label: m.name,
      detail: [m.details?.parameter_size, m.details?.quantization_level, ctx ? `ctx ${ctx}` : undefined, m.size ? `${(m.size / 1e9).toFixed(1)} GB` : undefined].filter(Boolean).join(' · '),
      compatible: !!tools && !embedding,
      reason: embedding ? 'embedding model' : tools ? undefined : caps ? 'no tool-calling support (required by the coding agent)' : 'capabilities unknown (ollama /api/show failed)',
      contextLength: ctx,
      sizeBytes: m.size,
    });
  }
  return out;
}

/** Loaded models (GET /api/ps) — used to warn before loading another large model. */
export async function loadedOllamaModels(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<Array<{ name: string; sizeVram: number; size: number; contextLength?: number; expiresAt?: string }>> {
  const r = (await (await fetchImpl(`${endpoint.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: any[] };
  return (r.models ?? []).map((m) => ({ name: m.name, sizeVram: m.size_vram ?? 0, size: m.size ?? 0, contextLength: m.context_length, expiresAt: m.expires_at }));
}

/** Explicit user action only: ask Ollama to unload a model now (keep_alive 0). */
export async function unloadOllamaModel(endpoint: string, model: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${endpoint.replace(/\/+$/, '')}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) });
}

// ------------------------------------------------------------------ Claude Code

/** Models from the Claude Code runtime itself (control request, no model inference). */
export async function discoverClaudeModels(queryFn: SdkQueryFn, cwd: string, env: NodeJS.ProcessEnv, executable?: string): Promise<ModelOption[]> {
  const never: AsyncIterable<SdkUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) };
  const abort = new AbortController();
  const q = queryFn({ prompt: never, options: { cwd, settingSources: [], env, abortController: abort, persistSession: false, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } });
  try {
    const models = (await q.supportedModels?.()) ?? [];
    return models.map((m) => ({
      id: m.value,
      label: m.displayName ? `${m.displayName} (${m.value})` : m.value,
      detail: m.description,
      compatible: true,
      efforts: m.supportsEffort ? m.supportedEffortLevels ?? [] : [],
    }));
  } finally {
    abort.abort();
    q.close?.();
  }
}

export function claudeProviderInfo(env: NodeJS.ProcessEnv, sdkInstalled: boolean, authentication?: ClaudeAuthentication): ProviderInfo {
  const auth = authentication ?? claudeAuthFromEnv(env);
  return {
    id: 'claude-code',
    displayName: 'Claude Code (Agent SDK)',
    experimental: true,
    available: sdkInstalled && auth.ok,
    reason: !sdkInstalled ? 'Claude Agent SDK not installed with the extension.' : auth.reason,
    auth: auth.method,
    profiles: LOCAL_PROFILES,
  };
}
