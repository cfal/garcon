import { expect, test } from 'bun:test';
import {
  enumerateUsageDays, isUsageDay, isUsageTimeZone, isUsageWindowDays, isUsageWindowInRange,
  MAX_USAGE_BUCKETS, parseAgentUsageReport, parseUsageReadRequest, parseUsageSummary,
  usageDayFormatter, usageTotalTokens, usageWindowLength,
} from '../../../../../common/usage.ts';
import { sampleBucket as bucket, sampleReport as report } from './usage-guards.ts';

test('calendar days, windows and token totals', () => {
  expect(isUsageDay('2026-10-27')).toBe(true);
  expect(isUsageDay('2026-02-30')).toBe(false);
  expect(isUsageDay('2026-10-27T00:00:00Z')).toBe(false);
  expect(usageWindowLength('2026-10-21', '2026-10-27')).toBe(7);
  expect(enumerateUsageDays('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  expect(enumerateUsageDays('2026-11-02', '2026-10-30')).toEqual([]);
  expect(usageTotalTokens(bucket.totals)).toBe(10);
  expect(usageTotalTokens({ ...bucket.totals, uncachedInputTokens: Number.MAX_SAFE_INTEGER })).toBe(9007199254741000);
  for (const days of [7, 30, 90]) expect(isUsageWindowDays(days)).toBe(true);
  for (const days of [0, '7', 365, null]) expect(isUsageWindowDays(days)).toBe(false);
});

test('validates timezone identifiers and retained windows', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', '+05:30']) expect(isUsageTimeZone(zone)).toBe(true);
  for (const zone of ['', 'UTC ', 'Nowhere/Zone', 'UTC+02:00']) expect(isUsageTimeZone(zone)).toBe(false);
  expect(() => usageDayFormatter('Nowhere/Zone')).toThrow(RangeError);
  const now = Date.parse('2026-10-27T12:00:00Z');
  const westMorning = Date.parse('2026-10-27T11:59:00Z');
  expect(isUsageWindowInRange({ sinceDay: '2026-07-30', untilDay: '2026-10-27', timeZone: 'UTC' }, now)).toBe(true);
  expect(isUsageWindowInRange({ sinceDay: '2026-07-29', untilDay: '2026-10-26', timeZone: 'Etc/GMT+12' }, westMorning)).toBe(true);
  expect(isUsageWindowInRange({ sinceDay: '2026-07-28', untilDay: '2026-10-25', timeZone: 'Pacific/Kiritimati' }, now)).toBe(false);
  expect(isUsageWindowInRange({ sinceDay: '2026-07-01', untilDay: '2026-07-20', timeZone: 'UTC' }, now)).toBe(false);
  expect(isUsageWindowInRange({ sinceDay: '2026-10-22', untilDay: '2026-10-28', timeZone: 'Pacific/Kiritimati' }, now)).toBe(true);
  expect(isUsageWindowInRange({ sinceDay: '2026-10-25', untilDay: '2026-10-29', timeZone: 'UTC' }, now)).toBe(false);
});

test('reads valid windows of one to ninety days', () => {
  expect(parseUsageReadRequest({ sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'UTC' })).toEqual({
    sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'UTC',
  });
  expect(parseUsageReadRequest({ sinceDay: '2026-07-30', untilDay: '2026-10-27', timeZone: 'Asia/Tokyo' })).not.toBeNull();
  expect(parseUsageReadRequest({ sinceDay: '2026-07-29', untilDay: '2026-10-27', timeZone: 'Asia/Tokyo' })).toBeNull();
  expect(parseUsageReadRequest({ sinceDay: '2026-10-28', untilDay: '2026-10-27', timeZone: 'UTC' })).toBeNull();
  expect(parseUsageReadRequest({ sinceDay: '2026-10-27', untilDay: '2026-10-27', timeZone: 'Nowhere/Zone' })).toBeNull();
  expect(parseUsageReadRequest(null)).toBeNull();
});

test('validates reports and summaries after the JSON boundary', () => {
  expect(parseAgentUsageReport(report)).toEqual(report);
  expect(parseAgentUsageReport({ ...report, status: 'failed' })).toBeNull();
  expect(parseAgentUsageReport({ ...report, scannedFiles: -1 })).toBeNull();
  expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, unpricedRecords: 3 }] })).toBeNull();
  const invalidCost = JSON.parse(JSON.stringify({ ...report, buckets: [{ ...bucket, costUsd: Number.NaN }] }));
  expect(invalidCost.buckets[0].costUsd).toBeNull();
  expect(parseAgentUsageReport(invalidCost)).toBeNull();
  expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, model: '' }] })).toBeNull();
  expect(parseAgentUsageReport({ ...report, buckets: [{ ...bucket, totals: { ...bucket.totals, outputTokens: 1.5 } }] })).toBeNull();
  expect(parseAgentUsageReport({ ...report, buckets: Array.from({ length: MAX_USAGE_BUCKETS + 1 }, () => bucket) })).toBeNull();

  const summary = {
    executorId: 'local', sinceDay: '2026-10-21', untilDay: '2026-10-27', timeZone: 'UTC',
    readAt: '2026-10-27T05:00:00.000Z', pricingAsOf: '2026-10-27',
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
