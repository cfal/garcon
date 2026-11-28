import { createTranscriptUsageHistory } from '../../../../server-agents/common/src/usage/transcript-usage-history.ts';
import { AgentIntegrationError } from '../../../../server-agents/interface/src/errors.ts';
import {
  parseTimestampMs,
  tokenCount,
  type TranscriptUsageFormat,
} from '../../../../server-agents/common/src/usage/usage-record.ts';

const rootsErrorMode = process.argv[3] === 'roots-error';
let rootsReads = 0;
let parsedLines = 0;
const format: TranscriptUsageFormat<null> = {
  lineMarkers: ['"model"'],
  createState: () => null,
  cloneState: () => null,
  parseLine(line) {
    parsedLines++;
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
  roots: () => {
    rootsReads++;
    if (rootsErrorMode && rootsReads === 2) {
      throw new AgentIntegrationError('UNAVAILABLE', 'synthetic config home unavailable', true);
    }
    return [process.argv[2]!];
  },
  now: () => Date.parse('2026-10-27T00:00:00Z'),
});
const window = { sinceDay: '2026-10-01', untilDay: '2026-10-31' };
if (rootsErrorMode) {
  if (rootsReads !== 0) throw new Error('roots must be resolved lazily');
  const read = () => history.read({ ...window, timeZone: 'UTC' });
  const first = await read();
  const failed = read().then(() => null, (error: unknown) => {
    if (!(error instanceof AgentIntegrationError)) throw error;
    return { code: error.code, message: error.message, retryable: error.retryable };
  });
  const [error, recovered] = await Promise.all([failed, read()]);
  process.stdout.write(JSON.stringify({ first, error, recovered, rootsReads, parsedLines }));
} else {
  const reports = [];
  for (const timeZone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
    reports.push(await history.read({ ...window, timeZone }));
  }
  process.stdout.write(JSON.stringify(reports));
}
