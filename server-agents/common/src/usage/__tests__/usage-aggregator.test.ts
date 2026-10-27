import { describe, expect, test } from 'bun:test';
import { EventLoopSteps } from '../../shared/event-loop.js';
import { UsageAggregator } from '../usage-aggregator.js';
import type { UsageRecord } from '../usage-record.js';

function record(timestamp: string, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    timestampMs: Date.parse(timestamp),
    model: 'claude-sonnet-5-5',
    sessionId: 'session-a',
    totals: { uncachedInputTokens: 100, cachedInputTokens: 1_000, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0 },
    cacheWrite1hTokens: 0,
    speed: 'standard',
    dedupeKey: null,
    ...extra,
  };
}

async function aggregate(records: readonly UsageRecord[], timeZone = 'UTC', sinceDay = '2026-10-01', untilDay = '2026-10-31') {
  const aggregator = new UsageAggregator({ sinceDay, untilDay, timeZone });
  for (const entry of records) aggregator.add(entry);
  return aggregator.finish(new EventLoopSteps('usage-test'));
}

describe('usage aggregation', () => {
  test('buckets by calendar day in the requested zone', async () => {
    const late = record('2026-10-15T06:30:00Z');
    expect((await aggregate([late], 'UTC')).buckets.map((bucket) => bucket.day)).toEqual(['2026-10-15']);
    expect((await aggregate([late], 'America/Los_Angeles')).buckets.map((bucket) => bucket.day)).toEqual(['2026-10-14']);
    expect((await aggregate([late], 'Asia/Kolkata')).buckets.map((bucket) => bucket.day)).toEqual(['2026-10-15']);
  });

  test('drops records outside the window', async () => {
    const result = await aggregate([record('2026-09-30T23:59:59Z'), record('2026-10-01T00:00:00Z'), record('2026-11-01T00:00:00Z')]);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]!.records).toBe(1);
  });

  test('counts one copy of a request seen in several transcripts, at its earliest time', async () => {
    const original = record('2026-10-10T10:00:00Z', { dedupeKey: 'msg:req' });
    const forked = record('2026-10-12T10:00:00Z', { dedupeKey: 'msg:req', sessionId: 'session-b' });
    const streamed = record('2026-10-10T10:00:01Z', {
      dedupeKey: 'msg:req',
      totals: { ...original.totals, outputTokens: 80 },
    });
    const result = await aggregate([forked, original, streamed]);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ day: '2026-10-10', records: 1, sessions: 1 });
    expect(result.buckets[0]!.totals.outputTokens).toBe(80);
    expect(result.distinctSessions).toBe(1);
  });

  test('keeps unpriced usage as tokens without inventing a cost', async () => {
    const result = await aggregate([
      record('2026-10-10T10:00:00Z', { model: 'unreleased-model' }),
      record('2026-10-10T11:00:00Z'),
    ]);
    const unpriced = result.buckets.find((bucket) => bucket.model === 'unreleased-model');
    expect(unpriced).toMatchObject({ costUsd: 0, records: 1, unpricedRecords: 1, unpricedTokens: 1_150 });
    const priced = result.buckets.find((bucket) => bucket.model === 'claude-sonnet-5-5');
    expect(priced?.costUsd).toBeCloseTo((100 * 2 + 1_000 * 0.1 + 50 * 10) / 1_000_000, 6);
    expect(priced?.unpricedRecords).toBe(0);
  });

  test('sorts buckets by day and model and counts distinct sessions across them', async () => {
    const result = await aggregate([
      record('2026-10-11T10:00:00Z', { model: 'gpt-5.4', sessionId: 'session-b' }),
      record('2026-10-10T10:00:00Z', { model: 'gpt-5.4' }),
      record('2026-10-10T11:00:00Z', { model: 'claude-opus-5-5' }),
    ]);
    expect(result.buckets.map((bucket) => `${bucket.day} ${bucket.model}`)).toEqual([
      '2026-10-10 claude-opus-5-5',
      '2026-10-10 gpt-5.4',
      '2026-10-11 gpt-5.4',
    ]);
    expect(result.distinctSessions).toBe(2);
  });
});
