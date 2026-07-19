import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forkJsonlTranscript } from '../fork-jsonl.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('forkJsonlTranscript', () => {
  it('preserves physical line positions and passes per-entry retained counts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'session', sessionId: 'source' }),
      '',
      JSON.stringify({ type: 'message', content: 'later physical entry' }),
      JSON.stringify({ type: 'message', content: 'selected entry' }),
      '',
    ].join('\n'));

    const seen: Array<{ type: unknown; retainedMessageCount: number | undefined }> = [];
    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 4,
      retainedMessageCounts: new Map([[4, 1]]),
      rewriteEntry(entry, context) {
        const record = entry as Record<string, unknown>;
        seen.push({ type: record.type, retainedMessageCount: context.retainedMessageCount });
        if (record.type === 'session') {
          return { ...record, sessionId: context.targetAgentSessionId };
        }
        return context.retainedMessageCount === 0 ? {} : entry;
      },
    });

    const lines = (await readFile(result.nativePath, 'utf8')).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[2]!)).toEqual({});
    expect(JSON.parse(lines[3]!)).toEqual({ type: 'message', content: 'selected entry' });
    expect(seen).toEqual([
      { type: 'session', retainedMessageCount: 0 },
      { type: 'message', retainedMessageCount: 0 },
      { type: 'message', retainedMessageCount: 1 },
    ]);
  });
});
