import { isRecord } from '@garcon/common/json';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { unavailableTier, type CodexServiceTier } from '../service-tier.js';

interface CatalogReader {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}

function incompleteDiscovery(method: string): AgentIntegrationError {
  return new AgentIntegrationError('UNAVAILABLE', `Codex ${method} returned an incomplete catalog; retry speed selection.`, true);
}

// A settings notification echoes the selection even when inference would drop it.
// https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server/src/bespoke_event_handling.rs#L1301-L1318
export async function assertLoadedTierAvailable(
  client: CatalogReader, threadId: string, model: string,
  tier: CodexServiceTier, timeoutMs: number,
): Promise<void> {
  if (tier === 'default') return;
  const deadline = performance.now() + timeoutMs;
  const feature = tier === 'priority' ? 'fast_mode' : 'ultrafast_mode';
  const [entry, gate] = await Promise.all([
    findEntry('model/list', { includeHidden: true }, 'model', model),
    findEntry('experimentalFeature/list', { threadId }, 'name', feature),
  ]);
  if (!entry || !gate) throw unavailableTier(tier, model);
  if (typeof gate.enabled !== 'boolean') throw incompleteDiscovery('experimentalFeature/list');
  if (!Array.isArray(entry.serviceTiers) || !entry.serviceTiers.every((item) => isRecord(item) && typeof item.id === 'string')) {
    throw incompleteDiscovery('model/list');
  }
  if (!gate.enabled || !entry.serviceTiers.some((item) => item.id === tier)) {
    throw unavailableTier(tier, model);
  }

  async function findEntry(
    method: string, params: Record<string, unknown>, key: string, value: string,
  ): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw new AgentIntegrationError('TIMEOUT', `Codex ${method} timed out during speed discovery`, true);
      let result: unknown;
      try {
        result = await client.request(method, { ...params, cursor, limit: 100 }, remaining);
      } catch (error) {
        if (error instanceof AgentIntegrationError) throw error;
        // Native errors can contain executor configuration, paths or credentials.
        throw new AgentIntegrationError('UNAVAILABLE', `Codex ${method} could not verify speed; check the executor configuration and retry.`, true);
      }
      if (!isRecord(result) || !Array.isArray(result.data)) throw incompleteDiscovery(method);
      for (const row of result.data) {
        if (!isRecord(row) || typeof row[key] !== 'string') throw incompleteDiscovery(method);
        if (row[key] === value) return row;
      }
      if (result.nextCursor == null) return undefined;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) throw incompleteDiscovery(method);
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw incompleteDiscovery(method);
  }
}
