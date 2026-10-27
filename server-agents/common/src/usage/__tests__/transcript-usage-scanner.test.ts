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
  const scan = (sinceMs = 0, signal?: AbortSignal) => scanner.scan(sinceMs, new EventLoopSteps('usage-test'), signal);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usage-scanner-'));
    parsed = [];
    scanner = new TranscriptUsageScanner({ operation: 'usage-test', format: countingFormat(parsed), roots: () => [root], now: () => NOW });
  });

  afterEach(async () => {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const usage = (result: Awaited<ReturnType<typeof scan>>) =>
    result.files.flatMap((file) => file.records.map((record) => `${record.model}:${record.totals.uncachedInputTokens}`));

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

  test('stops at a cancelled scan and still serves the next one', async () => {
    await writeFile(path.join(root, 'a.jsonl'), line({ model: 'm1' }) + line({ usage: 1 }));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(scan(0, controller.signal)).rejects.toThrow('cancelled');
    expect(usage(await scan())).toEqual(['m1:1']);
  });
});
