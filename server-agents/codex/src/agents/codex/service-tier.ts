import type { AgentSpeed } from '@garcon/common/agent-speed';
import { isRecord } from '@garcon/common/json';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { CodexAppServerClient } from './app-server/client.js';

export function codexServiceTier(speed: AgentSpeed | undefined): 'default' | 'priority' {
  return speed === 'fast' ? 'priority' : 'default';
}

export function normalizeCodexServiceTier(tier: string | null | undefined): string {
  if (tier === 'fast') return 'priority';
  return tier ?? 'default';
}

// Codex omits unsupported tiers from inference requests instead of rejecting them.
// https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/core/src/session/mod.rs#L1298-L1329
export async function assertCodexFastModel(
  client: Pick<CodexAppServerClient, 'request'>,
  model: string,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.request<unknown>('model/list', { includeHidden: true, limit: 100, cursor });
    if (!isRecord(result) || !Array.isArray(result.data)) break;
    const entry = result.data.find((candidate) => isRecord(candidate)
      && (candidate.model === model || candidate.id === model));
    if (isRecord(entry)) {
      if (Array.isArray(entry.serviceTiers) && entry.serviceTiers.some((tier) =>
        isRecord(tier) && tier.id === 'priority')) return;
      break;
    }
    if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  throw new AgentIntegrationError(
    'INVALID_SETTINGS',
    `Fast mode is not advertised for model ${model}. Select a supported model or use Standard.`,
    false,
  );
}
