import {
  isUsageWindowRetained,
  MAX_USAGE_BUCKETS,
  parseUsageReadRequest,
  type AgentUsageReport,
} from '@garcon/common/usage';
import { AgentIntegrationError, type AgentUsageHistory } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '../shared/event-loop.js';
import { USAGE_PRICING_AS_OF } from './model-prices.js';
import { UsageAggregator } from './usage-aggregator.js';
import { TranscriptUsageScanner, type TranscriptUsageScannerOptions } from './transcript-usage-scanner.js';

// A transcript last written before the window opened in the earliest time zone holds no
// in-window records; the slack covers UTC+14 and writes just before local midnight.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

/** Implements the usage facet over a provider's JSONL transcript directories. */
export function createTranscriptUsageHistory<State>(
  options: TranscriptUsageScannerOptions<State>,
): AgentUsageHistory {
  const scanner = new TranscriptUsageScanner(options);
  return {
    async read(request): Promise<AgentUsageReport> {
      const window = parseUsageReadRequest(request);
      if (!window || !isUsageWindowRetained(window, (options.now ?? Date.now)())) {
        throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'Invalid usage window', false);
      }
      // One read is one operation: scanning and aggregation share its step budget.
      const steps = new EventLoopSteps(options.operation);
      const sinceMs = Date.parse(`${window.sinceDay}T00:00:00Z`) - MTIME_SLACK_MS;
      const scan = await scanner.scan(sinceMs, steps, request.signal);
      const aggregator = new UsageAggregator(window);
      for (const file of scan.files) {
        await steps.forEach(file.records, (record) => aggregator.add(record));
        for (const entry of file.malformed) aggregator.addMalformed(entry.timestampMs);
      }
      const { buckets, distinctSessions, malformedRecords } = await aggregator.finish(steps);
      if (buckets.length > MAX_USAGE_BUCKETS) {
        throw new AgentIntegrationError('PROVIDER_FAILURE', 'Usage spans too many models to report', false);
      }
      return {
        status: !scan.rootFound ? 'missing' : scan.unreadablePaths > 0 || malformedRecords > 0 ? 'partial' : 'ok',
        buckets,
        scannedFiles: scan.files.length,
        unreadableFiles: scan.unreadablePaths,
        malformedRecords,
        distinctSessions,
        pricingAsOf: USAGE_PRICING_AS_OF,
      };
    },
  };
}
