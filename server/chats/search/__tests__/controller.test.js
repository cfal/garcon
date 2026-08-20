import { describe, expect, mock, test } from 'bun:test';
import { ErrorMessage, UserMessage } from '../../../../common/chat-types.js';
import { transcriptViewId } from '../../../ledger/contracts.js';
import { LedgerFencedError } from '../../../ledger/errors.js';
import { TranscriptSearchController } from '../controller.js';

function row(ordinal, body, viewId = 'view-0001') {
  return {
    kind: 'user-input',
    viewId: transcriptViewId(viewId),
    ordinal,
    at: '2026-01-01T00:00:00.000Z',
    providerMeta: null,
    detail: {
      clientMessageId: null,
      message: new UserMessage('2026-01-01T00:00:00.000Z', body),
      attachments: [],
      steer: false,
    },
  };
}

function chatRow(ordinal, presentation, content, viewId = 'view-0001') {
  return {
    kind: 'notice',
    viewId: transcriptViewId(viewId),
    ordinal,
    at: '2026-01-01T00:00:01.000Z',
    message: content,
    detail: {
      type: 'cli-row',
      clientMessageId: `chat-row-${ordinal}`,
      presentation,
      title: null,
    },
    providerMeta: null,
  };
}

function providerErrorRow(ordinal, content, viewId = 'view-0001') {
  const message = new ErrorMessage('2026-01-01T00:00:02.000Z', content);
  return {
    kind: 'provider-row',
    viewId: transcriptViewId(viewId),
    ordinal,
    at: message.timestamp,
    message,
    providerMeta: null,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('condition not reached');
    await Bun.sleep(5);
  }
}

function harness(options = {}) {
  const chats = new Map(options.chats ?? [[
    'chat-0001',
    { viewId: transcriptViewId('view-0001'), rows: [row(1, 'alpha'), row(2, 'bravo')] },
  ]]);
  let listener = () => {};
  const replayCalls = [];
  const ledger = {
    currentView: mock((chatId) => {
      if (options.fencedChats?.has(chatId)) {
        throw new LedgerFencedError(chatId, { cause: { code: 'SQLITE_CORRUPT' } });
      }
      if (options.currentView) return options.currentView(chatId, chats);
      const chat = chats.get(chatId);
      return chat ? {
        viewId: chat.viewId,
        status: 'current',
        createdAt: '2026-01-01T00:00:00.000Z',
        contentStartOrdinal: 1,
      } : null;
    }),
    highWatermark: mock((chatId) => {
      if (options.highWatermark) return options.highWatermark(chatId, chats);
      const chat = chats.get(chatId);
      if (!chat) throw new Error('missing chat');
      return { viewId: chat.viewId, ordinal: chat.rows.at(-1)?.ordinal ?? 0 };
    }),
    replayRows: mock((chatId, viewId, after, through, limit) => {
      replayCalls.push({ chatId, viewId, after, through, limit });
      if (options.replayRows) {
        return options.replayRows(chatId, viewId, after, through, limit, chats);
      }
      const chat = chats.get(chatId);
      if (!chat || chat.viewId !== viewId) return [];
      return chat.rows.filter((entry) => entry.ordinal > after && entry.ordinal <= through)
        .slice(0, limit);
    }),
    subscribe: mock((callback) => {
      listener = callback;
      return () => {};
    }),
  };
  const states = options.states ?? [];
  const resyncScopes = [];
  const syncCalls = [];
  const service = {
    enable: mock(async () => {}),
    close: mock(async () => {}),
    disableAndDelete: mock(async () => {}),
    setResyncHandler: mock((handler) => { service.resyncHandler = handler; }),
    chatStates: mock(async () => states),
    beginResync: mock((total) => {
      const calls = { total, settled: 0, completed: 0, failures: [] };
      resyncScopes.push(calls);
      return {
        chatSettled: () => { calls.settled += 1; },
        complete: () => { calls.completed += 1; },
        fail: (code) => calls.failures.push(code),
      };
    }),
    recordResyncFailure: mock(() => {}),
    syncChat: mock(async (request) => {
      const frames = [];
      syncCalls.push({ request, frames });
      if (options.syncChat) return options.syncChat(request, frames);
      if (options.syncError) {
        const error = options.syncError;
        options.syncError = null;
        throw error;
      }
      for await (const frame of request.source(request.expectedAfterOrdinal)) frames.push(frame);
    }),
    deleteChat: mock(async () => {}),
    markChatUnavailable: mock(async () => {}),
    search: mock(async () => ({
      results: [],
      index: {
        indexedChatCount: 0,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    })),
    status: mock(() => ({
      version: 1,
      phase: 'ready',
      chats: { indexed: 0, pending: 0, failed: 0 },
      queuedJobs: 0,
      resync: null,
      backlogRows: 0,
      activeChat: null,
      lastErrorCode: null,
      updatedAt: new Date(0).toISOString(),
    })),
    queryStats: mock(() => ({
      served: 0, timedOut: 0, rejectedBusy: 0, p50Ms: 0, p95Ms: 0, maxMs: 0,
    })),
    onStatusChanged: mock(() => () => {}),
    resyncHandler: null,
  };
  const logger = { warn: mock(() => {}), info: mock(() => {}) };
  const controller = new TranscriptSearchController({
    listChatIds: options.listChatIds ?? (() => [...chats.keys()]),
    ledger,
    service,
    logger,
    searchTimeoutMs: 100,
  });
  return {
    chats,
    controller,
    ledger,
    listener: (event) => listener(event),
    logger,
    replayCalls,
    resyncScopes,
    service,
    syncCalls,
  };
}

describe('TranscriptSearchController v9', () => {
  test('[TLV5-SEARCH.09-CORE-02] start settles after admission, before resync', async () => {
    const gate = deferred();
    const fixture = harness();
    fixture.service.chatStates.mockImplementation(() => gate.promise);
    await fixture.controller.start();
    expect(fixture.service.enable).toHaveBeenCalledTimes(1);
    await waitFor(() => fixture.service.chatStates.mock.calls.length === 1);
    expect(fixture.service.chatStates).toHaveBeenCalledTimes(1);
    gate.resolve([]);
    await waitFor(() => fixture.resyncScopes.length === 1);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.06-CORE-01] matching durable states skip all row reads and writes', async () => {
    const chats = Array.from({ length: 5 }, (_, index) => {
      const id = `chat-${index}`;
      const viewId = transcriptViewId(`view-${index}`);
      return [id, { viewId, rows: [row(1, `body-${index}`, viewId)] }];
    });
    const states = chats.map(([chatId, chat]) => ({
      chatId,
      transcriptViewId: chat.viewId,
      status: 'indexed',
      indexedThrough: 1,
      targetThrough: 1,
      lastErrorCode: null,
    }));
    const fixture = harness({ chats, states });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.service.syncChat).not.toHaveBeenCalled();
    expect(fixture.ledger.replayRows).not.toHaveBeenCalled();
    expect(fixture.resyncScopes[0]).toMatchObject({ total: 5, settled: 5, completed: 1 });
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.04-CORE-02] converged searches reuse catalog ledger snapshots', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.ledger.currentView.mockClear();
    fixture.ledger.highWatermark.mockClear();

    await fixture.controller.search({ query: 'alpha', allowedChatIds: ['chat-0001'] });
    await fixture.controller.search({ query: 'bravo', allowedChatIds: ['chat-0001'] });

    expect(fixture.ledger.currentView).not.toHaveBeenCalled();
    expect(fixture.ledger.highWatermark).not.toHaveBeenCalled();
    expect(fixture.service.search.mock.calls.map(([request]) => request.allowedChats)).toEqual([
      [{ chatId: 'chat-0001', transcriptViewId: 'view-0001', throughOrdinal: 2 }],
      [{ chatId: 'chat-0001', transcriptViewId: 'view-0001', throughOrdinal: 2 }],
    ]);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.06-CORE-02] mixed resync streams pages and prunes index-only state', async () => {
    const rows = Array.from({ length: 1_300 }, (_, index) => row(index + 1, `body-${index}`));
    const fixture = harness({
      chats: [['chat-0001', { viewId: transcriptViewId('view-0001'), rows }]],
      states: [{
        chatId: 'chat-stale', transcriptViewId: 'view-stale', status: 'indexed',
        indexedThrough: 1, targetThrough: 1, lastErrorCode: null,
      }],
    });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.service.syncChat).toHaveBeenCalledTimes(1);
    expect(fixture.syncCalls[0].frames.map((frame) => frame.rows.length))
      .toEqual([512, 512, 276]);
    expect(fixture.syncCalls[0].frames.map((frame) => frame.advanceTo))
      .toEqual([512, 1_024, 1_300]);
    expect(fixture.service.deleteChat).toHaveBeenCalledWith('chat-stale');
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.07-CORE-01] ledger frames advance only when the consumer pulls', async () => {
    const rows = Array.from({ length: 1_300 }, (_, index) => row(index + 1, `body-${index}`));
    const syncGate = deferred();
    const fixture = harness({
      chats: [['chat-0001', { viewId: transcriptViewId('view-0001'), rows }]],
      syncChat: () => syncGate.promise,
    });
    await fixture.controller.start();
    await waitFor(() => fixture.syncCalls.length === 1);
    const source = fixture.syncCalls[0].request.source(0);
    expect(fixture.replayCalls).toHaveLength(0);

    expect(await source.next()).toEqual({
      done: false,
      value: { rows: expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]), advanceTo: 512 },
    });
    expect(fixture.replayCalls).toHaveLength(1);
    await Bun.sleep(10);
    expect(fixture.replayCalls).toHaveLength(1);

    expect((await source.next()).value).toMatchObject({ advanceTo: 1_024 });
    expect(fixture.replayCalls).toHaveLength(2);
    expect((await source.next()).value).toMatchObject({ advanceTo: 1_300 });
    expect(fixture.replayCalls).toHaveLength(3);
    expect(await source.next()).toEqual({ done: true, value: undefined });
    syncGate.resolve();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.07-CORE-02] an empty page cannot fabricate frontier progress', async () => {
    const fixture = harness({ replayRows: () => [] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.syncCalls).toHaveLength(1);
    expect(fixture.syncCalls[0].frames).toEqual([]);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Transcript search indexing job failed',
      { chatId: 'chat-0001', operation: 'resync', code: 'SEARCH_INDEX_GAP' },
    );
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.01-CORE-01] commits use one ordered append frame', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;
    const appended = row(3, 'suffix');
    fixture.chats.get('chat-0001').rows.push(appended);
    fixture.listener({
      type: 'rows', chatId: 'chat-0001', viewId: transcriptViewId('view-0001'), rows: [appended],
    });
    await waitFor(() => fixture.service.syncChat.mock.calls.length === 1);
    expect(fixture.syncCalls[0].request).toMatchObject({
      mode: 'append', expectedAfterOrdinal: 2, targetThrough: 3,
    });
    expect(fixture.syncCalls[0].frames).toEqual([{
      rows: [expect.objectContaining({ ordinal: 3, body: 'suffix' })], advanceTo: 3,
    }]);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.01-CORE-02] an append gap falls back to a full sync', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;
    fixture.service.syncChat.mockRejectedValueOnce(new Error('SEARCH_INDEX_GAP'));
    const appended = row(3, 'suffix');
    fixture.chats.get('chat-0001').rows.push(appended);
    fixture.listener({
      type: 'rows', chatId: 'chat-0001', viewId: transcriptViewId('view-0001'), rows: [appended],
    });
    await waitFor(() => fixture.service.syncChat.mock.calls.length === 2);
    expect(fixture.service.syncChat.mock.calls[1][0]).toMatchObject({ mode: 'replace' });
    await fixture.controller.close();
  });

  test('advances the frontier across chat rows and provider errors without indexing them', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;
    const appended = [
      chatRow(3, 'notice', 'not searchable'),
      chatRow(4, 'error', 'also not searchable'),
      providerErrorRow(5, 'provider error'),
    ];
    for (const entry of appended) {
      fixture.chats.get('chat-0001').rows.push(entry);
      fixture.listener({
        type: 'rows', chatId: 'chat-0001', viewId: transcriptViewId('view-0001'), rows: [entry],
      });
    }

    await waitFor(() => fixture.syncCalls.length === 3);
    expect(fixture.syncCalls.map(({ request, frames }) => ({
      expectedAfterOrdinal: request.expectedAfterOrdinal,
      targetThrough: request.targetThrough,
      frames,
    }))).toEqual([
      { expectedAfterOrdinal: 2, targetThrough: 3, frames: [{ rows: [], advanceTo: 3 }] },
      { expectedAfterOrdinal: 3, targetThrough: 4, frames: [{ rows: [], advanceTo: 4 }] },
      { expectedAfterOrdinal: 4, targetThrough: 5, frames: [{ rows: [], advanceTo: 5 }] },
    ]);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.06-CORE-03] a fenced chat is retained and marked unavailable', async () => {
    const fixture = harness({
      chats: [
        ['chat-fenced', { viewId: transcriptViewId('view-fenced'), rows: [row(1, 'bad')] }],
        ['chat-good', { viewId: transcriptViewId('view-good'), rows: [row(1, 'good', 'view-good')] }],
      ],
      fencedChats: new Set(['chat-fenced']),
    });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.service.markChatUnavailable).toHaveBeenCalledWith(
      'chat-fenced', 'ledger-fenced', 'SQLITE_CORRUPT',
    );
    expect(fixture.service.deleteChat).not.toHaveBeenCalledWith('chat-fenced');
    expect(fixture.service.syncChat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-good' }),
    );
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Transcript search indexing job failed',
      { chatId: 'chat-fenced', operation: 'resync', code: 'SQLITE_CORRUPT' },
    );
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.06-CORE-04] resync settles every classification before completion', async () => {
    const chats = [
      ['chat-current-a', {
        viewId: transcriptViewId('view-current-a'),
        rows: [row(1, 'a', 'view-current-a')],
      }],
      ['chat-current-b', {
        viewId: transcriptViewId('view-current-b'),
        rows: [row(1, 'b', 'view-current-b')],
      }],
      ['chat-fenced', {
        viewId: transcriptViewId('view-fenced'),
        rows: [row(1, 'fenced', 'view-fenced')],
      }],
      ['chat-sync', {
        viewId: transcriptViewId('view-sync'),
        rows: [row(1, 'sync', 'view-sync')],
      }],
    ];
    const states = [
      ...chats.slice(0, 2).map(([chatId, chat]) => ({
        chatId,
        transcriptViewId: chat.viewId,
        status: 'indexed',
        indexedThrough: 1,
        targetThrough: 1,
        lastErrorCode: null,
      })),
      {
        chatId: 'chat-no-view',
        transcriptViewId: 'view-no-view',
        status: 'indexed',
        indexedThrough: 1,
        targetThrough: 1,
        lastErrorCode: null,
      },
      {
        chatId: 'chat-index-only',
        transcriptViewId: 'view-index-only',
        status: 'indexed',
        indexedThrough: 1,
        targetThrough: 1,
        lastErrorCode: null,
      },
    ];
    const registry = [
      'chat-current-a', 'chat-current-b', 'chat-fenced', 'chat-no-view', 'chat-sync',
    ];
    const fixture = harness({
      chats,
      states,
      fencedChats: new Set(['chat-fenced']),
      listChatIds: () => registry,
    });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.resyncScopes[0]).toEqual({ total: 5, settled: 5, completed: 1, failures: [] });
    expect(fixture.service.deleteChat.mock.calls.map(([chatId]) => chatId))
      .toEqual(['chat-no-view', 'chat-index-only']);
    expect(fixture.service.syncChat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-sync' }),
    );
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.06-CORE-06] disabling abandons an in-flight resync scope', async () => {
    const syncGate = deferred();
    const chats = [
      ['chat-a', { viewId: transcriptViewId('view-a'), rows: [row(1, 'a', 'view-a')] }],
      ['chat-b', { viewId: transcriptViewId('view-b'), rows: [row(1, 'b', 'view-b')] }],
    ];
    const fixture = harness({ chats, syncChat: () => syncGate.promise });
    await fixture.controller.start();
    await waitFor(() => fixture.syncCalls.length === 1);
    const disabling = fixture.controller.disableAndDelete();
    syncGate.resolve();
    await disabling;
    await fixture.controller.close();
    expect(fixture.resyncScopes[0]).toEqual({ total: 2, settled: 1, completed: 0, failures: [] });
    expect(fixture.service.syncChat).toHaveBeenCalledTimes(1);
  });

  test('[TLV5-SEARCH.06-CORE-05] records failures before and during catalog resync', async () => {
    const preScope = harness({ listChatIds: () => { throw new TypeError('catalog failed'); } });
    await preScope.controller.start();
    await waitFor(() => preScope.service.recordResyncFailure.mock.calls.length === 1);
    expect(preScope.service.recordResyncFailure).toHaveBeenCalledWith('SEARCH_RESYNC_FAILED');
    expect(preScope.service.beginResync).not.toHaveBeenCalled();
    await preScope.controller.close();

    const chats = [
      ['chat-good', {
        viewId: transcriptViewId('view-good'),
        rows: [row(1, 'good', 'view-good')],
      }],
      ['chat-bad', {
        viewId: transcriptViewId('view-bad'),
        rows: [row(1, 'bad', 'view-bad')],
      }],
    ];
    const midScope = harness({
      chats,
      states: [{
        chatId: 'chat-good',
        transcriptViewId: 'view-good',
        status: 'indexed',
        indexedThrough: 1,
        targetThrough: 1,
        lastErrorCode: null,
      }],
      highWatermark: (chatId, allChats) => {
        if (chatId === 'chat-bad') throw new TypeError('broken high watermark');
        const chat = allChats.get(chatId);
        return { viewId: chat.viewId, ordinal: chat.rows.at(-1).ordinal };
      },
    });
    await midScope.controller.start();
    await waitFor(() => midScope.resyncScopes[0]?.failures.length === 1);
    expect(midScope.resyncScopes[0]).toEqual({
      total: 2, settled: 2, completed: 0, failures: ['SEARCH_RESYNC_FAILED'],
    });
    expect(midScope.logger.warn).toHaveBeenCalledWith(
      'Transcript search catalog job failed',
      { operation: 'synchronization', code: 'SEARCH_RESYNC_FAILED' },
    );
    await midScope.controller.close();
  });

  test('[TLV5-SEARCH.09-CORE-01] preserves timeout, busy, and unavailable taxonomy', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    for (const [source, expected] of [
      ['SEARCH_TIMEOUT', 'SEARCH_TIMEOUT'],
      ['SEARCH_INDEX_BUSY', 'SEARCH_INDEX_BUSY'],
      ['anything else', 'SEARCH_INDEX_UNAVAILABLE'],
    ]) {
      fixture.service.search.mockRejectedValueOnce(new Error(source));
      await expect(fixture.controller.search({
        query: 'alpha', allowedChatIds: ['chat-0001'],
      })).rejects.toMatchObject({ code: expected, retryable: true });
    }
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.02-CORE-01] indexing failures do not block later chat work', async () => {
    const chats = [
      ['chat-a', { viewId: transcriptViewId('view-a'), rows: [row(1, 'a', 'view-a')] }],
      ['chat-b', { viewId: transcriptViewId('view-b'), rows: [row(1, 'b', 'view-b')] }],
    ];
    const states = chats.map(([chatId, chat]) => ({
      chatId,
      transcriptViewId: chat.viewId,
      status: 'indexed',
      indexedThrough: 1,
      targetThrough: 1,
      lastErrorCode: null,
    }));
    const fixture = harness({ chats, states });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;
    fixture.service.syncChat.mockRejectedValueOnce(new Error('SEARCH_ROW_TOO_LARGE'));

    const a2 = row(2, 'a2', 'view-a');
    const a3 = row(3, 'a3', 'view-a');
    const b2 = row(2, 'b2', 'view-b');
    chats[0][1].rows.push(a2, a3);
    chats[1][1].rows.push(b2);
    fixture.listener({ type: 'rows', chatId: 'chat-a', viewId: transcriptViewId('view-a'), rows: [a2] });
    fixture.listener({ type: 'rows', chatId: 'chat-a', viewId: transcriptViewId('view-a'), rows: [a3] });
    fixture.listener({ type: 'rows', chatId: 'chat-b', viewId: transcriptViewId('view-b'), rows: [b2] });

    await waitFor(() => fixture.service.syncChat.mock.calls.length === 3);
    await waitFor(() => fixture.logger.warn.mock.calls.length === 1);
    expect(fixture.service.syncChat.mock.calls.map(([request]) => [request.chatId, request.targetThrough]))
      .toEqual([['chat-a', 2], ['chat-b', 2], ['chat-a', 3]]);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      'Transcript search indexing job failed',
      { chatId: 'chat-a', operation: 'append', code: 'SEARCH_ROW_TOO_LARGE' },
    );
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.04-CORE-01] sequential appends remain linear in appended rows', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      status: 'indexed',
      indexedThrough: 2,
      targetThrough: 2,
      lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;
    fixture.ledger.replayRows.mockClear();
    const appendCount = 250;
    for (let ordinal = 3; ordinal < 3 + appendCount; ordinal += 1) {
      const appended = row(ordinal, `suffix-${ordinal}`);
      fixture.chats.get('chat-0001').rows.push(appended);
      fixture.listener({
        type: 'rows',
        chatId: 'chat-0001',
        viewId: transcriptViewId('view-0001'),
        rows: [appended],
      });
    }
    await waitFor(() => fixture.service.syncChat.mock.calls.length === appendCount);
    await waitFor(() => fixture.syncCalls.length === appendCount);
    expect(fixture.ledger.replayRows).not.toHaveBeenCalled();
    expect(fixture.syncCalls.reduce((total, call) => (
      total + call.frames.reduce((frameTotal, frame) => frameTotal + frame.rows.length, 0)
    ), 0)).toBe(appendCount);
    expect(fixture.service.syncChat.mock.calls.at(-1)[0]).toMatchObject({
      expectedAfterOrdinal: appendCount + 1,
      targetThrough: appendCount + 2,
    });
    await fixture.controller.close();
  });
});
