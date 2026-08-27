import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { openSearchReadDatabase, statusCounts } from '../schema.js';
import {
  TranscriptSearchService,
  type TranscriptSearchSyncFrame,
} from '../transcript-search-service.js';
import { syntheticRows } from './fixtures.js';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), 'search-v9-service-'));
  workspaces.push(value);
  return value;
}

function logger(records: Array<{ message: string; fields: unknown }> = []): AgentLogger {
  const capture = (message: string, fields?: unknown) => records.push({ message, fields });
  return { debug: capture, info: capture, warn: capture, error: capture };
}

function frames(options: {
  count: number;
  marker?: string;
  frameRows?: number;
  onPull?: (position: number) => void;
}): (afterOrdinal: number) => AsyncGenerator<TranscriptSearchSyncFrame, void, void> {
  return async function* (afterOrdinal) {
    const frameRows = options.frameRows ?? 100;
    for (let start = afterOrdinal + 1; start <= options.count; start += frameRows) {
      options.onPull?.(start);
      const count = Math.min(frameRows, options.count - start + 1);
      yield {
        rows: syntheticRows({
          seed: start,
          count,
          startOrdinal: start,
          marker: options.marker,
        }),
        advanceTo: start + count - 1,
      };
    }
  };
}

async function build(
  service: TranscriptSearchService,
  chatId: string,
  viewId: string,
  count: number,
  marker?: string,
): Promise<void> {
  await service.syncChat({
    mode: 'replace',
    chatId,
    transcriptViewId: viewId,
    expectedAfterOrdinal: 0,
    targetThrough: count,
    source: frames({ count, marker }),
  });
}

function searchRequest(chatId: string, viewId: string, throughOrdinal: number, marker: string) {
  return {
    query: {
      version: 1 as const,
      clauses: [{
        kind: 'all-words' as const,
        tokens: [{ text: marker, normalized: marker, match: 'exact' as const }],
      }],
    },
    allowedChats: [{ chatId, transcriptViewId: viewId, throughOrdinal }],
    limit: 20,
    signal: new AbortController().signal,
  };
}

function interceptingWorkerFactory(
  intercept: (
    readerOrdinal: number,
    event: MessageEvent<unknown>,
    deliver: (event: MessageEvent<unknown>) => void,
  ) => void,
): (role: 'indexer' | 'reader', moduleUrl: string) => Worker {
  return instrumentingWorkerFactory({
    onEvent: (role, ordinal, event, deliver) => {
      if (role === 'reader') intercept(ordinal, event, deliver);
      else deliver(event);
    },
  });
}

function instrumentingWorkerFactory(options: {
  onEvent?: (
    role: 'indexer' | 'reader',
    ordinal: number,
    event: MessageEvent<unknown>,
    deliver: (event: MessageEvent<unknown>) => void,
  ) => void;
  onPost?: (role: 'indexer' | 'reader', ordinal: number, message: unknown) => void;
  onCreate?: (role: 'indexer' | 'reader', ordinal: number, worker: Worker) => void;
}): (role: 'indexer' | 'reader', moduleUrl: string) => Worker {
  let readerOrdinal = 0;
  let indexerOrdinal = 0;
  return (role, moduleUrl) => {
    const worker = new Worker(moduleUrl);
    const ordinal = role === 'reader' ? readerOrdinal++ : indexerOrdinal++;
    options.onCreate?.(role, ordinal, worker);
    return new Proxy(worker, {
      set(target, property, value) {
        if (property === 'onmessage' && typeof value === 'function') {
          target.onmessage = (event) => {
            if (options.onEvent) options.onEvent(role, ordinal, event, value);
            else value(event);
          };
          return true;
        }
        return Reflect.set(target, property, value);
      },
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === 'postMessage' && typeof value === 'function') {
          return (message: unknown) => {
            options.onPost?.(role, ordinal, message);
            return value.call(target, message);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition not reached');
    await Bun.sleep(5);
  }
}

describe('transcript search service v9', () => {
  test('[TLV5-SEARCH.07-SVC-01] streams bounded frames and serves the indexed result', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    const pulls: number[] = [];
    await service.syncChat({
      mode: 'replace',
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      expectedAfterOrdinal: 0,
      targetThrough: 700,
      source: frames({
        count: 700,
        marker: 'servicemarkera',
        frameRows: 137,
        onPull: (position) => pulls.push(position),
      }),
    });
    expect(pulls).toEqual([1, 138, 275, 412, 549, 686]);
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({
        chatId: 'chat-0001',
        transcriptViewId: 'view-0001',
        status: 'indexed',
        indexedThrough: 700,
        targetThrough: 700,
      }),
    ]);
    const result = await service.search(searchRequest(
      'chat-0001', 'view-0001', 700, 'servicemarkera',
    ));
    expect(result.results).toHaveLength(1);
    expect(result.index).toMatchObject({ indexedChatCount: 1, pendingChatCount: 0 });
    await service.close();
  });

  test('[TLV5-SEARCH.07-SVC-02] finalizes only after the target frontier is acknowledged', async () => {
    const requests: string[] = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(),
      workerFactory: instrumentingWorkerFactory({
        onPost: (role, _ordinal, message) => {
          if (role === 'indexer') requests.push((message as { type: string }).type);
        },
      }),
    });
    await service.enable(new AbortController().signal);
    requests.length = 0;
    await build(service, 'chat-finalize', 'view-finalize', 600);
    const syncRequests = requests.filter((type) => type.startsWith('sync-'));
    expect(syncRequests[0]).toBe('sync-begin');
    expect(syncRequests.at(-1)).toBe('sync-finish');
    expect(syncRequests.filter((type) => type === 'sync-rows')).toHaveLength(6);
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({ status: 'indexed', indexedThrough: 600, targetThrough: 600 }),
    ]);
    await service.close();
  });

  test('[TLV5-SEARCH.07-SVC-03] a short source fails closed at its durable prefix', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    await expect(service.syncChat({
      mode: 'replace',
      chatId: 'chat-0002',
      transcriptViewId: 'view-0002',
      expectedAfterOrdinal: 0,
      targetThrough: 10,
      source: async function* () {
        yield { rows: syntheticRows({ seed: 2, count: 5 }), advanceTo: 5 };
      },
    })).rejects.toThrow('SEARCH_INDEX_GAP');
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({
        chatId: 'chat-0002',
        status: 'pending',
        indexedThrough: 5,
        targetThrough: 10,
      }),
    ]);
    await waitFor(() => service.status().queuedJobs === 0);
    expect(service.status()).toMatchObject({
      phase: 'degraded',
      chats: { indexed: 0, pending: 1, failed: 0 },
      lastErrorCode: null,
    });
    await service.close();
  });

  test('[TLV5-SEARCH.07-SVC-04] stale replacement rows are cleaned before new frames', async () => {
    const requests: string[] = [];
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onPost: (role, _ordinal, message) => {
          if (role === 'indexer') requests.push((message as { type: string }).type);
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-cleanup', 'view-old', 10_000);
    requests.length = 0;
    await build(service, 'chat-cleanup', 'view-new', 2);
    const cleanupIndexes = requests.flatMap((type, index) => type === 'sync-cleanup' ? [index] : []);
    const firstRows = requests.indexOf('sync-rows');
    expect(cleanupIndexes.length).toBeGreaterThanOrEqual(3);
    expect(cleanupIndexes.every((index) => index < firstRows)).toBe(true);
    expect(records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'WORKER_TIMEOUT'
    ))).toBe(false);
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({
        chatId: 'chat-cleanup', transcriptViewId: 'view-new', status: 'indexed',
      }),
    ]);
    await service.close();
  }, 60_000);

  test('[TLV5-SEARCH.08-SVC-03] append gaps fail without recording a chat failure', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-append-gap', 'view-append-gap', 5);
    await waitFor(() => service.status().chats.indexed === 1);
    await expect(service.syncChat({
      mode: 'append',
      chatId: 'chat-append-gap',
      transcriptViewId: 'view-append-gap',
      expectedAfterOrdinal: 6,
      targetThrough: 7,
      source: frames({ count: 7 }),
    })).rejects.toThrow('SEARCH_INDEX_GAP');
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({ status: 'indexed', indexedThrough: 5, lastErrorCode: null }),
    ]);
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-04] one failed source does not stop later jobs', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    await expect(service.syncChat({
      mode: 'replace',
      chatId: 'chat-failed',
      transcriptViewId: 'view-failed',
      expectedAfterOrdinal: 0,
      targetThrough: 1,
      source: async function* () {
        throw new Error('SEARCH_ROW_TOO_LARGE');
      },
    })).rejects.toThrow('SEARCH_ROW_TOO_LARGE');
    await build(service, 'chat-good', 'view-good', 3, 'servicemarkergood');
    expect(await service.chatStates()).toEqual([
      expect.objectContaining({ chatId: 'chat-failed', status: 'failed' }),
      expect.objectContaining({ chatId: 'chat-good', status: 'indexed' }),
    ]);
    await waitFor(() => service.status().chats.failed === 1);
    expect(service.status().lastErrorCode).toBeNull();
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-06] duplicate per-chat jobs fail loudly', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = service.syncChat({
      mode: 'replace',
      chatId: 'chat-conflict',
      transcriptViewId: 'view-conflict',
      expectedAfterOrdinal: 0,
      targetThrough: 1,
      source: async function* () {
        await gate;
        yield { rows: syntheticRows({ seed: 3, count: 1 }), advanceTo: 1 };
      },
    });
    await expect(service.syncChat({
      mode: 'replace',
      chatId: 'chat-conflict',
      transcriptViewId: 'view-conflict',
      expectedAfterOrdinal: 0,
      targetThrough: 1,
      source: frames({ count: 1 }),
    })).rejects.toThrow('SEARCH_JOB_CONFLICT');
    release();
    await first;
    await service.close();
  });

  test('[TLV5-SEARCH.02-SVC-01] deletion overtakes queued builds', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = service.syncChat({
      mode: 'replace', chatId: 'chat-a', transcriptViewId: 'view-a',
      expectedAfterOrdinal: 0, targetThrough: 1,
      source: async function* () {
        await gate;
        yield { rows: syntheticRows({ seed: 1, count: 1 }), advanceTo: 1 };
      },
    }).then(() => { order.push('first'); });
    const second = service.syncChat({
      mode: 'replace', chatId: 'chat-b', transcriptViewId: 'view-b',
      expectedAfterOrdinal: 0, targetThrough: 1,
      source: async function* () {
        order.push('second-started');
        yield { rows: syntheticRows({ seed: 2, count: 1 }), advanceTo: 1 };
      },
    }).then(() => { order.push('second'); });
    const deletion = service.deleteChat('chat-c').then(() => { order.push('delete'); });
    release();
    await Promise.all([first, second, deletion]);
    expect(order).toEqual(['first', 'delete', 'second-started', 'second']);
    await service.close();
  });

  test('[TLV5-SEARCH.06-SVC-01] restart plans a covered chat without rewriting it', async () => {
    const root = workspace();
    const first = new TranscriptSearchService({ workspaceDirectory: root, logger: logger() });
    await first.enable(new AbortController().signal);
    await build(first, 'chat-restart', 'view-restart', 20, 'restartmarker');
    const before = await first.chatStates();
    await first.close();

    const second = new TranscriptSearchService({ workspaceDirectory: root, logger: logger() });
    await second.enable(new AbortController().signal);
    let pulled = false;
    await second.syncChat({
      mode: 'replace',
      chatId: 'chat-restart',
      transcriptViewId: 'view-restart',
      expectedAfterOrdinal: 0,
      targetThrough: 20,
      source: async function* () { pulled = true; },
    });
    expect(pulled).toBe(false);
    expect(await second.chatStates()).toEqual(before);
    await second.close();
  });

  test('[TLV5-SEARCH.06-SVC-03] recreated indexes replace every stale reader handle', async () => {
    const root = workspace();
    const records: Array<{ message: string; fields: unknown }> = [];
    const searchReaders: number[] = [];
    let indexer: Worker | null = null;
    let rebuilt = false;
    const service = new TranscriptSearchService({
      workspaceDirectory: root,
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onCreate: (role, ordinal, worker) => {
          if (role === 'indexer' && ordinal === 0) indexer = worker;
        },
        onPost: (role, ordinal, message) => {
          if (role === 'reader' && (message as { type?: unknown }).type === 'search-start') {
            searchReaders.push(ordinal);
          }
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-recreated', 'view-recreated', 20, 'oldreadermarker');
    service.setResyncHandler(async () => {
      await build(service, 'chat-recreated', 'view-recreated', 20, 'newreadermarker');
      rebuilt = true;
    });

    if (!indexer) throw new Error('indexer worker not captured');
    const closed = new Promise<void>((resolve) => {
      indexer!.addEventListener('close', () => resolve(), { once: true });
    });
    indexer.terminate();
    await closed;
    const dbPath = join(root, 'transcript-search', 'index.sqlite');
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(file, { force: true });

    await waitFor(() => rebuilt && records.filter((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTARTED'
    )).length === 2, 10_000);
    searchReaders.length = 0;
    const results = await Promise.all([
      service.search(searchRequest(
        'chat-recreated', 'view-recreated', 20, 'newreadermarker',
      )),
      service.search(searchRequest(
        'chat-recreated', 'view-recreated', 20, 'newreadermarker',
      )),
    ]);
    expect(results.every((result) => result.results.length === 1)).toBe(true);
    expect(searchReaders.length).toBeGreaterThanOrEqual(2);
    expect(searchReaders.every((ordinal) => ordinal >= 2)).toBe(true);
    expect((await service.search(searchRequest(
      'chat-recreated', 'view-recreated', 20, 'oldreadermarker',
    ))).results).toHaveLength(0);
    await service.close();
  }, 20_000);

  test('[TLV5-SEARCH.09-SVC-03] resync scope prevents false ready status', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    const observed: string[] = [];
    const unsubscribe = service.onStatusChanged((status) => observed.push(status.phase));
    const scope = service.beginResync(1);
    await build(service, 'chat-status', 'view-status', 1);
    await Bun.sleep(300);
    expect(service.status().phase).toBe('rebuilding');
    expect(observed).not.toContain('ready');
    expect(() => scope.complete()).toThrow('SEARCH_RESYNC_INVARIANT');
    scope.chatSettled();
    scope.complete();
    await Bun.sleep(300);
    expect(service.status()).toMatchObject({
      phase: 'ready',
      chats: { indexed: 1, pending: 0, failed: 0 },
      backlogRows: 0,
      resync: null,
    });

    expect(() => service.beginResync(-1)).toThrow('SEARCH_RESYNC_INVARIANT');
    expect(() => service.beginResync(1.5)).toThrow('SEARCH_RESYNC_INVARIANT');
    const arithmetic = service.beginResync(2);
    arithmetic.chatSettled();
    expect(() => arithmetic.complete()).toThrow('SEARCH_RESYNC_INVARIANT');
    arithmetic.chatSettled();
    expect(() => arithmetic.chatSettled()).toThrow('SEARCH_RESYNC_INVARIANT');

    const superseding = service.beginResync(0);
    expect(() => arithmetic.complete()).not.toThrow();
    expect(() => arithmetic.fail('STALE_SCOPE_FAILURE')).not.toThrow();
    superseding.complete();
    await waitFor(() => service.status().phase === 'ready');

    service.recordResyncFailure('CATALOG_READ_FAILED');
    await waitFor(() => service.status().lastErrorCode === 'CATALOG_READ_FAILED');
    expect(service.status().phase).toBe('degraded');
    const recovery = service.beginResync(0);
    recovery.complete();
    await waitFor(() => (
      service.status().phase === 'ready' && service.status().lastErrorCode === null
    ));
    unsubscribe();
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-01] caller abandonment retires only its reader', async () => {
    const records: Array<{ message: string; fields: unknown }> = [];
    const searchReaders: number[] = [];
    let suppressFirstResult = true;
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onEvent: (role, reader, event, deliver) => {
          const type = (event.data as { type?: unknown }).type;
          if (role === 'reader' && reader === 0 && type === 'search-result'
              && suppressFirstResult) {
            suppressFirstResult = false;
            return;
          }
          deliver(event);
        },
        onPost: (role, reader, message) => {
          if (role === 'reader' && (message as { type?: unknown }).type === 'search-start') {
            searchReaders.push(reader);
          }
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-abandon', 'view-abandon', 100, 'abandonmarker');
    const abort = new AbortController();
    const abandoned = service.search({
      ...searchRequest('chat-abandon', 'view-abandon', 100, 'abandonmarker'),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 5);
    await expect(abandoned).rejects.toThrow('SEARCH_TIMEOUT');
    await expect(service.search(searchRequest(
      'chat-abandon', 'view-abandon', 100, 'abandonmarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-abandon' })] });
    expect(searchReaders.slice(0, 2)).toEqual([0, 1]);
    await waitFor(() => records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTARTED'
    )), 5_000);
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-02] two readers plus four waiters bound admission', async () => {
    const held: Array<{
      event: MessageEvent<unknown>;
      deliver: (event: MessageEvent<unknown>) => void;
    }> = [];
    let hold = true;
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(),
      workerFactory: interceptingWorkerFactory((_reader, event, deliver) => {
        if (hold && (event.data as { type?: unknown }).type === 'search-result') {
          held.push({ event, deliver });
          return;
        }
        deliver(event);
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-queue', 'view-queue', 20, 'queuemarker');
    const pending = Array.from({ length: 6 }, () => service.search(searchRequest(
      'chat-queue', 'view-queue', 20, 'queuemarker',
    )));
    await Bun.sleep(25);
    await expect(service.search(searchRequest(
      'chat-queue', 'view-queue', 20, 'queuemarker',
    ))).rejects.toThrow('SEARCH_INDEX_BUSY');
    expect(held).toHaveLength(2);
    hold = false;
    for (const item of held.splice(0)) item.deliver(item.event);
    await expect(Promise.all(pending)).resolves.toHaveLength(6);
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-05] one reader continues while its peer is replaced', async () => {
    let corruptNextResult = true;
    const searchReaders: number[] = [];
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onEvent: (role, ordinal, event, deliver) => {
          if (role === 'reader'
              && ordinal === 0
              && corruptNextResult
              && (event.data as { type?: unknown }).type === 'search-result') {
            corruptNextResult = false;
            deliver(new MessageEvent('message', { data: { invalid: true } }));
            return;
          }
          deliver(event);
        },
        onPost: (role, ordinal, message) => {
          if (role === 'reader' && (message as { type?: unknown }).type === 'search-start') {
            searchReaders.push(ordinal);
          }
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-reader-crash', 'view-reader-crash', 20, 'readercrashmarker');
    await expect(service.search(searchRequest(
      'chat-reader-crash', 'view-reader-crash', 20, 'readercrashmarker',
    ))).rejects.toThrow();
    await expect(service.search(searchRequest(
      'chat-reader-crash', 'view-reader-crash', 20, 'readercrashmarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-reader-crash' })] });
    await waitFor(() => records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTARTED'
    )), 5_000);
    await expect(service.search(searchRequest(
      'chat-reader-crash', 'view-reader-crash', 20, 'readercrashmarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-reader-crash' })] });
    expect(searchReaders).toEqual([0, 1, 2]);
    await service.close();
  });

  test('[TLV5-SEARCH.08-SVC-08] failed reader readmission leaves its peer available', async () => {
    let corruptNextResult = true;
    const searchReaders: number[] = [];
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onEvent: (role, ordinal, event, deliver) => {
          const data = event.data as {
            type?: unknown;
            requestId?: number;
            lifecycleEpoch?: string;
          };
          if (role === 'reader' && ordinal === 0 && corruptNextResult
              && data.type === 'search-result') {
            corruptNextResult = false;
            deliver(new MessageEvent('message', { data: { invalid: true } }));
            return;
          }
          if (role === 'reader' && ordinal >= 2 && data.type === 'opened') {
            deliver(new MessageEvent('message', { data: {
              type: 'error',
              requestId: data.requestId,
              lifecycleEpoch: data.lifecycleEpoch,
              code: 'READER_UNAVAILABLE',
              retryable: true,
            } }));
            return;
          }
          deliver(event);
        },
        onPost: (role, ordinal, message) => {
          if (role === 'reader' && (message as { type?: unknown }).type === 'search-start') {
            searchReaders.push(ordinal);
          }
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-readmission', 'view-readmission', 20, 'readmissionmarker');
    await expect(service.search(searchRequest(
      'chat-readmission', 'view-readmission', 20, 'readmissionmarker',
    ))).rejects.toThrow();
    await expect(service.search(searchRequest(
      'chat-readmission', 'view-readmission', 20, 'readmissionmarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-readmission' })] });
    await waitFor(() => records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTART_FAILED'
    )), 5_000);
    await expect(service.search(searchRequest(
      'chat-readmission', 'view-readmission', 20, 'readmissionmarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-readmission' })] });
    expect(searchReaders).toEqual([0, 1, 1]);
    expect(records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTARTED'
    ))).toBe(false);
    await service.close();
  }, 15_000);

  test('[TLV5-SEARCH.08-SVC-07] grace exhaustion quarantines only its reader', async () => {
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      readerRequestTimeoutMs: 500,
      workerFactory: interceptingWorkerFactory((reader, event, deliver) => {
        if (reader === 0 && (event.data as { type?: unknown }).type === 'search-result') return;
        deliver(event);
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-grace', 'view-grace', 20, 'gracemarker');
    await expect(service.search(searchRequest(
      'chat-grace', 'view-grace', 20, 'gracemarker',
    ))).rejects.toThrow('SEARCH_TIMEOUT');
    expect(service.queryStats().timedOut).toBe(1);
    await expect(service.search(searchRequest(
      'chat-grace', 'view-grace', 20, 'gracemarker',
    ))).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-grace' })] });
    await waitFor(() => service.status().phase === 'degraded');
    await waitFor(() => records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_READER_RESTARTED'
    )));
    await service.close();
  }, 10_000);

  test('[TLV5-SEARCH.07-SVC-05] deletion sequences bounded maintenance after checkpoint', async () => {
    const requests: string[] = [];
    const durations: number[] = [];
    const started = new Map<number, { type: string; at: number }>();
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onPost: (role, _ordinal, message) => {
          if (role !== 'indexer') return;
          const request = message as { type: string; requestId: number };
          if (!['delete-chat', 'checkpoint', 'maintenance'].includes(request.type)) return;
          requests.push(request.type);
          started.set(request.requestId, { type: request.type, at: performance.now() });
        },
        onEvent: (role, _ordinal, event, deliver) => {
          const response = event.data as { type?: string; requestId?: number };
          const pending = response.requestId === undefined ? null : started.get(response.requestId);
          if (role === 'indexer' && pending
              && (response.type === 'ack' || response.type === 'checkpoint-complete')) {
            durations.push(performance.now() - pending.at);
            started.delete(response.requestId!);
          }
          deliver(event);
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-maintenance', 'view-maintenance', 1_200);
    requests.length = 0;
    durations.length = 0;
    started.clear();
    await service.deleteChat('chat-maintenance');
    expect(requests).toEqual([
      'delete-chat',
      'checkpoint',
      'maintenance',
      'maintenance',
      'maintenance',
      'maintenance',
    ]);
    expect(durations).toHaveLength(6);
    expect(durations.every((duration) => duration < 10_000)).toBe(true);
    expect(records.some((record) => /TIMEOUT|RESTARTED/.test(
      (record.fields as { code?: string } | undefined)?.code ?? '',
    ))).toBe(false);
    await service.close();
  }, 60_000);

  test('[TLV5-SEARCH.07-SVC-06] fragmented churn keeps ingest slices bounded', async () => {
    const syncStarted = new Map<number, number>();
    const syncDurations: number[] = [];
    const records: Array<{ message: string; fields: unknown }> = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onPost: (role, _ordinal, message) => {
          const request = message as { type?: string; requestId?: number };
          if (role === 'indexer' && request.type === 'sync-rows'
              && request.requestId !== undefined) {
            syncStarted.set(request.requestId, performance.now());
          }
        },
        onEvent: (role, _ordinal, event, deliver) => {
          const response = event.data as { type?: string; requestId?: number };
          if (role === 'indexer' && response.type === 'sync-progress'
              && response.requestId !== undefined) {
            const began = syncStarted.get(response.requestId);
            if (began !== undefined) syncDurations.push(performance.now() - began);
          }
          deliver(event);
        },
      }),
    });
    await service.enable(new AbortController().signal);
    for (let cycle = 0; cycle < 200; cycle += 1) {
      if (cycle > 0) await service.deleteChat('chat-fragmented');
      const viewId = `view-fragmented-${cycle}`;
      await build(service, 'chat-fragmented', viewId, 64, 'fragmentedmarker');
      if (cycle % 20 === 19) {
        await expect(service.search(searchRequest(
          'chat-fragmented', viewId, 64, 'fragmentedmarker',
        ))).resolves.toMatchObject({
          results: [expect.objectContaining({ chatId: 'chat-fragmented' })],
        });
      }
    }
    expect(syncDurations).toHaveLength(200);
    expect(Math.max(...syncDurations)).toBeLessThan(2_000);
    expect(records.some((record) => /TIMEOUT|RESTARTED/.test(
      (record.fields as { code?: string } | undefined)?.code ?? '',
    ))).toBe(false);
    await service.close();
  }, 120_000);

  test('[TLV5-SEARCH.09-SVC-01] status readback matches a held mid-build frontier', async () => {
    const root = workspace();
    const service = new TranscriptSearchService({ workspaceDirectory: root, logger: logger() });
    await service.enable(new AbortController().signal);
    const scope = service.beginResync(1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const syncing = service.syncChat({
      mode: 'replace',
      chatId: 'chat-status-exact',
      transcriptViewId: 'view-status-exact',
      expectedAfterOrdinal: 0,
      targetThrough: 20,
      source: async function* () {
        yield { rows: syntheticRows({ seed: 1, count: 10 }), advanceTo: 10 };
        await gate;
        yield { rows: syntheticRows({ seed: 11, count: 10, startOrdinal: 11 }), advanceTo: 20 };
      },
    });
    await waitFor(() => service.status().activeChat?.position === 10);
    const reader = openSearchReadDatabase(join(root, 'transcript-search', 'index.sqlite'));
    const durable = statusCounts(reader);
    reader.close();
    expect(service.status()).toMatchObject({
      phase: 'rebuilding',
      chats: {
        indexed: durable.indexed,
        pending: durable.pending,
        failed: durable.failed,
      },
      backlogRows: durable.backlogRows,
      activeChat: { position: 10, total: 20 },
    });
    const unchangedAt = service.status().updatedAt;
    await Bun.sleep(300);
    expect(service.status().updatedAt).toBe(unchangedAt);
    release();
    await syncing;
    scope.chatSettled();
    scope.complete();
    await waitFor(() => service.status().phase === 'ready');
    expect(service.status()).toMatchObject({
      chats: { indexed: 1, pending: 0, failed: 0 },
      backlogRows: 0,
      activeChat: null,
    });
    await service.close();
  });

  test('[TLV5-SEARCH.09-SVC-04] failed count readbacks cannot publish false ready', async () => {
    let failedSnapshots = 0;
    const records: Array<{ message: string; fields: unknown }> = [];
    const observed: string[] = [];
    const service = new TranscriptSearchService({
      workspaceDirectory: workspace(),
      logger: logger(records),
      workerFactory: instrumentingWorkerFactory({
        onEvent: (role, _ordinal, event, deliver) => {
          const data = event.data as {
            type?: string;
            requestId?: number;
            lifecycleEpoch?: string;
          };
          if (role === 'indexer' && data.type === 'status-result' && failedSnapshots > 0) {
            failedSnapshots -= 1;
            deliver(new MessageEvent('message', { data: {
              type: 'error',
              requestId: data.requestId,
              lifecycleEpoch: data.lifecycleEpoch,
              code: 'INDEXER_INTERNAL',
              retryable: true,
            } }));
            if (failedSnapshots === 0) {
              queueMicrotask(() => deliver(new MessageEvent('message', { data: { invalid: true } })));
            }
            return;
          }
          deliver(event);
        },
      }),
    });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-readback', 'view-readback', 10);
    await waitFor(() => service.status().chats.indexed === 1);
    const unsubscribe = service.onStatusChanged((status) => observed.push(status.phase));
    const scope = service.beginResync(1);
    scope.chatSettled();
    failedSnapshots = 2;
    scope.complete();
    await waitFor(() => failedSnapshots === 0, 5_000);
    expect(observed).not.toContain('ready');
    await waitFor(() => records.some((record) => (
      (record.fields as { code?: string } | undefined)?.code === 'SEARCH_INDEXER_RESTARTED'
    )), 5_000);
    await waitFor(() => service.status().phase === 'ready');
    expect(service.status()).toMatchObject({
      chats: { indexed: 1, pending: 0, failed: 0 },
      backlogRows: 0,
      lastErrorCode: null,
    });
    unsubscribe();
    await service.close();
  }, 15_000);

  test('[TLV5-SEARCH.09-SVC-05] disable publishes the canonical zero state', async () => {
    const service = new TranscriptSearchService({ workspaceDirectory: workspace(), logger: logger() });
    await service.enable(new AbortController().signal);
    await build(service, 'chat-disable', 'view-disable', 20);
    const scope = service.beginResync(1);
    scope.chatSettled();
    scope.complete();
    await waitFor(() => service.status().phase === 'ready');
    await service.disableAndDelete(new AbortController().signal);
    await waitFor(() => service.status().phase === 'disabled');
    expect(service.status()).toMatchObject({
      phase: 'disabled',
      chats: { indexed: 0, pending: 0, failed: 0 },
      queuedJobs: 0,
      resync: null,
      backlogRows: 0,
      activeChat: null,
      lastErrorCode: null,
    });
    await service.close();
  });
});
