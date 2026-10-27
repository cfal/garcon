import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TranscriptUsageScanner } from '../transcript-usage-scanner.js';
import type { TranscriptUsageFormat, UsageRecord } from '../usage-record.js';

interface CountingState {
  model: string;
  malformed: number;
}

// Context lines set the model; usage lines carry a token count for that model.
function countingFormat(parsedLines: string[]): TranscriptUsageFormat<CountingState> {
  return {
    lineMarkers: ['"usage"', '"model"'],
    createState: () => ({ model: '', malformed: 0 }),
    cloneState: (state) => ({ ...state }),
    parseLine(line, state): UsageRecord | null {
      parsedLines.push(line);
      const entry = JSON.parse(line) as { model?: string; usage?: number; at?: string };
      if (entry.model) {
        state.model = entry.model;
        return null;
      }
      if (typeof entry.usage !== 'number' || entry.usage < 0) {
        state.malformed += 1;
        return null;
      }
      return {
        timestampMs: Date.parse(entry.at ?? '2026-10-10T00:00:00Z'),
        model: state.model,
        sessionId: 'session',
        totals: { uncachedInputTokens: entry.usage, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        cacheWrite1hTokens: 0,
        speed: 'standard',
        dedupeKey: null,
      };
    },
    malformedRecords: (state) => state.malformed,
  };
}

const line = (value: object) => `${JSON.stringify(value)}\n`;

describe('transcript usage scanner', () => {
  let root: string;
  let parsed: string[];
  let scanner: TranscriptUsageScanner<CountingState>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usage-scanner-'));
    parsed = [];
    scanner = new TranscriptUsageScanner({ operation: 'usage-test', format: countingFormat(parsed), roots: () => [root] });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const usage = (scan: Awaited<ReturnType<typeof scanner.scan>>) =>
    scan.files.flatMap((file) => file.records.map((record) => `${record.model}:${record.totals.uncachedInputTokens}`));

  test('reports a missing root without failing', async () => {
    const missing = new TranscriptUsageScanner({ operation: 'usage-test', format: countingFormat([]), roots: () => [path.join(root, 'absent')] });
    expect(await missing.scan(0)).toEqual({ rootFound: false, files: [], unreadablePaths: 0, malformedRecords: 0 });
  });

  test('reads nested JSONL transcripts and skips other files and unrelated lines', async () => {
    await mkdir(path.join(root, 'project', 'session', 'subagents'), { recursive: true });
    await writeFile(path.join(root, 'project', 'a.jsonl'), line({ model: 'm1' }) + line({ text: 'no marker' }) + line({ usage: 5 }));
    await writeFile(path.join(root, 'project', 'session', 'subagents', 'agent.jsonl'), line({ model: 'm2' }) + line({ usage: 7 }));
    await writeFile(path.join(root, 'project', 'notes.txt'), line({ usage: 99 }));
    const scan = await scanner.scan(0);
    expect(scan.rootFound).toBe(true);
    expect(usage(scan).sort()).toEqual(['m1:5', 'm2:7']);
    expect(parsed.some((entry) => entry.includes('no marker'))).toBe(false);
  });

  test('resumes a grown file after its last complete line with the saved context', async () => {
    const file = path.join(root, 'grow.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1 }));
    expect(usage(await scanner.scan(0))).toEqual(['m1:1']);
    expect(parsed).toHaveLength(2);

    await appendFile(file, line({ usage: 2 }));
    parsed.length = 0;
    expect(usage(await scanner.scan(0))).toEqual(['m1:1', 'm1:2']);
    expect(parsed).toEqual([JSON.stringify({ usage: 2 })]);

    parsed.length = 0;
    expect(usage(await scanner.scan(0))).toEqual(['m1:1', 'm1:2']);
    expect(parsed).toHaveLength(0);
  });

  test('rereads an unterminated last line once it completes', async () => {
    const file = path.join(root, 'tail.jsonl');
    await writeFile(file, line({ model: 'm1' }) + JSON.stringify({ usage: 3 }));
    expect(usage(await scanner.scan(0))).toEqual(['m1:3']);
    await appendFile(file, `\n${line({ usage: 4 })}`);
    expect(usage(await scanner.scan(0))).toEqual(['m1:3', 'm1:4']);
  });

  test('reparses a rewritten file instead of resuming into unrelated bytes', async () => {
    const file = path.join(root, 'rewrite.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1 }));
    await scanner.scan(0);
    await writeFile(file, line({ model: 'm9' }) + line({ usage: 10 }) + line({ usage: 20 }));
    expect(usage(await scanner.scan(0))).toEqual(['m9:10', 'm9:20']);
    await truncate(file, 0);
    await writeFile(file, line({ model: 'm3' }) + line({ usage: 30 }));
    expect(usage(await scanner.scan(0))).toEqual(['m3:30']);
  });

  test('skips files last modified before the scan window and forgets deleted ones', async () => {
    const old = path.join(root, 'old.jsonl');
    const recent = path.join(root, 'recent.jsonl');
    await writeFile(old, line({ model: 'm1' }) + line({ usage: 1 }));
    await writeFile(recent, line({ model: 'm2' }) + line({ usage: 2 }));
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await utimes(old, longAgo, longAgo);
    expect(usage(await scanner.scan(Date.parse('2026-06-01T00:00:00Z')))).toEqual(['m2:2']);
    await rm(recent);
    expect(usage(await scanner.scan(0))).toEqual(['m1:1']);
  });

  test('counts malformed records reported by the format', async () => {
    await writeFile(path.join(root, 'bad.jsonl'), line({ model: 'm1' }) + line({ usage: -1 }) + line({ usage: 6 }));
    const scan = await scanner.scan(0);
    expect(usage(scan)).toEqual(['m1:6']);
    expect(scan.malformedRecords).toBe(1);
  });

  test('stops at a cancelled scan', async () => {
    await writeFile(path.join(root, 'a.jsonl'), line({ model: 'm1' }) + line({ usage: 1 }));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    expect(scanner.scan(0, controller.signal)).rejects.toThrow('cancelled');
    expect(usage(await scanner.scan(0))).toEqual(['m1:1']);
  });
});
