import { isRecord } from '@garcon/common/json';
import { unavailableTier, type CodexServiceTier } from '../service-tier.js';

interface CatalogReader {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
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
    findEntry('model/list', { includeHidden: true }, (row) => row.model === model),
    findEntry('experimentalFeature/list', { threadId }, (row) => row.name === feature),
  ]);
  if (gate?.enabled !== true || !Array.isArray(entry?.serviceTiers)
    || !entry.serviceTiers.some((item) => isRecord(item) && item.id === tier)) {
    throw unavailableTier(tier, model);
  }

  async function findEntry(
    method: string, params: Record<string, unknown>, matches: (row: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown> | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) break;
      const result = await client.request(method, { ...params, cursor, limit: 100 }, remaining);
      if (!isRecord(result) || !Array.isArray(result.data)) break;
      const entry = result.data.find((row: unknown) => isRecord(row) && matches(row));
      if (isRecord(entry)) return entry;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      seen.add(cursor);
    }
  }
}
