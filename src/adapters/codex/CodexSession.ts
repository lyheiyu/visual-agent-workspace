/**
 * Command-line overrides applied to every `codex app-server` we start, so a
 * Visual Agent session is isolated from features that could act outside the
 * observed/approved item stream. They apply only to this child process; the
 * user's ~/.codex/config.toml is never modified.
 */
export const ISOLATION_ARGS: readonly string[] = [
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '--disable', 'apps',
  '--disable', 'hooks',
  '--disable', 'multi_agent',
  '--disable', 'computer_use',
  '--disable', 'browser_use',
  '--disable', 'image_generation',
  '-c', 'mcp_servers={}',
];
