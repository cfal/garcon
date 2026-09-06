import type { TranscriptSearchQueryStatsV1 } from '@garcon/common/chat-search';

const QUERY_STATS_SAMPLE_LIMIT = 512;

interface QueryLatencySample {
  readonly admissionMs: number;
  readonly executionMs: number;
  readonly totalMs: number;
}

function quantile(
  samples: readonly QueryLatencySample[],
  field: keyof QueryLatencySample,
  value: number,
): number {
  const sorted = samples.map((sample) => sample[field]).sort((left, right) => left - right);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))]!;
}

export class QueryLatencyStats {
  readonly #samples: QueryLatencySample[] = [];
  #served = 0;
  #timedOut = 0;
  #rejectedBusy = 0;

  recordServed(sample: QueryLatencySample): void {
    const admissionMs = Math.round(sample.admissionMs);
    const executionMs = Math.round(sample.executionMs);
    this.#samples.push({
      admissionMs,
      executionMs,
      totalMs: Math.max(Math.round(sample.totalMs), admissionMs + executionMs),
    });
    if (this.#samples.length > QUERY_STATS_SAMPLE_LIMIT) this.#samples.shift();
    this.#served += 1;
  }

  recordTimedOut(): void {
    this.#timedOut += 1;
  }

  recordRejectedBusy(): void {
    this.#rejectedBusy += 1;
  }

  snapshot(): TranscriptSearchQueryStatsV1 {
    return {
      served: this.#served,
      timedOut: this.#timedOut,
      rejectedBusy: this.#rejectedBusy,
      p50Ms: quantile(this.#samples, 'executionMs', 0.5),
      p95Ms: quantile(this.#samples, 'executionMs', 0.95),
      maxMs: quantile(this.#samples, 'executionMs', 1),
      admissionP50Ms: quantile(this.#samples, 'admissionMs', 0.5),
      admissionP95Ms: quantile(this.#samples, 'admissionMs', 0.95),
      admissionMaxMs: quantile(this.#samples, 'admissionMs', 1),
      totalP50Ms: quantile(this.#samples, 'totalMs', 0.5),
      totalP95Ms: quantile(this.#samples, 'totalMs', 0.95),
      totalMaxMs: quantile(this.#samples, 'totalMs', 1),
    };
  }
}
