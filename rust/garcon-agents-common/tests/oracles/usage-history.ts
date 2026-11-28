import { createTranscriptUsageHistory } from '../../../../server-agents/common/src/usage/transcript-usage-history.ts';
import {
  parseTimestampMs,
  tokenCount,
  type TranscriptUsageFormat,
} from '../../../../server-agents/common/src/usage/usage-record.ts';

const format: TranscriptUsageFormat<null> = {
  lineMarkers: ['"model"'],
  createState: () => null,
  cloneState: () => null,
  parseLine(line) {
    const row = JSON.parse(line);
    const timestampMs = parseTimestampMs(row.at);
    if (row.broken) return { malformed: true, timestampMs };
    if (timestampMs === null || typeof row.model !== 'string') return null;
    return {
      timestampMs, model: row.model, sessionId: row.session ?? '',
      totals: {
        uncachedInputTokens: tokenCount(row.input), cachedInputTokens: tokenCount(row.cached),
        cacheWriteTokens: 0, outputTokens: tokenCount(row.output), reasoningTokens: 0,
      },
      cacheWrite1hTokens: 0,
      speed: 'standard',
      dedupeKey: row.id ?? null,
    };
  },
};
const history = createTranscriptUsageHistory({
  operation: 'usage-history-test',
  format,
  roots: () => [process.argv[2]!],
  now: () => Date.parse('2026-10-27T00:00:00Z'),
});
const window = { sinceDay: '2026-10-01', untilDay: '2026-10-31' };
const reports = [];
for (const timeZone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
  reports.push(await history.read({ ...window, timeZone }));
}
process.stdout.write(JSON.stringify(reports));
