import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../../common/chat-types.js';
import { TranscriptSearchService } from '../../../../server-agents/common/src/search/transcript-search-service.ts';
import { TranscriptSearchController } from '../controller.js';

function indexKey(chatId, throughOrdinal) {
  return `${chatId}:${throughOrdinal}`;
}

class ControlledIndexerWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  #builds = new Map();
  #receivedIndexes = new Set();
  #heldIndexes = new Set();
  #heldIndexRequests = new Map();
  #holdPrune = false;
  #heldPruneRequest = null;

  holdIndex(chatId, throughOrdinal) {
    this.#heldIndexes.add(indexKey(chatId, throughOrdinal));
  }

  releaseIndex(chatId, throughOrdinal) {
    const key = indexKey(chatId, throughOrdinal);
    this.#heldIndexes.delete(key);
    const request = this.#heldIndexRequests.get(key);
    if (!request) return;
    this.#heldIndexRequests.delete(key);
    this.#emit({ type: 'ack', ...identity(request) });
  }

  holdPrune() {
    this.#holdPrune = true;
  }

  releasePrune() {
    this.#holdPrune = false;
    const request = this.#heldPruneRequest;
    this.#heldPruneRequest = null;
    if (request) this.#emit({ type: 'ack', ...identity(request) });
  }

  releaseAll() {
    for (const request of this.#heldIndexRequests.values()) {
      this.#emit({ type: 'ack', ...identity(request) });
    }
    this.#heldIndexes.clear();
    this.#heldIndexRequests.clear();
    this.releasePrune();
  }

  receivedIndex(chatId, throughOrdinal) {
    return this.#receivedIndexes.has(indexKey(chatId, throughOrdinal));
  }

  pruneRequestCount() {
    return this.requests.filter((request) => request.type === 'prune-chats').length;
  }

  postMessage(request) {
    this.requests.push(request);
    switch (request.type) {
      case 'open':
        this.#emit({ type: 'opened', ...identity(request) });
        return;
      case 'index-start':
        this.#builds.set(request.requestId, request);
        return;
      case 'index-chunk': {
        const build = this.#builds.get(request.requestId);
        if (!build || !request.done) return;
        this.#builds.delete(request.requestId);
        const key = indexKey(build.chatId, build.throughOrdinal);
        this.#receivedIndexes.add(key);
        if (this.#heldIndexes.has(key)) {
          this.#heldIndexRequests.set(key, request);
          return;
        }
        this.#emit({ type: 'ack', ...identity(request) });
        return;
      }
      case 'prune-chats':
        if (this.#holdPrune) {
          this.#heldPruneRequest = request;
          return;
        }
        this.#emit({ type: 'ack', ...identity(request) });
        return;
      case 'delete-chat':
        this.#emit({ type: 'ack', ...identity(request) });
        return;
      case 'close':
        this.#emit({ type: 'closed', ...identity(request) });
        return;
      default:
        throw new Error(`Unexpected indexer request: ${request.type}`);
    }
  }

  terminate() {}

  #emit(data) {
    this.onmessage?.({ data });
  }
}

class ControlledReaderWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;

  postMessage(request) {
    if (request.type === 'open') {
      this.onmessage?.({ data: { type: 'opened', ...identity(request) } });
      return;
    }
    if (request.type === 'close') {
      this.onmessage?.({ data: { type: 'closed', ...identity(request) } });
      return;
    }
    throw new Error(`Unexpected reader request: ${request.type}`);
  }

  terminate() {}
}

function identity(request) {
  return {
    requestId: request.requestId,
    lifecycleEpoch: request.lifecycleEpoch,
  };
}

function ledgerRow(viewId, ordinal, body) {
  const message = new UserMessage('2026-08-17T00:00:00.000Z', body);
  return {
    kind: 'user-input',
    viewId,
    ordinal,
    at: message.timestamp,
    detail: { clientMessageId: `message-${ordinal}`, message, attachments: [], steer: false },
    providerMeta: null,
  };
}

function searchRow(ordinal, body) {
  return { ordinal, role: 'user', timestamp: null, body };
}

async function requireEventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

function createHarness(root) {
  const indexer = new ControlledIndexerWorker();
  const reader = new ControlledReaderWorker();
  const service = new TranscriptSearchService({
    workspaceDirectory: root,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    workerFactory: (role) => role === 'indexer' ? indexer : reader,
  });
  const servicePromises = new Map();
  const appendRows = service.appendRows.bind(service);
  service.appendRows = (input) => {
    const result = appendRows(input);
    servicePromises.set(indexKey(input.chatId, input.throughOrdinal), result);
    return result;
  };
  const views = new Map();
  let listener = null;
  const controller = new TranscriptSearchController({
    listChatIds: () => [...views.keys()],
    ledger: {
      currentView: (chatId) => views.get(chatId) ?? null,
      currentRows: () => [],
      subscribe(candidate) {
        listener = candidate;
        return () => { listener = null; };
      },
    },
    service,
    logger: { warn() {} },
  });
  return {
    controller,
    emit: (event) => listener(event),
    indexer,
    service,
    servicePromises,
    views,
  };
}

describe('TranscriptSearchController with the real search service', () => {
  test('[TLV5-SEARCH.02-SERVICE-UNIT-01] isolates cross-chat writes while preserving chat order and exclusive pruning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-service-'));
    const testHarness = createHarness(root);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      testHarness.views.set('chat-a', { viewId: 'view-a', contentStartOrdinal: 1 });
      testHarness.views.set('chat-b', { viewId: 'view-b', contentStartOrdinal: 1 });
      await testHarness.controller.initialize(true);
      testHarness.indexer.holdIndex('chat-a', 1);

      testHarness.emit({
        type: 'rows',
        chatId: 'chat-a',
        viewId: 'view-a',
        rows: [ledgerRow('view-a', 1, 'first-a')],
      });
      testHarness.emit({
        type: 'rows',
        chatId: 'chat-a',
        viewId: 'view-a',
        rows: [ledgerRow('view-a', 2, 'second-a')],
      });
      testHarness.emit({
        type: 'rows',
        chatId: 'chat-b',
        viewId: 'view-b',
        rows: [ledgerRow('view-b', 1, 'first-b')],
      });

      await requireEventually(
        () => testHarness.servicePromises.has(indexKey('chat-b', 1)),
        'The controller did not admit chat B.',
      );
      await requireEventually(
        () => testHarness.indexer.receivedIndex('chat-b', 1),
        'Chat B was blocked behind chat A at the real service boundary.',
      );
      await testHarness.servicePromises.get(indexKey('chat-b', 1));
      expect(testHarness.indexer.receivedIndex('chat-a', 2)).toBe(false);

      testHarness.indexer.releaseIndex('chat-a', 1);
      await testHarness.servicePromises.get(indexKey('chat-a', 1));
      await requireEventually(
        () => testHarness.indexer.receivedIndex('chat-a', 2),
        'The second chat-A write did not follow the first acknowledgement.',
      );
      await testHarness.servicePromises.get(indexKey('chat-a', 2));

      testHarness.indexer.holdIndex('chat-c', 1);
      const pruneRequestCount = testHarness.indexer.pruneRequestCount();
      const admittedWrite = testHarness.service.replaceChat({
        chatId: 'chat-c',
        transcriptViewId: 'view-c',
        throughOrdinal: 1,
        rows: [searchRow(1, 'first-c')],
      });
      await requireEventually(
        () => testHarness.indexer.receivedIndex('chat-c', 1),
        'The pre-prune write did not reach the indexer.',
      );
      testHarness.indexer.holdPrune();
      const prune = testHarness.service.pruneChats(['chat-c', 'chat-d']);
      const laterWrite = testHarness.service.replaceChat({
        chatId: 'chat-d',
        transcriptViewId: 'view-d',
        throughOrdinal: 1,
        rows: [searchRow(1, 'first-d')],
      });
      await Promise.resolve();
      expect(testHarness.indexer.pruneRequestCount()).toBe(pruneRequestCount);
      expect(testHarness.indexer.receivedIndex('chat-d', 1)).toBe(false);

      testHarness.indexer.releaseIndex('chat-c', 1);
      await admittedWrite;
      await requireEventually(
        () => testHarness.indexer.pruneRequestCount() > pruneRequestCount,
        'Pruning did not begin after all previously admitted writes settled.',
      );
      expect(testHarness.indexer.receivedIndex('chat-d', 1)).toBe(false);

      testHarness.indexer.releasePrune();
      await prune;
      await requireEventually(
        () => testHarness.indexer.receivedIndex('chat-d', 1),
        'A post-prune write did not resume after the exclusive acknowledgement.',
      );
      await laterWrite;
      expect(unhandled).toEqual([]);
    } finally {
      testHarness.indexer.releaseAll();
      try {
        await testHarness.controller.close();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
