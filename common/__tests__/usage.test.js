import { describe, expect, it } from 'bun:test';

import {
  enumerateUsageDays,
  isUsageDay,
  MAX_USAGE_BUCKETS,
  parseAgentUsageReport,
  parseUsageReadRequest,
  parseUsageSummary,
  usageTotalTokens,
  usageWindowLength,
} from '../usage.ts';

const bucket = {
  day: '2026-10-26',
  model: 'synthetic-model',
  totals: { uncachedInputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 },
  costUsd: 0.5,
  categoryCostUsd: { input: 0.1, cacheRead: 0.1, cacheWrite: 0.1, output: 0.2 },
  cacheSavingsUsd: 0.05,
  records: 2,
  unpricedRecords: 0,
  unpricedTokens: 0,
  sessions: 1,
};

const report = {
  status: 'ok',
  buckets: [bucket],
  scannedFiles: 1,
  unreadableFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  pricingAsOf: '2026-10-27',
};

describe('usage contract', () => {
  it('validates calendar days and inclusive window lengths', () => {
    expect(isUsageDay('2026-10-27')).toBe(true);
    expect(isUsageDay('2026-02-30')).toBe(false);
    expect(isUsageDay('2026-10-27T00:00:00Z')).toBe(false);
    expect(usageWindowLength('2026-10-21', '2026-10-27')).toBe(7);
    expect(enumerateUsageDays('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(enumerateUsageDays('2026-11-02', '2026-10-30')).toEqual([]);
    expect(usageTotalTokens(bucket.totals)).toBe(10);
  });

  it('accepts windows of one to ninety days in a known zone', () => {
    expect(parseUsageReadRequest({ sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'UTC' })).toEqual({
      sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'UTC',
    });
    expect(parseUsageReadRequest({ sinceDay: '2026-07-30', untilDay: '2026-10-27', timeZone: 'Asia/Tokyo' })).not.toBeNull();
    expect(parseUsageReadRequest({ sinceDay: '2026-07-29', untilDay: '2026-10-27', timeZone: 'Asia/Tokyo' })).toBeNull();
    expect(parseUsageReadRequest({ sinceDay: '2026-10-28', untilDay: '2026-10-27', timeZone: 'UTC' })).toBeNull();
    expect(parseUsageReadRequest({ sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'Nowhere/Zone' })).toBeNull();
    expect(parseUsageReadRequest(null)).toBeNull();
  });

  it('round-trips agent reports and rejects impossible counts', () => {
    expect(parseAgentUsageReport(report)).toEqual(report);
    expect(parseAgentUsageReport({ ...report, status: 'failed' })).toBeNull();
    expect(parseAgentUsageReport({ ...report, scannedFiles: -1 })).toBeNull();
    expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, unpricedRecords: 3 }] })).toBeNull();
    expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, costUsd: Number.NaN }] })).toBeNull();
    expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, model: '' }] })).toBeNull();
    expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, totals: { ...bucket.totals, outputTokens: 1.5 } }] })).toBeNull();
    expect(parseAgentUsageReport({ ...report, buckets: Array.from({ length: MAX_USAGE_BUCKETS + 1 }, () => bucket) })).toBeNull();
  });

  it('round-trips summaries with failed agents', () => {
    const summary = {
      executorId: 'local',
      sinceDay: '2026-10-21',
      untilDay: '2026-10-27',
      timeZone: 'UTC',
      readAt: '2026-10-27T05:00:00.000Z',
      pricingAsOf: '2026-10-27',
      agents: [
        { agentId: 'claude', status: 'ok', message: null, buckets: [bucket], scannedFiles: 1, unreadableFiles: 0, malformedRecords: 0, distinctSessions: 1 },
        { agentId: 'codex', status: 'failed', message: 'Synthetic failure', buckets: [], scannedFiles: 0, unreadableFiles: 0, malformedRecords: 0, distinctSessions: 0 },
      ],
    };
    expect(parseUsageSummary(summary)).toEqual(summary);
    expect(parseUsageSummary({ ...summary, readAt: 'yesterday' })).toBeNull();
    expect(parseUsageSummary({ ...summary, agents: [{ ...summary.agents[1], message: 7 }] })).toBeNull();
    expect(parseUsageSummary({ ...summary, pricingAsOf: null })).toEqual({ ...summary, pricingAsOf: null });
  });
});
