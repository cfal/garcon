import { expect, test } from 'bun:test';
import { parseUsageSummary, type UsageReadRequest, type UsageSummary } from '../../../../common/usage.js';
import { DomainError } from '../../../common/domain-error.js';
import { createUsageRoutes } from '../usage.js';
import type { UsageReadOptions, UsageService } from '../../usage/usage-service.js';

const REMOTE_EXECUTOR = '22222222-2222-4222-8222-222222222222';
const WINDOW = { sinceDay: '2026-09-28', untilDay: '2026-10-27', timeZone: 'Europe/Berlin' };

function route(readSummary: UsageService['readSummary']) {
  const routes = createUsageRoutes({ readSummary }, 1_000);
  return (query: string, signal?: AbortSignal) => {
    const url = new URL(`http://localhost/api/v1/usage?${query}`);
    return routes['/api/v1/usage']!.GET!(new Request(url, { signal }), url);
  };
}

test('reads the summary for the requested executor and window', async () => {
  const calls: Array<[string, UsageReadRequest, UsageReadOptions]> = [];
  const get = route(async (executorId, window, options) => {
    calls.push([executorId, window, options]);
    return { executorId, ...window, readAt: '2026-10-27T05:00:00.000Z', pricingAsOf: '2026-10-27', agents: [] } satisfies UsageSummary;
  });
  const response = await get(new URLSearchParams({ executorId: REMOTE_EXECUTOR, ...WINDOW }).toString());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(parseUsageSummary(await response.json())).toMatchObject({ executorId: REMOTE_EXECUTOR, ...WINDOW });
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe(REMOTE_EXECUTOR);
  expect(calls[0]![1]).toEqual(WINDOW);
  expect(calls[0]![2].timeoutMs).toBe(1_000);

  await get(new URLSearchParams(WINDOW).toString());
  expect(calls[1]![0]).toBe('local');
});

test('rejects malformed, duplicated, or oversized windows before reading', async () => {
  let reads = 0;
  const get = route(async () => { reads += 1; throw new Error('unreachable'); });
  const invalid = [
    new URLSearchParams({ sinceDay: WINDOW.sinceDay, untilDay: WINDOW.untilDay }),
    new URLSearchParams({ ...WINDOW, sinceDay: '2026-13-01' }),
    new URLSearchParams({ ...WINDOW, sinceDay: '2026-01-01' }),
    new URLSearchParams({ ...WINDOW, untilDay: '2026-09-01' }),
    new URLSearchParams({ ...WINDOW, timeZone: 'Mars/Olympus' }),
    new URLSearchParams({ ...WINDOW, executorId: 'not-an-executor' }),
    new URLSearchParams([...Object.entries(WINDOW), ['sinceDay', '2026-10-01']]),
  ];
  for (const query of invalid) {
    const response = await get(query.toString());
    expect(response.status).toBe(400);
  }
  expect(reads).toBe(0);
});

test('maps executor unavailability to its HTTP status', async () => {
  const get = route(async () => { throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true); });
  const response = await get(new URLSearchParams({ executorId: REMOTE_EXECUTOR, ...WINDOW }).toString());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ errorCode: 'EXECUTOR_UNAVAILABLE', retryable: true });
});
