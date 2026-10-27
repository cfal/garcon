import { isRecord } from './json.js';

// Usage windows are calendar days in the viewer's zone, inclusive at both ends.
export const USAGE_WINDOW_DAYS = [7, 30, 90] as const;
export type UsageWindowDays = typeof USAGE_WINDOW_DAYS[number];
export const MAX_USAGE_WINDOW_DAYS = 90;
// Bounds one agent's report: a day-by-model bucket per used model per day.
export const MAX_USAGE_BUCKETS = 10_000;
export const MAX_USAGE_MODEL_NAME_LENGTH = 200;
// A cold read parses every transcript in the window; warm reads only stat files. Stays
// under the executor link's default RPC deadline so a timeout reports as a usage failure.
export const USAGE_READ_TIMEOUT_MS = 110_000;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

/** Input totals sum uncached input, cache reads, and cache writes; reasoning is already inside output. */
export interface UsageTokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface UsageCategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** One agent's usage of one model on one calendar day. Cost covers priced records only. */
export interface UsageBucket {
  readonly day: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly categoryCostUsd: UsageCategoryCost;
  readonly cacheSavingsUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly unpricedTokens: number;
  readonly sessions: number;
}

// `missing`: the agent keeps no transcripts on this executor. `partial`: some
// transcripts or records could not be read. `failed`: the read itself failed.
export type UsageSourceStatus = 'ok' | 'missing' | 'partial' | 'failed';

export interface UsageReadRequest {
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly timeZone: string;
}

/** What one agent integration reports for a window on its executor. */
export interface AgentUsageReport {
  readonly status: Exclude<UsageSourceStatus, 'failed'>;
  readonly buckets: readonly UsageBucket[];
  readonly scannedFiles: number;
  readonly unreadableFiles: number;
  readonly malformedRecords: number;
  // Distinct across the window; bucket counts repeat sessions spanning days or models.
  readonly distinctSessions: number;
  // Date of the built-in price table that priced the buckets.
  readonly pricingAsOf: string;
}

export interface UsageAgentSummary {
  readonly agentId: string;
  readonly status: UsageSourceStatus;
  readonly message: string | null;
  readonly buckets: readonly UsageBucket[];
  readonly scannedFiles: number;
  readonly unreadableFiles: number;
  readonly malformedRecords: number;
  readonly distinctSessions: number;
}

export interface UsageSummary extends UsageReadRequest {
  readonly executorId: string;
  readonly readAt: string;
  readonly pricingAsOf: string | null;
  readonly agents: readonly UsageAgentSummary[];
}

export const EMPTY_USAGE_TOTALS: UsageTokenTotals = Object.freeze({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

export const EMPTY_USAGE_CATEGORY_COST: UsageCategoryCost = Object.freeze({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
});

export function usageTotalTokens(totals: UsageTokenTotals): number {
  return totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheWriteTokens + totals.outputTokens;
}

export function isUsageWindowDays(value: unknown): value is UsageWindowDays {
  return USAGE_WINDOW_DAYS.some((days) => days === value);
}

export function isUsageDay(value: unknown): value is string {
  if (typeof value !== 'string' || !USAGE_DAY_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function isUsageTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats instants as `YYYY-MM-DD` calendar days in a zone. Builds the day from
 * date parts so it does not depend on any locale's date order. Throws a
 * RangeError for an unknown zone.
 */
export function usageDayFormatter(timeZone: string): (time: number | Date) => string {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return (time) => {
    let year = '';
    let month = '';
    let day = '';
    for (const part of format.formatToParts(time)) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
    }
    return `${year.padStart(4, '0')}-${month}-${day}`;
  };
}

/** Number of calendar days in an inclusive window. */
export function usageWindowLength(sinceDay: string, untilDay: string): number {
  return Math.round((Date.parse(`${untilDay}T00:00:00Z`) - Date.parse(`${sinceDay}T00:00:00Z`)) / DAY_MS) + 1;
}

export function enumerateUsageDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let cursor = start; cursor <= end; cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export function parseUsageReadRequest(value: unknown): UsageReadRequest | null {
  if (!isRecord(value)) return null;
  const { sinceDay, untilDay, timeZone } = value;
  if (!isUsageDay(sinceDay) || !isUsageDay(untilDay) || !isUsageTimeZone(timeZone)) return null;
  const length = usageWindowLength(sinceDay, untilDay);
  if (length < 1 || length > MAX_USAGE_WINDOW_DAYS) return null;
  return { sinceDay, untilDay, timeZone };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseTotals(value: unknown): UsageTokenTotals | null {
  if (!isRecord(value)) return null;
  const totals = {
    uncachedInputTokens: count(value.uncachedInputTokens),
    cachedInputTokens: count(value.cachedInputTokens),
    cacheWriteTokens: count(value.cacheWriteTokens),
    outputTokens: count(value.outputTokens),
    reasoningTokens: count(value.reasoningTokens),
  };
  return Object.values(totals).every((entry) => entry !== null) ? totals as UsageTokenTotals : null;
}

function parseCategoryCost(value: unknown): UsageCategoryCost | null {
  if (!isRecord(value)) return null;
  const cost = {
    input: amount(value.input),
    cacheRead: amount(value.cacheRead),
    cacheWrite: amount(value.cacheWrite),
    output: amount(value.output),
  };
  return Object.values(cost).every((entry) => entry !== null) ? cost as UsageCategoryCost : null;
}

function parseBucket(value: unknown): UsageBucket | null {
  if (!isRecord(value) || !isUsageDay(value.day)) return null;
  const model = value.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_USAGE_MODEL_NAME_LENGTH) return null;
  const totals = parseTotals(value.totals);
  const categoryCostUsd = parseCategoryCost(value.categoryCostUsd);
  const costUsd = amount(value.costUsd);
  const cacheSavingsUsd = amount(value.cacheSavingsUsd);
  const records = count(value.records);
  const unpricedRecords = count(value.unpricedRecords);
  const unpricedTokens = count(value.unpricedTokens);
  const sessions = count(value.sessions);
  if (!totals || !categoryCostUsd || costUsd === null || cacheSavingsUsd === null || records === null
    || unpricedRecords === null || unpricedTokens === null || sessions === null || unpricedRecords > records) {
    return null;
  }
  return {
    day: value.day, model, totals, costUsd, categoryCostUsd, cacheSavingsUsd,
    records, unpricedRecords, unpricedTokens, sessions,
  };
}

function parseBuckets(value: unknown): readonly UsageBucket[] | null {
  if (!Array.isArray(value) || value.length > MAX_USAGE_BUCKETS) return null;
  const buckets: UsageBucket[] = [];
  for (const entry of value) {
    const bucket = parseBucket(entry);
    if (!bucket) return null;
    buckets.push(bucket);
  }
  return buckets;
}

function parseSourceCounts(value: Record<string, unknown>) {
  const counts = {
    scannedFiles: count(value.scannedFiles),
    unreadableFiles: count(value.unreadableFiles),
    malformedRecords: count(value.malformedRecords),
    distinctSessions: count(value.distinctSessions),
  };
  return Object.values(counts).every((entry) => entry !== null)
    ? counts as Pick<AgentUsageReport, 'scannedFiles' | 'unreadableFiles' | 'malformedRecords' | 'distinctSessions'>
    : null;
}

export function parseAgentUsageReport(value: unknown): AgentUsageReport | null {
  if (!isRecord(value)) return null;
  const { status, pricingAsOf } = value;
  if (status !== 'ok' && status !== 'missing' && status !== 'partial') return null;
  if (!isUsageDay(pricingAsOf)) return null;
  const buckets = parseBuckets(value.buckets);
  const counts = parseSourceCounts(value);
  if (!buckets || !counts) return null;
  return { status, buckets, ...counts, pricingAsOf };
}

function parseAgentSummary(value: unknown): UsageAgentSummary | null {
  if (!isRecord(value)) return null;
  const { agentId, status, message } = value;
  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 64) return null;
  if (status !== 'ok' && status !== 'missing' && status !== 'partial' && status !== 'failed') return null;
  if (message !== null && (typeof message !== 'string' || message.length > 2000)) return null;
  const buckets = parseBuckets(value.buckets);
  const counts = parseSourceCounts(value);
  if (!buckets || !counts) return null;
  return { agentId, status, message, buckets, ...counts };
}

export function parseUsageSummary(value: unknown): UsageSummary | null {
  if (!isRecord(value)) return null;
  const request = parseUsageReadRequest(value);
  const { executorId, readAt, pricingAsOf, agents } = value;
  if (!request || typeof executorId !== 'string' || typeof readAt !== 'string' || Number.isNaN(Date.parse(readAt))) return null;
  if (pricingAsOf !== null && !isUsageDay(pricingAsOf)) return null;
  if (!Array.isArray(agents) || agents.length > 64) return null;
  const parsedAgents: UsageAgentSummary[] = [];
  for (const entry of agents) {
    const agent = parseAgentSummary(entry);
    if (!agent) return null;
    parsedAgents.push(agent);
  }
  return { ...request, executorId, readAt, pricingAsOf, agents: parsedAgents };
}
