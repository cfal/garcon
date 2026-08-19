import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserMessage } from '../../../../common/chat-types.js';
import { TranscriptSearchService } from '../../../../server-agents/common/src/search/transcript-search-service.ts';
import { transcriptViewId } from '../../../ledger/contracts.js';
import { TranscriptSearchController } from '../controller.js';

const workspaces = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeLedger(count = 50) {
  const viewId = transcriptViewId('view-e2e');
  const rows = Array.from({ length: count }, (_, index) => ({
    kind: 'user-input',
    viewId,
    ordinal: index + 1,
    at: '2026-01-01T00:00:00.000Z',
    providerMeta: null,
    detail: {
      clientMessageId: null,
      message: new UserMessage(
        '2026-01-01T00:00:00.000Z',
        index % 7 === 0 ? 'controller service marker' : 'synthetic body',
      ),
      attachments: [],
      steer: false,
    },
  }));
  return {
    currentView: () => ({
      viewId,
      status: 'current',
      createdAt: '2026-01-01T00:00:00.000Z',
      contentStartOrdinal: 1,
    }),
    highWatermark: () => ({ viewId, ordinal: count }),
    replayRows: (_chatId, requestedView, after, through, limit) => (
      requestedView === viewId
        ? rows.filter((row) => row.ordinal > after && row.ordinal <= through).slice(0, limit)
        : []
    ),
    subscribe: () => () => {},
  };
}

function multiChatLedger(chats) {
  return {
    currentView: (chatId) => {
      const chat = chats.get(chatId);
      return chat ? {
        viewId: chat.viewId,
        status: 'current',
        createdAt: '2026-01-01T00:00:00.000Z',
        contentStartOrdinal: 1,
      } : null;
    },
    highWatermark: (chatId) => {
      const chat = chats.get(chatId);
      if (!chat) throw new Error('missing chat');
      return { viewId: chat.viewId, ordinal: chat.rows.at(-1)?.ordinal ?? 0 };
    },
    replayRows: (chatId, requestedView, after, through, limit) => {
      const chat = chats.get(chatId);
      return chat && requestedView === chat.viewId
        ? chat.rows.filter((entry) => entry.ordinal > after && entry.ordinal <= through).slice(0, limit)
        : [];
    },
    subscribe: () => () => {},
  };
}

function chatRows(viewId, count, marker) {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'user-input',
    viewId,
    ordinal: index + 1,
    at: '2026-01-01T00:00:00.000Z',
    providerMeta: null,
    detail: {
      clientMessageId: null,
      message: new UserMessage(
        '2026-01-01T00:00:00.000Z',
        index === 0 ? marker : `synthetic body ${index}`,
      ),
      attachments: [],
      steer: false,
    },
  }));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition not reached');
    await Bun.sleep(25);
  }
}

describe('TranscriptSearchController with v9 Workers', () => {
  test('[TLV5-SEARCH.06-SVC-02] builds, searches, and restarts as a durable no-op', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'search-v9-controller-service-'));
    workspaces.push(workspace);
    const ledger = fakeLedger();
    const firstService = new TranscriptSearchService({ workspaceDirectory: workspace, logger: logger() });
    const first = new TranscriptSearchController({
      listChatIds: () => ['chat-e2e'], ledger, service: firstService, logger: logger(),
    });
    await first.start();
    await waitFor(() => first.status().phase === 'ready');
    const result = await first.search({ query: 'marker', allowedChatIds: ['chat-e2e'] });
    expect(result.results).toEqual([expect.objectContaining({ chatId: 'chat-e2e' })]);
    const before = await firstService.chatStates();
    await first.close();

    const secondService = new TranscriptSearchService({ workspaceDirectory: workspace, logger: logger() });
    const second = new TranscriptSearchController({
      listChatIds: () => ['chat-e2e'], ledger, service: secondService, logger: logger(),
    });
    await second.start();
    await waitFor(() => second.status().phase === 'ready');
    expect(await secondService.chatStates()).toEqual(before);
    await expect(second.search({
      query: 'marker', allowedChatIds: ['chat-e2e'],
    })).resolves.toMatchObject({ results: [expect.objectContaining({ chatId: 'chat-e2e' })] });
    await second.close();
  });

  test('[TLV5-SEARCH.09-SVC-02] searches committed prefixes while another chat builds', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'search-v9-controller-service-'));
    workspaces.push(workspace);
    const marker = 'committedprefixmarker';
    const chats = new Map([
      ['chat-a', {
        viewId: transcriptViewId('view-a'),
        rows: chatRows(transcriptViewId('view-a'), 50, marker),
      }],
      ['chat-b', {
        viewId: transcriptViewId('view-b'),
        rows: chatRows(transcriptViewId('view-b'), 1_200, marker),
      }],
    ]);
    const ledger = multiChatLedger(chats);
    const service = new TranscriptSearchService({ workspaceDirectory: workspace, logger: logger() });
    const firstFrameCommitted = deferred();
    const releaseBuild = deferred();
    const syncChat = service.syncChat.bind(service);
    service.syncChat = (request) => syncChat(request.chatId !== 'chat-b'
      ? request
      : {
          ...request,
          source: async function* (afterOrdinal) {
            let first = true;
            for await (const frame of request.source(afterOrdinal)) {
              yield frame;
              if (first) {
                first = false;
                firstFrameCommitted.resolve();
                await releaseBuild.promise;
              }
            }
          },
        });
    const controller = new TranscriptSearchController({
      listChatIds: () => [...chats.keys()],
      ledger,
      service,
      logger: logger(),
    });
    await controller.start();
    try {
      await firstFrameCommitted.promise;
      await waitFor(() => (
        controller.status().chats.indexed === 1
        && controller.status().chats.pending === 1
      ));
      const during = await controller.search({
        query: marker,
        allowedChatIds: [...chats.keys()],
        limit: 20,
      });
      expect(during.results.map((result) => result.chatId).sort()).toEqual(['chat-a', 'chat-b']);
      expect(during.index).toMatchObject({ indexedChatCount: 1, pendingChatCount: 1 });
      releaseBuild.resolve();
      await waitFor(() => controller.status().phase === 'ready');
    } finally {
      releaseBuild.resolve();
      await controller.close();
    }
  });

  test('[TLV5-L01.02-SEARCH-CATALOG-PRUNE-SERVICE-01] retains a chat adopted during resync pruning', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'search-v9-controller-service-'));
    workspaces.push(workspace);
    const marker = 'adoptedcatalogmarker';
    const chats = new Map([[
      'chat-a',
      {
        viewId: transcriptViewId('view-a'),
        rows: chatRows(transcriptViewId('view-a'), 20, 'startup marker'),
      },
    ]]);
    const ledger = multiChatLedger(chats);
    const service = new TranscriptSearchService({ workspaceDirectory: workspace, logger: logger() });
    const firstSyncStarted = deferred();
    const releaseFirstSync = deferred();
    const syncChat = service.syncChat.bind(service);
    let holdFirstSync = true;
    service.syncChat = async (request) => {
      if (request.chatId === 'chat-a' && holdFirstSync) {
        holdFirstSync = false;
        firstSyncStarted.resolve();
        await releaseFirstSync.promise;
      }
      await syncChat(request);
    };
    const controller = new TranscriptSearchController({
      listChatIds: () => [...chats.keys()],
      ledger,
      service,
      logger: logger(),
    });
    await controller.start();
    try {
      await firstSyncStarted.promise;
      chats.set('chat-b', {
        viewId: transcriptViewId('view-b'),
        rows: chatRows(transcriptViewId('view-b'), 20, marker),
      });
      controller.catalogMayHaveChanged('chat-b');
      releaseFirstSync.resolve();
      await waitFor(() => controller.status().phase === 'ready');
      await expect(controller.search({
        query: marker,
        allowedChatIds: ['chat-b'],
      })).resolves.toMatchObject({
        results: [expect.objectContaining({ chatId: 'chat-b', transcriptViewId: 'view-b' })],
        index: { indexedChatCount: 1, pendingChatCount: 0 },
      });
    } finally {
      releaseFirstSync.resolve();
      await controller.close();
    }
  });
});
