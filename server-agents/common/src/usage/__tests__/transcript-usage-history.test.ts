import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAgentUsageReport } from '@garcon/common/usage';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { USAGE_PRICING_AS_OF } from '../model-prices.js';
import { createTranscriptUsageHistory } from '../transcript-usage-history.js';
import { parseTimestampMs, tokenCount, type TranscriptUsageFormat } from '../usage-record.js';

// One request per line: {"at", "model", "session", "id", "input", "output"}.
const format: TranscriptUsageFormat<null> = {
  lineMarkers: ['"model"'],
  createState: () => null,
  cloneState: () => null,
  parseLine(line) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const timestampMs = parseTimestampMs(entry.at);
    if (timestampMs === null || typeof entry.model !== 'string') return null;
    return {
      timestampMs,
      model: entry.model,
      sessionId: String(entry.session ?? ''),
      totals: {
        uncachedInputTokens: tokenCount(entry.input),
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: tokenCount(entry.output),
        reasoningTokens: 0,
      },
      cacheWrite1hTokens: 0,
      speed: 'standard',
      dedupeKey: typeof entry.id === 'string' ? entry.id : null,
    };
  },
  malformedRecords: () => 0,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'usage-history-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const window = { sinceDay: '2026-10-01', untilDay: '2026-10-31', timeZone: 'UTC' };

test('reports priced day-by-model buckets that satisfy the wire contract', async () => {
  await mkdir(path.join(root, 'project'), { recursive: true });
  const rows = [
    { at: '2026-10-05T12:00:00Z', model: 'claude-opus-5-5', session: 's1', id: 'r1', input: 1_000_000, output: 0 },
    { at: '2026-10-05T12:00:00Z', model: 'claude-opus-5-5', session: 's1', id: 'r1', input: 1_000_000, output: 0 },
    { at: '2026-10-06T12:00:00Z', model: 'unknown-model', session: 's2', input: 10, output: 5 },
  ];
  await writeFile(path.join(root, 'project', 'a.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const history = createTranscriptUsageHistory({ operation: 'usage-test', format, roots: () => [root] });
  const report = await history.read(window);
  expect(parseAgentUsageReport(report)).toEqual(report);
  expect(report).toMatchObject({ status: 'ok', scannedFiles: 1, distinctSessions: 2, pricingAsOf: USAGE_PRICING_AS_OF });
  expect(report.buckets.map((bucket) => [bucket.day, bucket.model, bucket.costUsd, bucket.unpricedRecords])).toEqual([
    ['2026-10-05', 'claude-opus-5-5', 4, 0],
    ['2026-10-06', 'unknown-model', 0, 1],
  ]);
});

test('reports missing transcript roots as missing, not as an error', async () => {
  const history = createTranscriptUsageHistory({ operation: 'usage-test', format, roots: () => [path.join(root, 'absent')] });
  expect(await history.read(window)).toMatchObject({ status: 'missing', buckets: [], scannedFiles: 0 });
});

test('rejects invalid windows', async () => {
  const history = createTranscriptUsageHistory({ operation: 'usage-test', format, roots: () => [root] });
  for (const invalid of [
    { ...window, untilDay: '2026-09-01' },
    { ...window, sinceDay: '2026-01-01' },
    { ...window, timeZone: 'Not/AZone' },
    { ...window, sinceDay: '2026-02-30' },
  ]) {
    expect(history.read(invalid)).rejects.toBeInstanceOf(AgentIntegrationError);
  }
});
