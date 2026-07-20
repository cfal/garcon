import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import {
  createCompleteJsonlSnapshot,
  yieldBoundedMessageBatches,
} from '../index-source-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transcript index source helpers', () => {
  it('copies only complete valid JSONL records into an isolated snapshot', async () => {
    const root = await workspace();
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, '\n{"complete":true}\n{"partial":');

    const snapshot = await createCompleteJsonlSnapshot({
      nativePath: sourcePath,
      scratchDirectory: path.join(root, 'scratch'),
      maxRecordBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(await readFile(snapshot.path, 'utf8')).toBe('\n{"complete":true}\n');
    await snapshot.remove();
  });

  it('rejects a malformed complete record without retaining a snapshot', async () => {
    const root = await workspace();
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, '{not-json}\n');

    const failure = createCompleteJsonlSnapshot({
      nativePath: sourcePath,
      scratchDirectory: path.join(root, 'scratch'),
      maxRecordBytes: 1024,
      signal: new AbortController().signal,
    });

    await expect(failure).rejects.toMatchObject({
      name: 'AgentTranscriptIndexError',
      failure: { code: 'SOURCE_RECORD_INVALID', retryable: false },
    });
  });

  it('enforces batch limits and cancellation between yielded batches', async () => {
    const abort = new AbortController();
    const messages = [
      new UserMessage('2026-01-01T00:00:00.000Z', 'first'),
      new UserMessage('2026-01-01T00:00:01.000Z', 'second'),
    ];
    const iterator = yieldBoundedMessageBatches(messages, {
      maxMessagesPerBatch: 1,
      maxBatchBytes: 1024,
      maxRecordBytes: 1024,
    }, abort.signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: [messages[0]], done: false });
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-index-source-helper-'));
  roots.push(root);
  return root;
}
