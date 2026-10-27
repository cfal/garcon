import type { UsageTokenTotals } from '@garcon/common/usage';

export type UsageSpeed = 'standard' | 'fast';

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
  parseLine(line: string, state: State): UsageRecord | null;
  // Cumulative count of usage records the parser rejected as malformed or inconsistent.
  malformedRecords(state: State): number;
}

export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
