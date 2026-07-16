import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TranscriptSearchWorkerClient,
  TranscriptSearchWorkerError,
} from '../worker-client.js';
import { closeSearchDatabase, openSearchDatabase } from '../schema.js';
import { resolveTranscriptSearchWorkerPath } from '../worker-runtime.js';

let tempDir = null;

class FatalEventWorker extends EventTarget {
  onmessage = null;
  onerror = null;
  terminated = false;
  closeRequests = 0;

  postMessage(message) {
    if (message.type === 'open') {
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'opened',
          requestId: message.requestId,
          lifecycleEpoch: message.lifecycleEpoch,
          generationFloor: 0,
        },
      }));
      return;
    }
    if (message.type === 'close') {
      this.closeRequests += 1;
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: 'closed',
          requestId: message.requestId,
          lifecycleEpoch: message.lifecycleEpoch,
        },
      }));
    }
  }

  emitFatal(lifecycleEpoch) {
    this.onmessage?.({
      data: {
        type: 'fatal',
        lifecycleEpoch,
        code: 'SQLITE_ERROR',
        message: 'maintenance failed',
      },
    });
  }

  terminate() {
    this.terminated = true;
    this.dispatchEvent(new Event('close'));
  }
}

class DelayedSearchWorker extends FatalEventWorker {
  inFlight = 0;
  maxInFlight = 0;
  searchDelays = [];

  constructor(searchDelays) {
    super();
    this.searchDelays = [...searchDelays];
  }

  postMessage(message) {
    if (message.type !== 'search') {
      super.postMessage(message);
      return;
    }
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const delay = this.searchDelays.shift() ?? 0;
    setTimeout(() => {
      this.inFlight -= 1;
      this.onmessage?.({ data: {
        type: 'search-result',
        requestId: message.requestId,
        lifecycleEpoch: message.lifecycleEpoch,
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
      } });
    }, delay);
  }
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('TranscriptSearchWorkerClient', () => {
  it('terminates a partially constructed worker pair when the second worker fails', () => {
    const writer = new FatalEventWorker();

    expect(() => new TranscriptSearchWorkerClient(1, {
      workerFactory: (role) => {
        if (role === 'reader') throw new Error('reader construction failed');
        return writer;
      },
    })).toThrow('reader construction failed');
    expect(writer.terminated).toBe(true);
  });

  it('allows one timeout interval for a slow search to recover before crashing workers', async () => {
    const workers = {
      writer: new FatalEventWorker(),
      reader: new FatalEventWorker(),
    };
    let crash = null;
    const client = new TranscriptSearchWorkerClient(1, {
      workerFactory: (role) => workers[role],
      searchTimeoutMs: 5,
      onCrash: (error) => {
        crash = error;
      },
    });
    await client.open('/tmp/not-opened-by-fake-worker.sqlite');

    await expect(client.request({ type: 'search', query: 'stuck', allowedChatIds: [] }))
      .rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
    expect(crash).toBeNull();
    expect(workers.reader.terminated).toBe(false);
    await Bun.sleep(10);
    expect(crash).toMatchObject({ code: 'SEARCH_TIMEOUT' });
    await client.terminate();
  });

  it('serializes reader requests and resumes after a soft timeout completes', async () => {
    const reader = new DelayedSearchWorker([8, 1, 1]);
    const workers = { writer: new FatalEventWorker(), reader };
    let crash = null;
    const client = new TranscriptSearchWorkerClient(1, {
      workerFactory: (role) => workers[role],
      searchTimeoutMs: 5,
      onCrash: (error) => {
        crash = error;
      },
    });
    await client.open('/tmp/not-opened-by-fake-worker.sqlite');

    const slow = client.request({ type: 'search', query: 'slow', allowedChatIds: [] });
    const queued = [
      client.request({ type: 'search', query: 'next', allowedChatIds: [] }),
      client.request({ type: 'search', query: 'last', allowedChatIds: [] }),
    ];

    await expect(slow).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
    await expect(Promise.all(queued)).resolves.toHaveLength(2);
    expect(reader.maxInFlight).toBe(1);
    expect(crash).toBeNull();
    await client.terminate();
  });

  it('closes the writer cleanly before recovering from a stuck reader', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-reader-failure-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const reader = new FatalEventWorker();
    let resolveCrash;
    const crashed = new Promise((resolve) => {
      resolveCrash = resolve;
    });
    const client = new TranscriptSearchWorkerClient(1, {
      workerFactory: (role) => role === 'reader'
        ? reader
        : new Worker(resolveTranscriptSearchWorkerPath()),
      searchTimeoutMs: 5,
      onCrash: resolveCrash,
    });
    await client.open(dbPath);

    await expect(client.request({ type: 'search', query: 'stuck', allowedChatIds: [] }))
      .rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
    await crashed;
    await client.terminate();
    const reopened = await openSearchDatabase(dbPath);

    expect(reopened.recreated).toBe(false);
    closeSearchDatabase(reopened.db);
  });

  it('reports an unsolicited fatal storage event as a worker crash', async () => {
    const workers = {
      writer: new FatalEventWorker(),
      reader: new FatalEventWorker(),
    };
    let crash = null;
    const client = new TranscriptSearchWorkerClient(1, {
      workerFactory: (role) => workers[role],
      onCrash: (error) => {
        crash = error;
      },
    });
    await client.open('/tmp/not-opened-by-fake-worker.sqlite');
    const pending = client.request({ type: 'mark-dirty', chatId: 'c1', generation: 1 });

    workers.writer.emitFatal(1);

    await expect(pending).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
    expect(crash).toMatchObject({ code: 'SQLITE_ERROR', message: 'maintenance failed' });
    await client.terminate();
  });

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

  it('does not delay deletion behind an unrelated queued rebuild', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-delete-queue-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const longTranscriptPath = path.join(tempDir, 'long.jsonl');
    const queuedTranscriptPath = path.join(tempDir, 'queued.jsonl');
    await writeFile(longTranscriptPath, Array.from({ length: 50_000 }, (_, index) => JSON.stringify({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `long rebuild ${index} ${'payload '.repeat(8)}`,
      timestamp: new Date(index).toISOString(),
    })).join('\n'));
    await writeFile(queuedTranscriptPath, JSON.stringify({
      role: 'user',
      content: 'queued deletion token',
      timestamp: '2026-01-01T00:00:00.000Z',
    }));
    const client = new TranscriptSearchWorkerClient(1);
    await client.open(dbPath);
    const longRebuild = client.request({
      type: 'rebuild-chat',
      chatId: 'long',
      generation: 1,
      buildSource: {
        source: { kind: 'direct-jsonl', nativePath: longTranscriptPath },
        currentAgentId: 'direct-chat',
        currentModel: 'test',
      },
    });
    await Bun.sleep(5);
    const queuedRebuild = client.request({
      type: 'rebuild-chat',
      chatId: 'queued',
      generation: 1,
      buildSource: {
        source: { kind: 'direct-jsonl', nativePath: queuedTranscriptPath },
        currentAgentId: 'direct-chat',
        currentModel: 'test',
      },
    });

    const deletedPromptly = await Promise.race([
      client.request({ type: 'delete-chat', chatId: 'queued', generation: 2 }).then(() => true),
      Bun.sleep(250).then(() => false),
    ]);

    expect(deletedPromptly).toBe(true);
    await client.request({
      type: 'append',
      chatId: 'long',
      generation: 2,
      rows: [{ role: 'user', timestamp: null, body: 'cancel long rebuild' }],
    });
    await Promise.all([longRebuild, queuedRebuild]);
    const search = await client.request({
      type: 'search',
      query: 'queued',
      allowedChatIds: ['queued'],
    });
    expect(search.type).toBe('search-result');
    expect(search.results).toEqual([]);
    await client.close();
  });

  it('removes provider scratch before acknowledging chat deletion', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-worker-delete-scratch-'));
    const dbPath = path.join(tempDir, 'chat-search-v3.sqlite');
    const transcriptPath = path.join(tempDir, 'claude.jsonl');
    const replacementPath = path.join(tempDir, 'replacement.jsonl');
    await writeFile(transcriptPath, Array.from({ length: 100_000 }, (_, index) => JSON.stringify({
      sessionId: 'scratch-delete',
      type: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: new Date(index + 1).toISOString(),
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `scratch deletion ${index} ${'payload '.repeat(12)}`,
      },
    })).join('\n'));
    await writeFile(replacementPath, JSON.stringify({
      role: 'assistant',
      content: 'newer rebuild survives delayed deletion',
      timestamp: '2026-01-02T00:00:00.000Z',
    }));
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

    const deletion = client.request({ type: 'delete-chat', chatId: 'c1', generation: 101 });
    const replacement = client.request({
      type: 'rebuild-chat',
      chatId: 'c1',
      generation: 102,
      buildSource: {
        source: { kind: 'direct-jsonl', nativePath: replacementPath },
        currentAgentId: 'direct-chat',
        currentModel: 'test',
      },
    });
    await deletion;
    await replacement;

    expect(await readdir(scratchDirectory)).toEqual([]);
    await expect(rebuild).resolves.toMatchObject({ type: 'ack' });
    const search = await client.request({
      type: 'search',
      query: 'survives',
      allowedChatIds: ['c1'],
    });
    expect(search.type).toBe('search-result');
    expect(search.results.map((row) => row.chatId)).toEqual(['c1']);
    await client.close();
  });
});
