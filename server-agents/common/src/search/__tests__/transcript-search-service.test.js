import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TranscriptSearchService } from '../transcript-search-service.ts';

const services = new Set();
const roots = new Set();

afterEach(async () => {
  await Promise.allSettled([...services].map((service) => service.close()));
  services.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

class FilteringWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;

  constructor(moduleUrl, shouldDrop) {
    this.worker = new Worker(moduleUrl, { ref: true });
    this.worker.onmessage = (event) => {
      if (!shouldDrop(event.data)) this.onmessage?.(event);
    };
    this.worker.onerror = (event) => this.onerror?.(event);
    this.worker.onmessageerror = (event) => this.onmessageerror?.(event);
  }

  postMessage(message) {
    this.worker.postMessage(message);
  }

  addEventListener(type, listener, options) {
    this.worker.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    this.worker.removeEventListener(type, listener, options);
  }

  terminate() {
    this.worker.terminate();
  }
}

function row(ordinal, body) {
  return { ordinal, role: 'assistant', timestamp: null, body };
}

test('[TLV5-SEARCH.02-TIMEOUT-RESYNC-SERVICE-UNIT-01] a lost real-Worker completion retires, resyncs, and admits a later chat', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transcript-search-real-timeout-'));
  roots.add(root);
  let armed = false;
  let suppressed = false;
  let signalSuppressed;
  const completionSuppressed = new Promise((resolve) => { signalSuppressed = resolve; });
  const service = new TranscriptSearchService({
    workspaceDirectory: root,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    indexWriteTimeoutMs: 25,
    workerFactory: (role, moduleUrl) => new FilteringWorker(moduleUrl, (event) => {
      if (role !== 'indexer' || !armed || suppressed
          || event?.type !== 'physical-step-complete') return false;
      suppressed = true;
      signalSuppressed();
      return true;
    }),
  });
  services.add(service);
  await service.enable(new AbortController().signal);

  const firstInput = {
    chatId: 'timeout-chat',
    transcriptViewId: 'timeout-view',
    throughOrdinal: 1,
    rows: [row(1, 'synthetic timeout needle')],
  };
  let resyncCount = 0;
  let signalResynced;
  const resynced = new Promise((resolve) => { signalResynced = resolve; });
  service.setResyncHandler(async () => {
    resyncCount += 1;
    await service.replaceChat(firstInput);
    signalResynced();
  });

  armed = true;
  const timedOut = service.replaceChat(firstInput);
  void timedOut.catch(() => undefined);
  await completionSuppressed;
  await expect(timedOut).rejects.toThrow('WORKER_PHYSICAL_STEP_TIMEOUT');
  await resynced;
  expect(resyncCount).toBe(1);

  await service.replaceChat({
    chatId: 'later-chat',
    transcriptViewId: 'later-view',
    throughOrdinal: 1,
    rows: [row(1, 'synthetic later needle')],
  });
  const result = await service.search({
    query: {
      version: 1,
      clauses: [{
        kind: 'all-words',
        tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
      }],
    },
    allowedChats: [
      { chatId: 'timeout-chat', transcriptViewId: 'timeout-view', throughOrdinal: 1 },
      { chatId: 'later-chat', transcriptViewId: 'later-view', throughOrdinal: 1 },
    ],
    limit: 20,
    signal: new AbortController().signal,
  });

  expect(result.index).toEqual({
    indexedChatCount: 2,
    pendingChatCount: 0,
    failedChatCount: 0,
    unsupportedChatCount: 0,
  });
  expect(result.results.map((entry) => entry.chatId).sort())
    .toEqual(['later-chat', 'timeout-chat']);
});
