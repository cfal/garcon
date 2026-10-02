import { describe, expect, test } from 'bun:test';
import { QueryLatencyStats } from '../query-latency-stats.js';

describe('QueryLatencyStats', () => {
  test('starts with zero samples and tracks failures without adding latency samples', () => {
    const stats = new QueryLatencyStats();
    expect(Object.values(stats.snapshot()).every(value => value === 0)).toBe(true);
    stats.recordTimedOut();
    stats.recordRejectedBusy();
    expect(stats.snapshot()).toEqual({
      served: 0, timedOut: 1, rejectedBusy: 1,
      p50Ms: 0, p95Ms: 0, maxMs: 0,
      admissionP50Ms: 0, admissionP95Ms: 0, admissionMaxMs: 0,
      totalP50Ms: 0, totalP95Ms: 0, totalMaxMs: 0,
    });
  });

  test('computes independent quantiles rather than adding admission and execution medians', () => {
    const stats = new QueryLatencyStats();
    for (const [admissionMs, executionMs] of [[25, 0], [25, 0], [0, 8], [0, 8], [10, 0], [0, 10]]) {
      stats.recordServed({ admissionMs, executionMs, totalMs: admissionMs + executionMs });
    }
    expect(stats.snapshot()).toEqual({
      served: 6, timedOut: 0, rejectedBusy: 0,
      p50Ms: 8, p95Ms: 10, maxMs: 10,
      admissionP50Ms: 10, admissionP95Ms: 25, admissionMaxMs: 25,
      totalP50Ms: 10, totalP95Ms: 25, totalMaxMs: 25,
    });
  });

  test('rounds durations and bounds each total by its rounded components', () => {
    const stats = new QueryLatencyStats();
    stats.recordServed({ admissionMs: 1.6, executionMs: 2.6, totalMs: 4.2 });
    expect(stats.snapshot()).toMatchObject({
      admissionP50Ms: 2, p50Ms: 3, totalP50Ms: 5,
    });
    stats.recordServed({ admissionMs: 1, executionMs: 2, totalMs: 8.6 });
    expect(stats.snapshot().totalMaxMs).toBe(9);
  });

  test('retains only the latest 512 samples without resetting the served counter', () => {
    const stats = new QueryLatencyStats();
    stats.recordServed({ admissionMs: 100_000, executionMs: 100_000, totalMs: 200_000 });
    for (let value = 1; value <= 512; value += 1) {
      stats.recordServed({ admissionMs: value, executionMs: value, totalMs: value * 2 });
    }
    expect(stats.snapshot()).toEqual({
      served: 513, timedOut: 0, rejectedBusy: 0,
      p50Ms: 257, p95Ms: 487, maxMs: 512,
      admissionP50Ms: 257, admissionP95Ms: 487, admissionMaxMs: 512,
      totalP50Ms: 514, totalP95Ms: 974, totalMaxMs: 1024,
    });
  });
});
