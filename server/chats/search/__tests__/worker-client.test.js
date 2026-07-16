import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TranscriptSearchWorkerClient,
  TranscriptSearchWorkerError,
} from '../worker-client.js';

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
    expect(response.index.pendingChatCount).toBe(0);
    expect(response.index.indexedChatCount).toBe(1);

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

  it('restores generation fences and prunes chats missing from the registry', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-generation-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const first = new TranscriptSearchWorkerClient(1);
    expect(await first.open(dbPath)).toBe(0);
    await first.request({
      type: 'append',
      chatId: 'orphan',
      generation: 200,
      rows: [{ role: 'user', timestamp: null, body: 'persisted orphan token' }],
    });
    await first.close();

    const second = new TranscriptSearchWorkerClient(2);
    expect(await second.open(dbPath)).toBe(200);
    await second.request({ type: 'delete-chat', chatId: 'orphan', generation: 199 });
    const retained = await second.request({
      type: 'search',
      query: 'orphan',
      allowedChatIds: ['orphan'],
    });
    expect(retained.type).toBe('search-result');
    expect(retained.results).toHaveLength(1);

    await second.request({ type: 'prune-chats', registeredChatIds: [] });
    const pruned = await second.request({
      type: 'search',
      query: 'orphan',
      allowedChatIds: ['orphan'],
    });
    expect(pruned.type).toBe('search-result');
    expect(pruned.results).toEqual([]);
    await second.close();
  });

  it('retains prior rows when an authoritative provider load fails', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-failure-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const transcriptPath = path.join(tempDir, 'direct.jsonl');
    await writeFile(transcriptPath, JSON.stringify({
      role: 'user',
      content: 'durable prior token',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    const client = new TranscriptSearchWorkerClient(1);
    await client.open(dbPath);
    const buildSource = {
      source: { kind: 'direct-jsonl', nativePath: transcriptPath },
      currentAgentId: 'direct-chat',
      currentModel: 'test',
    };
    await client.request({ type: 'rebuild-chat', chatId: 'c1', generation: 1, buildSource });
    await rm(transcriptPath);
    await expect(client.request({
      type: 'rebuild-chat',
      chatId: 'c1',
      generation: 2,
      buildSource,
    })).rejects.toBeInstanceOf(TranscriptSearchWorkerError);
    const response = await client.request({
      type: 'search',
      query: 'durable',
      allowedChatIds: ['c1'],
    });
    expect(response.type).toBe('search-result');
    expect(response.results.map((row) => row.chatId)).toEqual(['c1']);
    await client.close();

    const databaseBytes = await Bun.file(dbPath).text();
    expect(databaseBytes).not.toContain(transcriptPath);
  });

  it('acknowledges a rebuild superseded by a live append', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-race-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const transcriptPath = path.join(tempDir, 'direct.jsonl');
    await writeFile(transcriptPath, Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `historical-${index}`,
      timestamp: new Date(index).toISOString(),
    })).join('\n'));
    const client = new TranscriptSearchWorkerClient(1);
    await client.open(dbPath);
    const rebuild = client.request({
      type: 'rebuild-chat',
      chatId: 'c1',
      generation: 100,
      buildSource: {
        source: { kind: 'direct-jsonl', nativePath: transcriptPath },
        currentAgentId: 'direct-chat',
        currentModel: 'test',
      },
    });
    await Bun.sleep(5);
    await client.request({
      type: 'append',
      chatId: 'c1',
      generation: 101,
      rows: [{ role: 'user', timestamp: null, body: 'newer live token' }],
    });
    await expect(rebuild).resolves.toMatchObject({ type: 'ack' });
    const response = await client.request({
      type: 'search',
      query: 'newer',
      allowedChatIds: ['c1'],
    });
    expect(response.type).toBe('search-result');
    expect(response.results).toHaveLength(1);
    await client.close();
  });

  it('removes provider scratch before acknowledging chat deletion', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-delete-scratch-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const transcriptPath = path.join(tempDir, 'claude.jsonl');
    await writeFile(transcriptPath, Array.from({ length: 100_000 }, (_, index) => JSON.stringify({
      sessionId: 'scratch-delete',
      type: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: new Date(index + 1).toISOString(),
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `scratch deletion ${index} ${'payload '.repeat(12)}`,
      },
    })).join('\n'));
    const client = new TranscriptSearchWorkerClient(1);
    await client.open(dbPath);
    const rebuild = client.request({
      type: 'rebuild-chat',
      chatId: 'c1',
      generation: 100,
      buildSource: {
        source: { kind: 'claude-jsonl', nativePath: transcriptPath },
        currentAgentId: 'claude',
        currentModel: 'test',
      },
    });
    const scratchDirectory = path.join(tempDir, '.chat-search-v3-tmp');
    let observedScratch = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readdir(scratchDirectory)).length > 0) {
        observedScratch = true;
        break;
      }
      await Bun.sleep(2);
    }
    expect(observedScratch).toBe(true);

    await client.request({ type: 'delete-chat', chatId: 'c1', generation: 101 });

    expect(await readdir(scratchDirectory)).toEqual([]);
    await expect(rebuild).resolves.toMatchObject({ type: 'ack' });
    await client.close();
  });
});
