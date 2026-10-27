import type { UsageBucket, UsageCategoryCost, UsageReadRequest, UsageTokenTotals } from '@garcon/common/usage';
import { usageTotalTokens } from '@garcon/common/usage';
import type { EventLoopSteps } from '../shared/event-loop.js';
import { priceUsageRecord } from './usage-pricing.js';
import type { UsageRecord } from './usage-record.js';

const QUARTER_HOUR_MS = 15 * 60 * 1000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface MutableBucket {
  readonly totals: Mutable<UsageTokenTotals>;
  readonly categoryCostUsd: Mutable<UsageCategoryCost>;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  unpricedTokens: number;
  readonly sessions: Set<string>;
}

export interface UsageAggregation {
  readonly buckets: readonly UsageBucket[];
  readonly distinctSessions: number;
}

// en-CA formats ISO-ordered calendar days in the requested zone. Quarter-hour
// slots that stay inside one day share a cached label, which avoids an Intl call
// per record; a slot that crosses midnight formats each timestamp.
function dayFormatter(timeZone: string): (timestampMs: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const slots = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = slots.get(slot);
    if (day === undefined) {
      const first = format.format(slot * QUARTER_HOUR_MS);
      const last = format.format((slot + 1) * QUARTER_HOUR_MS - 1);
      day = first === last ? first : null;
      slots.set(slot, day);
    }
    return day ?? format.format(timestampMs);
  };
}

/**
 * Buckets records by calendar day and model within a window. Records sharing a
 * dedupe key are one request copied into several transcripts, as forks and
 * resumed sessions do; the earliest copy is counted.
 */
export class UsageAggregator {
  readonly #window: UsageReadRequest;
  readonly #toDay: (timestampMs: number) => string;
  readonly #keyed = new Map<string, UsageRecord>();
  readonly #unkeyed: UsageRecord[] = [];

  constructor(window: UsageReadRequest) {
    this.#window = window;
    this.#toDay = dayFormatter(window.timeZone);
  }

  add(record: UsageRecord): void {
    if (record.dedupeKey === null) {
      this.#unkeyed.push(record);
      return;
    }
    const existing = this.#keyed.get(record.dedupeKey);
    this.#keyed.set(record.dedupeKey, existing ? mergeCopies(existing, record) : record);
  }

  async finish(steps: EventLoopSteps): Promise<UsageAggregation> {
    const buckets = new Map<string, MutableBucket>();
    const sessions = new Set<string>();
    const accumulate = (record: UsageRecord) => {
      const day = this.#toDay(record.timestampMs);
      if (day < this.#window.sinceDay || day > this.#window.untilDay) return;
      const key = `${day}\u0000${record.model}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          categoryCostUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          costUsd: 0,
          cacheSavingsUsd: 0,
          records: 0,
          unpricedRecords: 0,
          unpricedTokens: 0,
          sessions: new Set(),
        };
        buckets.set(key, bucket);
      }
      const totals = bucket.totals;
      totals.uncachedInputTokens += record.totals.uncachedInputTokens;
      totals.cachedInputTokens += record.totals.cachedInputTokens;
      totals.cacheWriteTokens += record.totals.cacheWriteTokens;
      totals.outputTokens += record.totals.outputTokens;
      totals.reasoningTokens += record.totals.reasoningTokens;
      bucket.records += 1;
      const priced = priceUsageRecord(record);
      if (priced) {
        bucket.costUsd += priced.costUsd;
        bucket.cacheSavingsUsd += priced.cacheSavingsUsd;
        bucket.categoryCostUsd.input += priced.categoryCostUsd.input;
        bucket.categoryCostUsd.cacheRead += priced.categoryCostUsd.cacheRead;
        bucket.categoryCostUsd.cacheWrite += priced.categoryCostUsd.cacheWrite;
        bucket.categoryCostUsd.output += priced.categoryCostUsd.output;
      } else {
        bucket.unpricedRecords += 1;
        bucket.unpricedTokens += usageTotalTokens(record.totals);
      }
      if (record.sessionId.length > 0) {
        bucket.sessions.add(record.sessionId);
        sessions.add(record.sessionId);
      }
    };
    await steps.forEach(this.#unkeyed, accumulate);
    await steps.forEach(this.#keyed.values(), accumulate);

    const result: UsageBucket[] = [];
    for (const [key, bucket] of buckets) {
      const separator = key.indexOf('\u0000');
      result.push({
        day: key.slice(0, separator),
        model: key.slice(separator + 1),
        totals: { ...bucket.totals },
        costUsd: roundUsd(bucket.costUsd),
        categoryCostUsd: {
          input: roundUsd(bucket.categoryCostUsd.input),
          cacheRead: roundUsd(bucket.categoryCostUsd.cacheRead),
          cacheWrite: roundUsd(bucket.categoryCostUsd.cacheWrite),
          output: roundUsd(bucket.categoryCostUsd.output),
        },
        cacheSavingsUsd: roundUsd(bucket.cacheSavingsUsd),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        unpricedTokens: bucket.unpricedTokens,
        sessions: bucket.sessions.size,
      });
    }
    result.sort((left, right) => left.day.localeCompare(right.day) || left.model.localeCompare(right.model));
    return { buckets: result, distinctSessions: sessions.size };
  }
}

// Copies normally repeat identical usage; when a streamed copy recorded counts
// before the response finished, the larger count is the final one.
function mergeCopies(left: UsageRecord, right: UsageRecord): UsageRecord {
  const earliest = right.timestampMs < left.timestampMs ? right : left;
  return {
    ...earliest,
    totals: {
      uncachedInputTokens: Math.max(left.totals.uncachedInputTokens, right.totals.uncachedInputTokens),
      cachedInputTokens: Math.max(left.totals.cachedInputTokens, right.totals.cachedInputTokens),
      cacheWriteTokens: Math.max(left.totals.cacheWriteTokens, right.totals.cacheWriteTokens),
      outputTokens: Math.max(left.totals.outputTokens, right.totals.outputTokens),
      reasoningTokens: Math.max(left.totals.reasoningTokens, right.totals.reasoningTokens),
    },
    cacheWrite1hTokens: Math.max(left.cacheWrite1hTokens, right.cacheWrite1hTokens),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
