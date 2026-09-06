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
  const unadoptedChatIds = new Set(options.unadoptedChatIds ?? []);
  let listener = () => {};
  const replayCalls = [];
  const readCurrentView = (chatId) => {
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
  };
  const ledger = {
    existingCurrentView: mock((chatId) => {
      if (options.existingCurrentView) return options.existingCurrentView(chatId, chats);
      return unadoptedChatIds.has(chatId) ? null : readCurrentView(chatId);
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
    setCatalogChatTotal: mock(() => {}),
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
    search: mock(async (request) => ({
      mode: request.mode,
      snippetLimit: request.snippetLimit,
      results: [],
      page: { offset: 0, limit: 20, total: 0, hasMore: false, nextOffset: null },
      index: {
        indexedChatCount: 0,
        pendingChatCount: 0,
        failedChatCount: 0,
        unindexedChatCount: 0,
        unsupportedChatCount: 0,
        resultsTruncated: false,
      },
    })),
    status: mock(() => ({
      version: 1,
      phase: 'ready',
      chats: { total: 0, indexed: 0, pending: 0, failed: 0, unindexed: 0 },
      queuedJobs: 0,
      resync: null,
      backlogRows: 0,
      activeChat: null,
      lastErrorCode: null,
      updatedAt: new Date(0).toISOString(),
    })),
    queryStats: mock(() => ({
      served: 0, timedOut: 0, rejectedBusy: 0, p50Ms: 0, p95Ms: 0, maxMs: 0,
      admissionP50Ms: 0, admissionP95Ms: 0, admissionMaxMs: 0,
      totalP50Ms: 0, totalP95Ms: 0, totalMaxMs: 0,
    })),
    onStatusChanged: mock(() => () => {}),
    resyncHandler: null,
  };
  const logger = { warn: mock(() => {}), info: mock(() => {}) };
  const adoption = {
    ensure: mock(async (chatId, signal) => {
      if (options.adoptionEnsure) {
        return options.adoptionEnsure(chatId, signal, { chats, unadoptedChatIds });
      }
      unadoptedChatIds.delete(chatId);
      const view = readCurrentView(chatId);
      if (!view) throw new Error('TRANSCRIPT_UNAVAILABLE');
      return view;
    }),
  };
  const controller = new TranscriptSearchController({
    listChatIds: options.listChatIds ?? (() => [...chats.keys()]),
    hasChat: options.hasChat ?? ((chatId) => (
      options.listChatIds ? options.listChatIds().includes(chatId) : chats.has(chatId)
    )),
    ledger,
    adoption,
    service,
    logger,
    searchTimeoutMs: 100,
  });
  return {
    chats,
    controller,
    adoption,
    ledger,
    listener: (event) => listener(event),
    logger,
    replayCalls,
    resyncScopes,
    service,
    syncCalls,
    unadoptedChatIds,
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
    fixture.ledger.existingCurrentView.mockClear();
    fixture.ledger.highWatermark.mockClear();

    await fixture.controller.search({ query: 'alpha', allowedChatIds: ['chat-0001'] });
    await fixture.controller.search({ query: 'bravo', allowedChatIds: ['chat-0001'] });

    expect(fixture.ledger.existingCurrentView).not.toHaveBeenCalled();
    expect(fixture.ledger.highWatermark).not.toHaveBeenCalled();
    expect(fixture.service.search.mock.calls.map(([request]) => request.allowedChats)).toEqual([
      [{ chatId: 'chat-0001', transcriptViewId: 'view-0001', throughOrdinal: 2 }],
      [{ chatId: 'chat-0001', transcriptViewId: 'view-0001', throughOrdinal: 2 }],
    ]);
    await fixture.controller.close();
  });

  test('maps public sort and paging while preserving a worker cursor after stale-view filtering', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.search.mockResolvedValueOnce({
      mode: 'page',
      snippetLimit: 3,
      results: [{
        chatId: 'chat-0001', transcriptViewId: 'stale-view', score: 1,
        matchedMessageCount: 1, snippets: [],
      }],
      page: { offset: 50, limit: 50, total: 80, hasMore: true, nextOffset: 75 },
      index: {
        indexedChatCount: 1, pendingChatCount: 0, failedChatCount: 0,
        unindexedChatCount: 0, unsupportedChatCount: 0, resultsTruncated: false,
      },
    });
    const callerAbort = new AbortController();

    const result = await fixture.controller.search({
      query: 'alpha',
      allowedChatIds: ['chat-0001'],
      sort: 'activity',
      offset: 50,
      limit: 50,
      signal: callerAbort.signal,
    });

    expect(fixture.service.search.mock.calls.at(-1)[0]).toMatchObject({
      order: 'allowlist',
      mode: 'page',
      offset: 50,
      limit: 50,
      snippetLimit: 3,
      admissionSignal: callerAbort.signal,
      executionSignal: expect.any(AbortSignal),
    });
    expect(result.results).toEqual([]);
    expect(result.page).toEqual({
      offset: 50, limit: 50, total: 80, hasMore: true, nextOffset: 75,
    });

    await fixture.controller.search({
      query: 'alpha', allowedChatIds: ['chat-0001'], sort: 'relevance', offset: 0,
    });
    expect(fixture.service.search.mock.calls.at(-1)[0].order).toBe('relevance');
    await fixture.controller.search({
      query: 'alpha', allowedChatIds: ['chat-0001'], sort: 'created', offset: 0,
    });
    expect(fixture.service.search.mock.calls.at(-1)[0].order).toBe('allowlist');
    await fixture.controller.search({
      query: 'alpha',
      allowedChatIds: ['chat-0001'],
      sort: 'relevance',
      mode: 'prefix',
      offset: 0,
      limit: 500,
      snippetLimit: 1,
    });
    expect(fixture.service.search.mock.calls.at(-1)[0]).toMatchObject({
      order: 'relevance',
      mode: 'prefix',
      offset: 0,
      limit: 500,
      snippetLimit: 1,
    });
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.11-CORE-01] adopts every uninitialized registry chat sequentially and exposes incomplete coverage', async () => {
    const chats = Array.from({ length: 24 }, (_, index) => {
      const chatId = `legacy-${index}`;
      const viewId = transcriptViewId(`legacy-view-${index}`);
      return [chatId, { viewId, rows: [row(1, `legacy marker ${index}`, viewId)] }];
    });
    const chatIds = chats.map(([chatId]) => chatId);
    const firstAdoption = deferred();
    let activeAdoptions = 0;
    let maximumActiveAdoptions = 0;
    let fixture;
    fixture = harness({
      chats,
      unadoptedChatIds: chatIds,
      adoptionEnsure: async (chatId, signal, state) => {
        activeAdoptions += 1;
        maximumActiveAdoptions = Math.max(maximumActiveAdoptions, activeAdoptions);
        try {
          if (fixture.adoption.ensure.mock.calls.length === 1) await firstAdoption.promise;
          signal.throwIfAborted();
          state.unadoptedChatIds.delete(chatId);
          fixture.controller.catalogMayHaveChanged(chatId);
          return {
            viewId: state.chats.get(chatId).viewId,
            status: 'current',
            createdAt: '2026-01-01T00:00:00.000Z',
            contentStartOrdinal: 1,
          };
        } finally {
          activeAdoptions -= 1;
        }
      },
    });
    await fixture.controller.start();
    await waitFor(() => fixture.adoption.ensure.mock.calls.length === 1);
    const probeCount = fixture.ledger.existingCurrentView.mock.calls.length;

    const during = await fixture.controller.search({ query: 'legacy', allowedChatIds: chatIds });
    expect(during.index).toMatchObject({
      indexedChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: chatIds.length,
    });
    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toEqual([]);
    await fixture.controller.search({ query: 'legacy', allowedChatIds: chatIds });
    expect(fixture.ledger.existingCurrentView).toHaveBeenCalledTimes(probeCount);

    firstAdoption.resolve();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1, 5_000);
    expect(fixture.adoption.ensure).toHaveBeenCalledTimes(chatIds.length);
    expect(maximumActiveAdoptions).toBe(1);
    expect(fixture.service.syncChat).toHaveBeenCalledTimes(chatIds.length);

    const after = await fixture.controller.search({ query: 'legacy', allowedChatIds: chatIds });
    expect(after.index.unindexedChatCount).toBe(0);
    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toHaveLength(chatIds.length);
    await fixture.controller.close();
  });

  test('[TLV5-SEARCH.11-CORE-02] keeps adoption failures visible without re-probing and repairs after later adoption', async () => {
    let failAdoption = true;
    const fixture = harness({
      unadoptedChatIds: ['chat-0001'],
      adoptionEnsure: async (chatId, _signal, state) => {
        if (failAdoption) {
          throw Object.assign(new Error('legacy source is unavailable'), {
            code: 'TRANSCRIPT_UNAVAILABLE',
          });
        }
        state.unadoptedChatIds.delete(chatId);
        return {
          viewId: state.chats.get(chatId).viewId,
          status: 'current',
          createdAt: '2026-01-01T00:00:00.000Z',
          contentStartOrdinal: 1,
        };
      },
    });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.service.markChatUnavailable).toHaveBeenCalledWith(
      'chat-0001', 'ledger-unadopted', 'TRANSCRIPT_UNAVAILABLE',
    );
    const probeCount = fixture.ledger.existingCurrentView.mock.calls.length;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fixture.controller.search({
        query: 'alpha',
        allowedChatIds: ['chat-0001'],
      });
      expect(result.index).toMatchObject({ failedChatCount: 1, unindexedChatCount: 0 });
    }
    expect(fixture.ledger.existingCurrentView).toHaveBeenCalledTimes(probeCount);

    failAdoption = false;
    fixture.unadoptedChatIds.delete('chat-0001');
    fixture.controller.catalogMayHaveChanged('chat-0001');
    await waitFor(() => fixture.service.syncChat.mock.calls.length === 1);
    const repaired = await fixture.controller.search({
      query: 'alpha',
      allowedChatIds: ['chat-0001'],
    });
    expect(repaired.index).toMatchObject({ failedChatCount: 0, unindexedChatCount: 0 });
    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toEqual([
      { chatId: 'chat-0001', transcriptViewId: 'view-0001', throughOrdinal: 2 },
    ]);
    await fixture.controller.close();
  });

  test('does not recreate failed search state when a chat is deleted during adoption', async () => {
    const adoption = deferred();
    const registry = new Set(['chat-0001']);
    const fixture = harness({
      unadoptedChatIds: ['chat-0001'],
      listChatIds: () => [...registry],
      adoptionEnsure: () => adoption.promise,
    });
    await fixture.controller.start();
    await waitFor(() => fixture.adoption.ensure.mock.calls.length === 1);

    registry.delete('chat-0001');
    fixture.controller.deleteChat('chat-0001');
    adoption.reject(Object.assign(new Error('Cannot adopt transcript for unknown chat'), {
      code: 'CHAT_NOT_FOUND',
    }));

    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    await waitFor(() => fixture.service.deleteChat.mock.calls.length === 1);
    expect(fixture.service.markChatUnavailable).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalledWith(
      'Transcript search indexing job failed',
      expect.objectContaining({ chatId: 'chat-0001' }),
    );
    await fixture.controller.close();
  });

  test('does not start maintenance adoption after a chat leaves the registry', async () => {
    const firstAdoption = deferred();
    const registry = new Set(['chat-a', 'chat-b']);
    const chats = [
      ['chat-a', { viewId: transcriptViewId('view-a'), rows: [row(1, 'a', 'view-a')] }],
      ['chat-b', { viewId: transcriptViewId('view-b'), rows: [row(1, 'b', 'view-b')] }],
    ];
    const fixture = harness({
      chats,
      unadoptedChatIds: ['chat-a', 'chat-b'],
      listChatIds: () => [...registry],
      adoptionEnsure: async (chatId, signal, state) => {
        if (chatId === 'chat-a') await firstAdoption.promise;
        signal.throwIfAborted();
        state.unadoptedChatIds.delete(chatId);
        return {
          viewId: state.chats.get(chatId).viewId,
          status: 'current',
          createdAt: '2026-01-01T00:00:00.000Z',
          contentStartOrdinal: 1,
        };
      },
    });
    await fixture.controller.start();
    await waitFor(() => fixture.adoption.ensure.mock.calls.length === 1);

    registry.delete('chat-b');
    fixture.controller.deleteChat('chat-b');
    firstAdoption.resolve();

    await waitFor(() => fixture.resyncScopes[0]?.completed === 1, 5_000);
    expect(fixture.adoption.ensure.mock.calls.map(([chatId]) => chatId)).toEqual(['chat-a']);
    await fixture.controller.close();
  });

  test('serializes adoption across startup resync and catalog refresh maintenance', async () => {
    const chats = [
      ['chat-a', { viewId: transcriptViewId('view-a'), rows: [row(1, 'a', 'view-a')] }],
      ['chat-b', { viewId: transcriptViewId('view-b'), rows: [row(1, 'b', 'view-b')] }],
    ];
    const firstAdoption = deferred();
    let activeAdoptions = 0;
    let maximumActiveAdoptions = 0;
    const fixture = harness({
      chats,
      unadoptedChatIds: ['chat-a', 'chat-b'],
      adoptionEnsure: async (chatId, signal, state) => {
        activeAdoptions += 1;
        maximumActiveAdoptions = Math.max(maximumActiveAdoptions, activeAdoptions);
        try {
          if (chatId === 'chat-a') await firstAdoption.promise;
          signal.throwIfAborted();
          state.unadoptedChatIds.delete(chatId);
          return {
            viewId: state.chats.get(chatId).viewId,
            status: 'current',
            createdAt: '2026-01-01T00:00:00.000Z',
            contentStartOrdinal: 1,
          };
        } finally {
          activeAdoptions -= 1;
        }
      },
    });
    await fixture.controller.start();
    await waitFor(() => fixture.adoption.ensure.mock.calls.length === 1);

    fixture.controller.catalogMayHaveChanged('chat-b');
    for (let attempt = 0; attempt < 5; attempt += 1) await Bun.sleep(0);
    firstAdoption.resolve();

    await waitFor(() => fixture.resyncScopes[0]?.completed === 1, 5_000);
    await waitFor(() => fixture.adoption.ensure.mock.calls.length >= 2, 5_000);
    expect(maximumActiveAdoptions).toBe(1);
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

  test('does not read a watermark after the chat leaves during its view probe', async () => {
    const registry = new Set(['chat-0001']);
    const fixture = harness({
      listChatIds: () => [...registry],
      hasChat: (chatId) => registry.has(chatId),
      existingCurrentView(chatId, chats) {
        const chat = chats.get(chatId);
        registry.delete(chatId);
        return {
          viewId: chat.viewId,
          status: 'current',
          createdAt: '2026-01-01T00:00:00.000Z',
          contentStartOrdinal: 1,
        };
      },
    });

    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);

    expect(fixture.ledger.highWatermark).not.toHaveBeenCalled();
    expect(fixture.service.syncChat).not.toHaveBeenCalled();
    expect(fixture.service.markChatUnavailable).not.toHaveBeenCalled();
    await fixture.controller.close();
  });

  test('stops paged ledger reads when the chat is deleted between pulls', async () => {
    const registry = new Set(['chat-0001']);
    const firstPageRead = deferred();
    const releaseNextPull = deferred();
    const rows = Array.from({ length: 700 }, (_, index) => row(index + 1, `body-${index}`));
    const fixture = harness({
      chats: [['chat-0001', { viewId: transcriptViewId('view-0001'), rows }]],
      listChatIds: () => [...registry],
      hasChat: (chatId) => registry.has(chatId),
      async syncChat(request, frames) {
        const source = request.source(request.expectedAfterOrdinal);
        const first = await source.next();
        if (!first.done) frames.push(first.value);
        firstPageRead.resolve();
        await releaseNextPull.promise;
        const second = await source.next();
        if (!second.done) frames.push(second.value);
      },
    });
    await fixture.controller.start();
    await firstPageRead.promise;
    expect(fixture.ledger.replayRows).toHaveBeenCalledTimes(1);

    registry.delete('chat-0001');
    fixture.controller.deleteChat('chat-0001');
    releaseNextPull.resolve();
    await waitFor(() => fixture.service.deleteChat.mock.calls.length === 1);

    expect(fixture.ledger.replayRows).toHaveBeenCalledTimes(1);
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
    fixture.ledger.existingCurrentView.mockClear();
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

  test('ignores commits after a chat leaves the registry', async () => {
    const registry = new Set(['chat-0001']);
    const fixture = harness({ listChatIds: () => [...registry] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;

    registry.delete('chat-0001');
    fixture.listener({
      type: 'rows',
      chatId: 'chat-0001',
      viewId: transcriptViewId('view-0001'),
      rows: [row(3, 'late suffix')],
    });
    await Bun.sleep(10);

    expect(fixture.service.syncChat).not.toHaveBeenCalled();
    const result = await fixture.controller.search({
      query: 'late',
      allowedChatIds: ['chat-0001'],
    });
    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toEqual([]);
    expect(result.index.unindexedChatCount).toBe(1);
    await fixture.controller.close();
  });

  test('a post-deletion commit cannot resurrect the search snapshot', async () => {
    const registry = new Set(['chat-0001']);
    const fixture = harness({ listChatIds: () => [...registry] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);

    registry.delete('chat-0001');
    fixture.controller.deleteChat('chat-0001');
    fixture.listener({
      type: 'rows',
      chatId: 'chat-0001',
      viewId: transcriptViewId('view-0001'),
      rows: [row(3, 'late suffix')],
    });
    await fixture.controller.search({ query: 'late', allowedChatIds: ['chat-0001'] });

    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toEqual([]);
    await fixture.controller.close();
  });

  test('validateResultView rejects a deleted chat without a ledger read', async () => {
    const registry = new Set(['chat-0001']);
    const fixture = harness({ listChatIds: () => [...registry] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.ledger.existingCurrentView.mockClear();

    registry.delete('chat-0001');
    expect(fixture.controller.validateResultView('chat-0001', 'view-0001')).toBe(false);
    expect(fixture.ledger.existingCurrentView).not.toHaveBeenCalled();
    await fixture.controller.close();
  });

  test('does not resync a deferred append fallback after deletion', async () => {
    const registry = new Set(['chat-0001']);
    const appendStarted = deferred();
    const releaseAppend = deferred();
    let blockAppend = false;
    const fixture = harness({
      listChatIds: () => [...registry],
      hasChat: (chatId) => registry.has(chatId),
      async syncChat(request, frames) {
        if (blockAppend && request.mode === 'append') {
          appendStarted.resolve();
          await releaseAppend.promise;
          throw new Error('SEARCH_INDEX_GAP');
        }
        for await (const frame of request.source(request.expectedAfterOrdinal)) frames.push(frame);
      },
    });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.ledger.existingCurrentView.mockClear();
    fixture.service.syncChat.mockClear();
    fixture.syncCalls.length = 0;

    blockAppend = true;
    fixture.listener({
      type: 'rows',
      chatId: 'chat-0001',
      viewId: transcriptViewId('view-0001'),
      rows: [row(3, 'late suffix')],
    });
    await appendStarted.promise;
    registry.delete('chat-0001');
    fixture.controller.deleteChat('chat-0001');
    releaseAppend.resolve();
    await waitFor(() => fixture.service.deleteChat.mock.calls.length === 1);

    expect(fixture.ledger.existingCurrentView).not.toHaveBeenCalled();
    expect(fixture.service.syncChat).toHaveBeenCalledTimes(1);
    const result = await fixture.controller.search({
      query: 'late',
      allowedChatIds: ['chat-0001'],
    });
    expect(fixture.service.search.mock.calls.at(-1)[0].allowedChats).toEqual([]);
    expect(result.index.unindexedChatCount).toBe(1);
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

  test('reindexes a catalog chat after a transient ledger fence clears', async () => {
    const fencedChats = new Set();
    const fixture = harness({ fencedChats });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    expect(fixture.service.syncChat).toHaveBeenCalledTimes(1);

    fencedChats.add('chat-0001');
    fixture.controller.catalogMayHaveChanged('chat-0001');
    await waitFor(() => fixture.service.markChatUnavailable.mock.calls.length === 1);

    fencedChats.delete('chat-0001');
    fixture.controller.catalogMayHaveChanged('chat-0001');
    await waitFor(() => fixture.service.syncChat.mock.calls.length === 2);
    await fixture.controller.close();

    expect(fixture.service.syncChat).toHaveBeenCalledTimes(2);
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
      .toEqual(['chat-index-only']);
    expect(fixture.service.markChatUnavailable).toHaveBeenCalledWith(
      'chat-no-view', 'ledger-unadopted', 'TRANSCRIPT_UNAVAILABLE',
    );
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
    await waitFor(() => midScope.resyncScopes[0]?.completed === 1);
    expect(midScope.resyncScopes[0]).toEqual({
      total: 2, settled: 2, completed: 1, failures: [],
    });
    expect(midScope.service.markChatUnavailable).toHaveBeenCalledWith(
      'chat-bad', 'ledger-unadopted', 'SEARCH_INDEX_UNAVAILABLE',
    );
    expect(midScope.logger.warn).toHaveBeenCalledWith(
      'Transcript search indexing job failed',
      { chatId: 'chat-bad', operation: 'resync', code: 'SEARCH_INDEX_UNAVAILABLE' },
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

  test('preserves caller cancellation without warning', async () => {
    const fixture = harness({ states: [{
      chatId: 'chat-0001', transcriptViewId: 'view-0001', status: 'indexed',
      indexedThrough: 2, targetThrough: 2, lastErrorCode: null,
    }] });
    await fixture.controller.start();
    await waitFor(() => fixture.resyncScopes[0]?.completed === 1);
    fixture.logger.warn.mockClear();
    const callerAbort = new AbortController();
    callerAbort.abort();

    await expect(fixture.controller.search({
      query: 'alpha', allowedChatIds: ['chat-0001'], signal: callerAbort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fixture.service.search).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalled();
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
