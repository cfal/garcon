import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TranscriptSearchWorkerClient } from '../worker-client.js';

let tempDir = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('TranscriptSearchWorkerClient', () => {
  it('round-trips real worker SQLite operations and detached transcript loading', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const transcriptPath = path.join(tempDir, 'direct.jsonl');
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', content: 'historical worker token', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ role: 'assistant', content: 'worker response', timestamp: '2026-01-01T00:00:01.000Z' }),
    ].join('\n'));
    const client = new TranscriptSearchWorkerClient(1);
    await client.open(dbPath);

    await client.request({
      type: 'rebuild-chat',
      chatId: 'c1',
      generation: 100,
      buildSource: {
        source: { kind: 'direct-jsonl', nativePath: transcriptPath },
        currentAgentId: 'direct-chat',
        currentModel: 'test',
      },
    });
    await client.request({
      type: 'append',
      chatId: 'c1',
      generation: 101,
      rows: [{ role: 'assistant', timestamp: null, body: 'live worker token' }],
    });
    const response = await client.request({
      type: 'search',
      query: 'historical live',
      allowedChatIds: ['c1'],
    });
    expect(response.type).toBe('search-result');
    expect(response.results.map((row) => row.chatId)).toEqual(['c1']);
    expect(response.index.pendingChatCount).toBe(1);

    await client.request({
      type: 'append',
      chatId: 'c2',
      generation: 200,
      rows: [{ role: 'assistant', timestamp: null, body: 'newer generation survives' }],
    });
    await client.request({ type: 'delete-chat', chatId: 'c2', generation: 199 });
    const staleDelete = await client.request({
      type: 'search',
      query: 'survives',
      allowedChatIds: ['c2'],
    });
    expect(staleDelete.type).toBe('search-result');
    expect(staleDelete.results.map((row) => row.chatId)).toEqual(['c2']);

    await client.request({ type: 'delete-chat', chatId: 'c1', generation: 102 });
    const deleted = await client.request({
      type: 'search',
      query: 'worker',
      allowedChatIds: ['c1'],
    });
    expect(deleted.type).toBe('search-result');
    expect(deleted.results).toEqual([]);
    await client.close();
  });
});
