import { EventLoopSteps } from '../../../../server-agents/common/src/shared/event-loop.ts';
import { UsageAggregator } from '../../../../server-agents/common/src/usage/usage-aggregator.ts';
import type { UsageRecord } from '../../../../server-agents/common/src/usage/usage-record.ts';

export async function aggregateUsage(model: string, counts: [number, number][]) {
  const window = { sinceDay: '2026-10-01', untilDay: '2026-10-31', timeZone: 'UTC' };
  const usage = new UsageAggregator(window);
  for (const [input, output] of counts) {
    const record: UsageRecord = {
      timestampMs: Date.parse('2026-10-10T00:00:00Z'),
      model,
      sessionId: 'session',
      totals: { uncachedInputTokens: input, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: output, reasoningTokens: 0 },
      cacheWrite1hTokens: 0,
      speed: 'standard',
      dedupeKey: null,
    };
    usage.add(record);
  }
  return usage.finish(new EventLoopSteps('usage-aggregation-test'));
}
