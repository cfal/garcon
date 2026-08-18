import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '../../../../common/chat-types.js';
import {
  TranscriptSearchService,
  TranscriptSearchWorkerError,
} from '../../../../server-agents/common/src/search/transcript-search-service.ts';
import { TranscriptSearchController } from '../controller.js';

function indexKey(chatId, throughOrdinal) {
  return `${chatId}:${throughOrdinal}`;
}

class ControlledSearchIndex {
  chats = new Map();

  index(build) {
    const current = this.chats.get(build.chatId);
    if (build.mode === 'append') {
      if (!current || current.transcriptViewId !== build.transcriptViewId) {
        throw new Error('SEARCH_VIEW_MISMATCH');
      }
      if (current.throughOrdinal !== build.expectedAfterOrdinal) {
        throw new Error('SEARCH_INDEX_GAP');
      }
    }
    const rows = build.mode === 'append' ? [...current.rows, ...build.rows] : [...build.rows];
    this.chats.set(build.chatId, {
      transcriptViewId: build.transcriptViewId,
      throughOrdinal: build.throughOrdinal,
      status: 'indexed',
      rows,
    });
  }

  markFailed(request) {
    const current = this.chats.get(request.chatId);
    const sameView = current?.transcriptViewId === request.transcriptViewId;
    this.chats.set(request.chatId, {
      transcriptViewId: request.transcriptViewId,
      throughOrdinal: sameView ? current.throughOrdinal : 0,
      status: 'failed',
      rows: sameView ? current.rows : [],
    });
  }

  prune(chatIds) {
    const retained = new Set(chatIds);
    for (const chatId of this.chats.keys()) {
      if (!retained.has(chatId)) this.chats.delete(chatId);
    }
  }

  search(query, allowedChats) {
    const index = {
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    };
    const results = [];
    const tokens = query.clauses.flatMap((clause) => clause.tokens.map((token) => token.normalized));
    for (const allowed of allowedChats) {
      const current = this.chats.get(allowed.chatId);
      if (!current || current.transcriptViewId !== allowed.transcriptViewId) {
        index.pendingChatCount += 1;
        continue;
      }
      if (current.status === 'failed') {
        index.failedChatCount += 1;
        continue;
      }
      if (current.throughOrdinal < allowed.throughOrdinal) {
        index.pendingChatCount += 1;
        continue;
      }
      index.indexedChatCount += 1;
      const matches = current.rows.filter((row) => (
        tokens.every((token) => row.body.toLowerCase().includes(token))
      ));
      if (matches.length === 0 || tokens.length === 0) continue;
      results.push({
        chatId: allowed.chatId,
        transcriptViewId: allowed.transcriptViewId,
        score: 1,
        matchedMessageCount: matches.length,
        snippets: matches.slice(0, 3).map((row) => ({
          ordinal: row.ordinal,
          role: row.role,
          timestamp: row.timestamp,
          text: row.body,
        })),
      });
    }
    return { results, index };
  }
}

class ControlledIndexerWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  readonlyState;
  #builds = new Map();
  #receivedIndexes = new Set();
  #failures = new Map();
  #heldIndexes = new Set();
  #heldIndexRequests = new Map();
  #holdPrune = false;
  #heldPruneRequest = null;

  constructor(state) {
    this.readonlyState = state;
  }

  holdIndex(chatId, throughOrdinal) {
    this.#heldIndexes.add(indexKey(chatId, throughOrdinal));
  }

  rejectNextIndex(chatId, throughOrdinal, code, retryable) {
    this.#failures.set(indexKey(chatId, throughOrdinal), { code, retryable });
  }

  releaseIndex(chatId, throughOrdinal) {
    const key = indexKey(chatId, throughOrdinal);
    this.#heldIndexes.delete(key);
    const held = this.#heldIndexRequests.get(key);
    if (!held) return;
    this.#heldIndexRequests.delete(key);
    this.readonlyState.index(held.build);
    this.#emit({ type: 'ack', ...identity(held.request) });
  }

  holdPrune() {
    this.#holdPrune = true;
  }

  releasePrune() {
    this.#holdPrune = false;
    const request = this.#heldPruneRequest;
    this.#heldPruneRequest = null;
    if (request) {
      this.readonlyState.prune(request.chatIds);
      this.#emit({ type: 'ack', ...identity(request) });
    }
  }

  releaseAll() {
    for (const held of this.#heldIndexRequests.values()) {
      this.#emit({ type: 'ack', ...identity(held.request) });
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
        this.#builds.set(request.requestId, { ...request, rows: [] });
        return;
      case 'index-chunk': {
        const build = this.#builds.get(request.requestId);
        build?.rows.push(...request.rows);
        if (!request.done) return;
        const key = indexKey(build?.chatId, build?.throughOrdinal);
        this.#receivedIndexes.add(key);
        this.#builds.delete(request.requestId);
        if (this.#heldIndexes.has(key)) {
          this.#heldIndexRequests.set(key, { request, build });
          return;
        }
        const failure = this.#failures.get(key);
        if (failure) {
          this.#failures.delete(key);
          this.#emit({ type: 'error', ...identity(request), ...failure });
          return;
        }
        try {
          this.readonlyState.index(build);
        } catch (error) {
          this.#emit({
            type: 'error',
            ...identity(request),
            code: error.message,
            retryable: false,
          });
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
        this.readonlyState.prune(request.chatIds);
        this.#emit({ type: 'ack', ...identity(request) });
        return;
      case 'delete-chat':
        this.readonlyState.chats.delete(request.chatId);
        this.#emit({ type: 'ack', ...identity(request) });
        return;
      case 'mark-failed':
        this.readonlyState.markFailed(request);
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
  #state;
  #searches = new Map();

  constructor(state) {
    this.#state = state;
  }

  postMessage(request) {
    switch (request.type) {
      case 'open':
        this.#emit({ type: 'opened', ...identity(request) });
        return;
      case 'search-start':
        this.#searches.set(request.requestId, { query: request.query, allowedChats: [] });
        return;
      case 'search-allowlist-chunk': {
        const search = this.#searches.get(request.requestId);
        search.allowedChats.push(...request.allowedChats);
        if (!request.done) return;
        this.#searches.delete(request.requestId);
        this.#emit({
          type: 'search-result',
          ...identity(request),
          ...this.#state.search(search.query, search.allowedChats),
        });
        return;
      }
      case 'close':
        this.#emit({ type: 'closed', ...identity(request) });
        return;
      default:
        throw new Error(`Unexpected reader request: ${request.type}`);
    }
  }

  terminate() {}

  #emit(data) {
    this.onmessage?.({ data });
  }
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
    await Bun.sleep(0);
  }
  throw new Error(message);
}

function createHarness(root) {
  const state = new ControlledSearchIndex();
  const indexer = new ControlledIndexerWorker(state);
  const reader = new ControlledReaderWorker(state);
  const service = new TranscriptSearchService({
    workspaceDirectory: root,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    workerFactory: (role) => role === 'indexer' ? indexer : reader,
  });
  let resyncHandler = null;
  const setResyncHandler = service.setResyncHandler.bind(service);
  service.setResyncHandler = (handler) => {
    resyncHandler = handler;
    setResyncHandler(handler);
  };
  const servicePromises = new Map();
  const appendRows = service.appendRows.bind(service);
  service.appendRows = (input) => {
    const result = appendRows(input);
    servicePromises.set(indexKey(input.chatId, input.throughOrdinal), result);
    return result;
  };
  const views = new Map();
  let listener = null;
  const warnings = [];
  const controller = new TranscriptSearchController({
    listChatIds: () => [...views.keys()],
    ledger: {
      currentView: (chatId) => views.get(chatId) ?? null,
      currentRows: (chatId) => views.get(chatId)?.rows ?? [],
      highWatermark: (chatId) => {
        const view = views.get(chatId);
        return { viewId: view.viewId, ordinal: view.rows?.at(-1)?.ordinal ?? 0 };
      },
      subscribe(candidate) {
        listener = candidate;
        return () => { listener = null; };
      },
    },
    service,
    logger: { warn: (...args) => warnings.push(args) },
  });
  return {
    controller,
    emit: (event) => listener(event),
    indexer,
    service,
    servicePromises,
    state,
    views,
    warnings,
    resync: () => {
      if (!resyncHandler) throw new Error('Search resync handler was not registered.');
      return resyncHandler();
    },
  };
}

describe('TranscriptSearchController with the real search service', () => {
  test('[TLV5-SEARCH.02-RESYNC-SERVICE-UNIT-01] isolates rejected replacements during startup and restart resync', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-resync-'));
    const testHarness = createHarness(root);
    const query = 'resyncneedle';
    try {
      testHarness.views.set('chat-a', {
        viewId: 'view-a',
        contentStartOrdinal: 1,
        rows: [ledgerRow('view-a', 1, 'rejected chat')],
      });
      testHarness.views.set('chat-b', {
        viewId: 'view-b',
        contentStartOrdinal: 1,
        rows: [ledgerRow('view-b', 1, query)],
      });
      testHarness.indexer.rejectNextIndex('chat-a', 1, 'SEARCH_WRITE_REJECTED', false);

      await testHarness.controller.initialize(true);
      expect(await testHarness.controller.search({
        query,
        allowedChatIds: ['chat-a', 'chat-b'],
      })).toMatchObject({
        results: [{ chatId: 'chat-b', transcriptViewId: 'view-b' }],
        index: { indexedChatCount: 1, failedChatCount: 1 },
      });

      testHarness.indexer.rejectNextIndex('chat-a', 1, 'SEARCH_WRITE_REJECTED', false);
      await testHarness.resync();
      expect(await testHarness.controller.search({
        query,
        allowedChatIds: ['chat-a', 'chat-b'],
      })).toMatchObject({
        results: [{ chatId: 'chat-b', transcriptViewId: 'view-b' }],
        index: { indexedChatCount: 1, failedChatCount: 1 },
      });
      expect(testHarness.warnings.map(([, details]) => details.code)).toEqual([
        'SEARCH_WRITE_REJECTED',
        'SEARCH_WRITE_REJECTED',
      ]);
    } finally {
      try {
        await testHarness.controller.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('[TLV5-L01.02-SEARCH-CATALOG-PRUNE-SERVICE-01] retains a chat adopted during resync pruning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-catalog-prune-'));
    const testHarness = createHarness(root);
    const query = 'adoptedneedle';
    try {
      testHarness.views.set('chat-a', {
        viewId: 'view-a',
        contentStartOrdinal: 1,
        rows: [ledgerRow('view-a', 1, 'held startup chat')],
      });
      testHarness.indexer.holdIndex('chat-a', 1);
      const initializing = testHarness.controller.initialize(true);
      await requireEventually(
        () => testHarness.indexer.receivedIndex('chat-a', 1),
        'The startup replacement did not reach the indexer.',
      );

      testHarness.views.set('chat-b', {
        viewId: 'view-b',
        contentStartOrdinal: 1,
        rows: [ledgerRow('view-b', 1, query)],
      });
      testHarness.controller.catalogMayHaveChanged('chat-b');
      await requireEventually(
        () => testHarness.state.chats.get('chat-b')?.throughOrdinal === 1,
        'The adopted chat did not finish indexing during resync.',
      );

      testHarness.indexer.releaseIndex('chat-a', 1);
      await initializing;
      expect(await testHarness.controller.search({
        query,
        allowedChatIds: ['chat-b'],
      })).toMatchObject({
        results: [{ chatId: 'chat-b', transcriptViewId: 'view-b' }],
        index: { indexedChatCount: 1, pendingChatCount: 0 },
      });
    } finally {
      testHarness.indexer.releaseAll();
      try {
        await testHarness.controller.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

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

  test('[TLV5-SEARCH.05-SERVICE-UNIT-01] records terminal failure and clears it after full repair', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-health-'));
    const testHarness = createHarness(root);
    const input = {
      chatId: 'chat-health',
      transcriptViewId: 'view-health',
      throughOrdinal: 2,
      rows: [searchRow(2, 'synthetic needle')],
    };
    const query = {
      version: 1,
      clauses: [{
        kind: 'all-words',
        tokens: [{ text: 'needle', normalized: 'needle', match: 'prefix' }],
      }],
    };
    try {
      await testHarness.controller.initialize(true);
      testHarness.indexer.rejectNextIndex(
        input.chatId,
        input.throughOrdinal,
        'SEARCH_WRITE_REJECTED',
        false,
      );

      await expect(testHarness.service.replaceChat(input)).rejects.toEqual(
        expect.objectContaining({
          name: TranscriptSearchWorkerError.name,
          code: 'SEARCH_WRITE_REJECTED',
          retryable: false,
          message: 'SEARCH_WRITE_REJECTED',
        }),
      );
      expect(testHarness.indexer.requests
        .filter((request) => request.type === 'mark-failed')
        .map(({ chatId, transcriptViewId, errorCode }) => ({
          chatId,
          transcriptViewId,
          errorCode,
        }))).toEqual([{
        chatId: 'chat-health',
        transcriptViewId: 'view-health',
        errorCode: 'SEARCH_WRITE_REJECTED',
      }]);

      const allowedChats = [{
        chatId: 'chat-health',
        transcriptViewId: 'view-health',
        throughOrdinal: 2,
      }];
      const failed = await testHarness.service.search({
        query,
        allowedChats,
        limit: 20,
        signal: new AbortController().signal,
      });
      expect(failed).toEqual({
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 1,
          unsupportedChatCount: 0,
        },
      });

      await testHarness.service.replaceChat(input);
      const repaired = await testHarness.service.search({
        query,
        allowedChats,
        limit: 20,
        signal: new AbortController().signal,
      });
      expect(repaired).toEqual({
        results: [{
          chatId: 'chat-health',
          transcriptViewId: 'view-health',
          score: 1,
          matchedMessageCount: 1,
          snippets: [{
            ordinal: 2,
            role: 'user',
            timestamp: null,
            text: 'synthetic needle',
          }],
        }],
        index: {
          indexedChatCount: 1,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
      });
    } finally {
      try {
        await testHarness.controller.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
