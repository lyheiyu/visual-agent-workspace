import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SdkQueryFn } from './ClaudeCodeAdapter';

/**
 * Lazily load the ESM-only Claude Agent SDK from CommonJS. A static import
 * would be rewritten to require() and fail; `new Function` keeps a real
 * dynamic import. Loaded by absolute file URL, only when Claude Code is used.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

export function claudeSdkEntry(extensionRoot = path.resolve(__dirname, '..', '..', '..')): string | undefined {
  const entry = path.join(extensionRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
  return fs.existsSync(entry) ? entry : undefined;
}

export async function loadClaudeQuery(extensionRoot?: string): Promise<SdkQueryFn> {
  const entry = claudeSdkEntry(extensionRoot);
  if (!entry) {
    throw new Error('@anthropic-ai/claude-agent-sdk is not installed with the extension.');
  }
  const sdk = await importEsm(pathToFileURL(entry).href);
  if (typeof sdk.query !== 'function') {
    throw new Error('Installed @anthropic-ai/claude-agent-sdk does not export query().');
  }
  return sdk.query as SdkQueryFn;
}
