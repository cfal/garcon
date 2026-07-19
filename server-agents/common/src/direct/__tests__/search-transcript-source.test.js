import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDirectSearchTranscript } from '../search-transcript-source.js';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('Direct search transcript source', () => {
  it('flushes before count limit when source records exceed the byte budget', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-direct-search-source-'));
    const transcriptPath = path.join(tempDir, 'transcript.jsonl');
    const content = 'x'.repeat(5 * 1024 * 1024);
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', content }),
      JSON.stringify({ role: 'assistant', content }),
    ].join('\n'));

    const batchSizes = [];
    for await (const batch of loadDirectSearchTranscript(
      { kind: 'direct-jsonl', nativePath: transcriptPath },
      {
        signal: new AbortController().signal,
        batchSize: 250,
        scratchDirectory: tempDir,
      },
    )) {
      batchSizes.push(batch.length);
    }

    expect(batchSizes).toEqual([1, 1]);
  });
});
