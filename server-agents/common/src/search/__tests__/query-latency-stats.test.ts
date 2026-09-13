import { expect, test } from 'bun:test';
import { QueryLatencyStats } from '../query-latency-stats.js';

test('latency percentiles preserve paired totals without adding independent medians', () => {
  const stats = new QueryLatencyStats();
  for (const sample of [
    { admissionMs: 0, executionMs: 25, totalMs: 25 },
    { admissionMs: 0, executionMs: 25, totalMs: 25 },
    { admissionMs: 25, executionMs: 0, totalMs: 25 },
    { admissionMs: 25, executionMs: 0, totalMs: 25 },
    { admissionMs: 25, executionMs: 5, totalMs: 30 },
    { admissionMs: 25, executionMs: 5, totalMs: 30 },
  ]) stats.recordServed(sample);
  const result = stats.snapshot();
  expect(result).toMatchObject({
    served: 6, admissionP50Ms: 25, p50Ms: 5, totalP50Ms: 25, totalMaxMs: 30,
  });
  expect(result.totalP50Ms).toBeLessThan(result.admissionP50Ms + result.p50Ms);
});

test('rounding keeps each total at least its paired admission and execution time', () => {
  const stats = new QueryLatencyStats();
  stats.recordServed({ admissionMs: 0.6, executionMs: 0.6, totalMs: 1.2 });
  expect(stats.snapshot()).toMatchObject({
    served: 1, admissionP50Ms: 1, p50Ms: 1, totalP50Ms: 2,
  });
});
