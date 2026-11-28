import { parseAgentUsageReport } from '../../../../../common/usage.ts';

export const sampleBucket = {
  day: '2026-10-26', model: 'synthetic-model',
  totals: { uncachedInputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 },
  costUsd: 0.5, categoryCostUsd: { input: 0.1, cacheRead: 0.1, cacheWrite: 0.1, output: 0.2 },
  cacheSavingsUsd: 0.05, records: 2, unpricedRecords: 0, unpricedTokens: 0, sessions: 1,
};

export const sampleReport = {
  status: 'ok', buckets: [sampleBucket], scannedFiles: 1, unreadableFiles: 0,
  malformedRecords: 0, distinctSessions: 1, pricingAsOf: '2026-10-27',
};

export function acceptsUsageTokenTotals(totals: unknown): boolean {
  return parseAgentUsageReport({ ...sampleReport, buckets: [{ ...sampleBucket, totals }] }) !== null;
}
