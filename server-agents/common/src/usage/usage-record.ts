import type { UsageTokenTotals } from '@garcon/common/usage';

// Anthropic fast mode and OpenAI priority processing bill above standard; OpenAI flex bills below.
export type UsageSpeed = 'standard' | 'fast' | 'flex';

/** One billed model request read from a native transcript. */
export interface UsageRecord {
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  // The part of totals.cacheWriteTokens written to the one-hour cache, which bills higher.
  readonly cacheWrite1hTokens: number;
  readonly speed: UsageSpeed;
  // Identifies copies of one request across transcripts; null when the format has none.
  readonly dedupeKey: string | null;
}

/** A usage line that could not be counted. Its time, when known, scopes it to a window. */
export interface MalformedUsage {
  readonly malformed: true;
  readonly timestampMs: number | null;
}

/**
 * Parses one provider's JSONL transcripts. Formats whose records depend on
 * earlier lines carry that context in State, which must survive cloning so a
 * grown file can resume after its last complete line.
 */
export interface TranscriptUsageFormat<State> {
  // ASCII substrings present on every line the parser needs, including context-only lines.
  readonly lineMarkers: readonly [string, ...string[]];
  createState(): State;
  cloneState(state: State): State;
  parseLine(line: string, state: State): UsageRecord | MalformedUsage | null;
}

export function isMalformedUsage(value: UsageRecord | MalformedUsage): value is MalformedUsage {
  return 'malformed' in value;
}

export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Copies normally repeat identical usage; when a streamed copy recorded counts
// before the response finished, the larger count is the final one. The earliest
// copy dates the request.
export function mergeUsageCopies(left: UsageRecord, right: UsageRecord): UsageRecord {
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

/** Merges records sharing a dedupe key, keeping the order in which keys first appear. */
export function collapseUsageCopies(records: readonly UsageRecord[]): UsageRecord[] {
  const collapsed: UsageRecord[] = [];
  const byKey = new Map<string, number>();
  for (const record of records) {
    if (record.dedupeKey === null) {
      collapsed.push(record);
      continue;
    }
    const index = byKey.get(record.dedupeKey);
    if (index === undefined) {
      byKey.set(record.dedupeKey, collapsed.length);
      collapsed.push(record);
    } else {
      collapsed[index] = mergeUsageCopies(collapsed[index]!, record);
    }
  }
  return collapsed;
}
