import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, chmod, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventLoopSteps } from '../../shared/event-loop.js';
import { TranscriptUsageScanner } from '../transcript-usage-scanner.js';
import type { MalformedUsage, TranscriptUsageFormat, UsageRecord } from '../usage-record.js';

interface CountingState {
  model: string;
}

const NOW = Date.parse('2026-10-27T00:00:00Z');
const DAY_MS = 86_400_000;

// Context lines set the model; usage lines carry a token count for that model.
function countingFormat(parsedLines: string[]): TranscriptUsageFormat<CountingState> {
  return {
    lineMarkers: ['"usage"', '"model"'],
    createState: () => ({ model: '' }),
    cloneState: (state) => ({ ...state }),
    parseLine(line, state): UsageRecord | MalformedUsage | null {
      parsedLines.push(line);
      const entry = JSON.parse(line) as { model?: string; usage?: number; at?: string; id?: string };
      const timestampMs = Date.parse(entry.at ?? '2026-10-10T00:00:00Z');
      if (entry.model) {
        state.model = entry.model;
        return null;
      }
      if (typeof entry.usage !== 'number' || entry.usage < 0) return { malformed: true, timestampMs };
      return {
        timestampMs,
        model: state.model,
        sessionId: 'session',
        totals: { uncachedInputTokens: entry.usage, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        cacheWrite1hTokens: 0,
        speed: 'standard',
        dedupeKey: entry.id ?? null,
      };
    },
  };
}

const line = (value: object) => `${JSON.stringify(value)}\n`;

describe('transcript usage scanner', () => {
  let root: string;
  let parsed: string[];
  let scanner: TranscriptUsageScanner<CountingState>;
  let now: number;
  const scan = (sinceMs = 0, signal?: AbortSignal) => scanner.scan(sinceMs, new EventLoopSteps('usage-test'), signal);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usage-scanner-'));
    parsed = [];
    now = NOW;
    scanner = new TranscriptUsageScanner({ operation: 'usage-test', format: countingFormat(parsed), roots: () => [root], now: () => now });
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const usage = (result: Awaited<ReturnType<typeof scan>>) =>
    result.files.flatMap((file) => [...file.records, ...file.tailRecords].map((record) => `${record.model}:${record.totals.uncachedInputTokens}`));

  // Writes a transcript spanning several read chunks.
  const writeLarge = (file: string, lines: number) =>
    writeFile(file, line({ model: 'm1' }) + Array.from({ length: lines }, () => line({ usage: 1, pad: 'x'.repeat(96) })).join(''));

  // Runs work while a timer measures the longest the event loop went without a turn.
  async function longestTimerGap(work: () => Promise<unknown>): Promise<number> {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
    }, 1);
    try {
      await work();
      return Math.max(longest, performance.now() - last);
    } finally {
      clearInterval(timer);
    }
  }

  test('reports a missing root without failing', async () => {
    const missing = new TranscriptUsageScanner({ operation: 'usage-test', format: countingFormat([]), roots: () => [path.join(root, 'absent')] });
    expect(await missing.scan(0, new EventLoopSteps('usage-test'))).toEqual({ rootFound: false, files: [], unreadablePaths: 0 });
  });

  test.skipIf(process.getuid?.() === 0)('reports an unreadable root as found but unreadable', async () => {
    await chmod(root, 0o000);
    expect(await scan()).toEqual({ rootFound: true, files: [], unreadablePaths: 1 });
  });

  test('reads nested JSONL transcripts and skips other files and unrelated lines', async () => {
    await mkdir(path.join(root, 'project', 'session', 'subagents'), { recursive: true });
    await writeFile(path.join(root, 'project', 'a.jsonl'), line({ model: 'm1' }) + line({ text: 'no marker' }) + line({ usage: 5 }));
    await writeFile(path.join(root, 'project', 'session', 'subagents', 'agent.jsonl'), line({ model: 'm2' }) + line({ usage: 7 }));
    await writeFile(path.join(root, 'project', 'notes.txt'), line({ usage: 99 }));
    const result = await scan();
    expect(result.rootFound).toBe(true);
    expect(usage(result).sort()).toEqual(['m1:5', 'm2:7']);
    expect(parsed.some((entry) => entry.includes('no marker'))).toBe(false);
  });

  test('reads compressed rollouts and prefers a plain copy while both exist', async () => {
    await writeFile(path.join(root, 'cold.jsonl.zst'), Bun.zstdCompressSync(Buffer.from(line({ model: 'm1' }) + line({ usage: 3 }))));
    await writeFile(path.join(root, 'moving.jsonl'), line({ model: 'm2' }) + line({ usage: 4 }));
    await writeFile(path.join(root, 'moving.jsonl.zst'), Bun.zstdCompressSync(Buffer.from(line({ model: 'm2' }) + line({ usage: 4 }))));
    expect(usage(await scan()).sort()).toEqual(['m1:3', 'm2:4']);
  });

  test('resumes a grown file after its last complete line with the saved context', async () => {
    const file = path.join(root, 'grow.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1 }));
    expect(usage(await scan())).toEqual(['m1:1']);
    expect(parsed).toHaveLength(2);

    await appendFile(file, line({ usage: 2 }));
    parsed.length = 0;
    expect(usage(await scan())).toEqual(['m1:1', 'm1:2']);
    expect(parsed).toEqual([JSON.stringify({ usage: 2 })]);

    parsed.length = 0;
    expect(usage(await scan())).toEqual(['m1:1', 'm1:2']);
    expect(parsed).toHaveLength(0);
  });

  test('keeps one record per request within a file, across a resume', async () => {
    const file = path.join(root, 'blocks.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 5, id: 'a' }) + line({ usage: 5, id: 'a' }));
    expect(usage(await scan())).toEqual(['m1:5']);
    await appendFile(file, line({ usage: 6, id: 'a' }) + line({ usage: 1, id: 'b' }));
    expect(usage(await scan())).toEqual(['m1:6', 'm1:1']);
  });

  test('counts a request on an unterminated last line once', async () => {
    const file = path.join(root, 'partial.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 5, id: 'a' }) + JSON.stringify({ usage: 5, id: 'a' }));
    expect(usage(await scan())).toEqual(['m1:5']);
    await appendFile(file, `\n${JSON.stringify({ usage: 2, id: 'b' })}`);
    expect(usage(await scan())).toEqual(['m1:5', 'm1:2']);
  });

  test('rereads an unterminated last line once it completes', async () => {
    const file = path.join(root, 'tail.jsonl');
    await writeFile(file, line({ model: 'm1' }) + JSON.stringify({ usage: 3 }));
    expect(usage(await scan())).toEqual(['m1:3']);
    await appendFile(file, `\n${line({ usage: 4 })}`);
    expect(usage(await scan())).toEqual(['m1:3', 'm1:4']);
  });

  test('reparses a rewritten file instead of resuming into unrelated bytes', async () => {
    const file = path.join(root, 'rewrite.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1 }));
    await scan();
    await writeFile(file, line({ model: 'm9' }) + line({ usage: 10 }) + line({ usage: 20 }));
    expect(usage(await scan())).toEqual(['m9:10', 'm9:20']);
    await truncate(file, 0);
    await writeFile(file, line({ model: 'm3' }) + line({ usage: 30 }));
    expect(usage(await scan())).toEqual(['m3:30']);
  });

  test('skips files last modified before the scan window and forgets deleted ones', async () => {
    const old = path.join(root, 'old.jsonl');
    const recent = path.join(root, 'recent.jsonl');
    await writeFile(old, line({ model: 'm1' }) + line({ usage: 1 }));
    await writeFile(recent, line({ model: 'm2' }) + line({ usage: 2 }));
    const earlier = new Date('2026-09-01T00:00:00Z');
    await utimes(old, earlier, earlier);
    expect(usage(await scan(Date.parse('2026-10-01T00:00:00Z')))).toEqual(['m2:2']);
    await rm(recent);
    expect(usage(await scan())).toEqual(['m1:1']);
  });

  test('drops usage older than every selectable window at parse time', async () => {
    await writeFile(path.join(root, 'long.jsonl'), line({ model: 'm1' }) + line({ usage: 1, at: '2026-06-01T00:00:00Z' }) + line({ usage: 2 }));
    expect(usage(await scan())).toEqual(['m1:2']);
  });

  test('keeps malformed usage with its time and skips only usage-bearing oversized lines', async () => {
    await writeFile(path.join(root, 'bad.jsonl'), line({ model: 'm1' }) + line({ usage: -1, at: '2026-10-20T00:00:00Z' }) + line({ usage: 6 }));
    const result = await scan();
    expect(usage(result)).toEqual(['m1:6']);
    expect(result.files[0]!.malformed).toEqual([{ malformed: true, timestampMs: Date.parse('2026-10-20T00:00:00Z') }]);
  });

  test('prunes usage that aged out of retention when a cached file grows', async () => {
    const file = path.join(root, 'aging.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1, at: '2026-08-01T00:00:00Z' }) + line({ usage: 2 }));
    expect(usage(await scan())).toEqual(['m1:1', 'm1:2']);
    now = NOW + 30 * DAY_MS;
    await appendFile(file, line({ usage: 3, at: '2026-11-20T00:00:00Z' }));
    parsed.length = 0;
    expect(usage(await scan())).toEqual(['m1:2', 'm1:3']);
    expect(parsed).toHaveLength(1);
  });

  // A scanner whose format cancels the scan after it has parsed `after` lines.
  function cancellingScanner(after: number) {
    const controller = new AbortController();
    const format = countingFormat(parsed);
    const cancelling = new TranscriptUsageScanner({
      operation: 'usage-test',
      format: {
        ...format,
        parseLine(text, state) {
          if (parsed.length === after) controller.abort(new Error('cancelled'));
          return format.parseLine(text, state);
        },
      },
      roots: () => [root],
      now: () => NOW,
    });
    return { controller, scan: (signal?: AbortSignal) => cancelling.scan(0, new EventLoopSteps('usage-test'), signal) };
  }

  test('stops reading a file when a scan is cancelled mid-stream', async () => {
    const lines = 40_000;
    await writeLarge(path.join(root, 'large.jsonl'), lines);
    const cancelling = cancellingScanner(100);
    await expect(cancelling.scan(cancelling.controller.signal)).rejects.toThrow('cancelled');
    expect(parsed.length).toBeLessThan(lines / 2);
    const next = await cancelling.scan();
    expect(next.files[0]!.records).toHaveLength(lines);
  });

  test('keeps the cached parse of a file whose resume was cancelled', async () => {
    const file = path.join(root, 'resume.jsonl');
    await writeFile(file, line({ model: 'm1' }) + line({ usage: 1 }));
    const cancelling = cancellingScanner(100);
    await cancelling.scan();
    await appendFile(file, Array.from({ length: 20_000 }, () => line({ usage: 1, pad: 'x'.repeat(96) })).join(''));
    await expect(cancelling.scan(cancelling.controller.signal)).rejects.toThrow('cancelled');
    expect(parsed.length).toBeLessThan(10_000);
    const result = await cancelling.scan();
    expect(result.files[0]!.records).toHaveLength(20_001);
  });

  test('parses a large transcript and resumes it without holding the event loop', async () => {
    const file = path.join(root, 'large.jsonl');
    const lines = 200_000;
    await writeLarge(file, lines);
    let cold: Awaited<ReturnType<typeof scan>> | null = null;
    expect(await longestTimerGap(async () => { cold = await scan(); })).toBeLessThan(200);
    expect(cold!.files[0]!.records).toHaveLength(lines);

    await appendFile(file, line({ usage: 2 }));
    parsed.length = 0;
    let warm: Awaited<ReturnType<typeof scan>> | null = null;
    expect(await longestTimerGap(async () => { warm = await scan(); })).toBeLessThan(200);
    expect(parsed).toHaveLength(1);
    expect(warm!.files[0]!.records).toHaveLength(lines + 1);
  });

  test('stops at a cancelled scan and still serves the next one', async () => {
    await writeFile(path.join(root, 'a.jsonl'), line({ model: 'm1' }) + line({ usage: 1 }));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(scan(0, controller.signal)).rejects.toThrow('cancelled');
    expect(usage(await scan())).toEqual(['m1:1']);
  });
});
