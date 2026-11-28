import { usageDayFormatter, type AgentUsageReport, type UsageReadRequest } from '../../../../common/usage.ts';
import { sampleBucket, sampleReport } from '../inputs/common/usage-guards.ts';

if (Bun.version !== '1.4.3') throw new Error(`expected Bun 1.4.3, got ${Bun.version}`);

const request = { sinceDay: '2026-10-26', untilDay: '2026-10-27', timeZone: 'Asia/Kathmandu' } satisfies UsageReadRequest;
const report = {
  ...sampleReport, status: 'partial', buckets: [{
    ...sampleBucket, costUsd: 1e21, cacheSavingsUsd: -0,
    categoryCostUsd: { input: 1.0, cacheRead: 9007199254740993, cacheWrite: 1e-7, output: 0.001 },
  }],
} satisfies AgentUsageReport;
const times = [
  0, -0.9, -86400000.9, Date.parse('2026-03-08T07:00Z'),
  Date.parse('2026-11-01T06:00Z'), Date.parse('2026-10-27T11:59:59Z'), Date.parse('2026-10-27T12:00Z'),
  Date.parse('2024-02-29T00:00Z'), Date.parse('0000-01-01T00:00Z'), 8640000000000000,
  -8640000000000000, 8640000000000001, NaN, Infinity,
];
const days = ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Kathmandu', '+05:45', '-12:00', 'us/eastern', 'Nowhere/Zone']
  .flatMap(zone => times.map(at => {
    let result;
    try {
      result = usageDayFormatter(zone)(at);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      result = { $: 'error', name: error.name, message: error.message, properties: {} };
    }
    return { zone, at: Number.isFinite(at) ? at : { $: 'number', value: String(at) }, result };
  }));
const invalidReport = { ...report, buckets: [{ ...report.buckets[0], costUsd: NaN }] };
console.log(JSON.stringify({
  request: JSON.stringify(request), report: JSON.stringify(report), invalidReport: JSON.stringify(invalidReport), days,
}));
