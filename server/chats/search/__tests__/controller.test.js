import { describe, expect, it, mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { UserMessage, AssistantMessage } from '../../../../common/chat-types.js';
import { LedgerFencedError } from '../../../ledger/errors.js';
import { TranscriptSearchController } from '../controller.js';

function userRow(viewId, ordinal, content) {
  const message = new UserMessage('2026-08-10T10:00:00.000Z', content);
  return {
    kind: 'user-input',
    viewId,
    ordinal,
    at: message.timestamp,
    detail: { clientMessageId: `message-${ordinal}`, message, attachments: [], steer: false },
    providerMeta: null,
  };
}

function providerRow(viewId, ordinal, content) {
  const message = new AssistantMessage('2026-08-10T10:00:01.000Z', content);
  return {
    kind: 'provider-row',
    viewId,
    ordinal,
    at: message.timestamp,
    message,
    providerMeta: null,
  };
}

function harness() {
  const views = new Map([['chat-1', { viewId: 'view-1', contentStartOrdinal: 1 }]]);
  const rows = new Map([['chat-1', [
    userRow('view-1', 1, 'hello'),
    providerRow('view-1', 2, 'world'),
  ]] ]);
  let listener = null;
  const service = {
    setResyncHandler: mock(() => undefined),
    enable: mock(async () => undefined),
    replaceChat: mock(async () => undefined),
    appendRows: mock(async () => undefined),
    deleteChat: mock(async () => undefined),
    pruneChats: mock(async () => undefined),
    search: mock(async ({ allowedChats }) => ({
      results: allowedChats.map(({ chatId, transcriptViewId }) => ({
        chatId,
        transcriptViewId,
        score: 1,
        matchedMessageCount: 1,
        snippets: [],
      })),
      index: {
        indexedChatCount: allowedChats.length,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    })),
    disableAndDelete: mock(async () => undefined),
    close: mock(async () => undefined),
  };
  const ledger = {
    currentView: mock((chatId) => views.get(chatId) ?? null),
    currentRows: mock((chatId) => rows.get(chatId) ?? []),
    subscribe: mock((candidate) => {
      listener = candidate;
      return () => { listener = null; };
    }),
  };
  const logger = { warn: mock(() => undefined) };
  const controller = new TranscriptSearchController({
    listChatIds: () => [...views.keys()],
    ledger,
    service,
    logger,
  });
  return { controller, ledger, listener: () => listener, logger, rows, service, views };
}

async function settle() {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('TranscriptSearchController', () => {
  it('indexes each current ledger view when enabled', async () => {
    const test = harness();

    await test.controller.initialize(true);

    expect(test.service.replaceChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 2,
      rows: [
        expect.objectContaining({ ordinal: 1, role: 'user', body: 'hello' }),
        expect.objectContaining({ ordinal: 2, role: 'assistant', body: 'world' }),
      ],
    });
    expect(test.service.pruneChats).toHaveBeenCalledWith(['chat-1']);
  });

  it('indexes only the committed suffix during normal appends', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.service.appendRows.mockClear();
    const row = providerRow('view-1', 3, 'later');
    test.rows.get('chat-1').push(row);

    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [row] });
    await settle();

    expect(test.service.appendRows).toHaveBeenCalledWith({
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      expectedAfterOrdinal: 2,
      throughOrdinal: 3,
      rows: [expect.objectContaining({ ordinal: 3, body: 'later' })],
    });
  });

  it('indexes repeated ordinary commits only as ordered suffixes', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.service.appendRows.mockClear();
    test.service.replaceChat.mockClear();

    for (let ordinal = 3; ordinal <= 5; ordinal += 1) {
      const row = providerRow('view-1', ordinal, `suffix-${ordinal}`);
      test.rows.get('chat-1').push(row);
      test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [row] });
    }
    await settle();

    expect(test.service.appendRows.mock.calls.map(([input]) => ({
      expectedAfterOrdinal: input.expectedAfterOrdinal,
      throughOrdinal: input.throughOrdinal,
      body: input.rows[0]?.body,
    }))).toEqual([
      { expectedAfterOrdinal: 2, throughOrdinal: 3, body: 'suffix-3' },
      { expectedAfterOrdinal: 3, throughOrdinal: 4, body: 'suffix-4' },
      { expectedAfterOrdinal: 4, throughOrdinal: 5, body: 'suffix-5' },
    ]);
    expect(test.service.replaceChat).not.toHaveBeenCalled();
  });

  it('keeps long append series linear without rereading the transcript', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.ledger.currentRows.mockClear();
    test.service.appendRows.mockClear();
    test.service.replaceChat.mockClear();
    const appendCount = 2_000;

    for (let ordinal = 3; ordinal < 3 + appendCount; ordinal += 1) {
      const row = providerRow('view-1', ordinal, `linear-suffix-${ordinal}`);
      test.rows.get('chat-1').push(row);
      test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [row] });
    }
    await settle();

    expect(test.ledger.currentRows).not.toHaveBeenCalled();
    expect(test.service.replaceChat).not.toHaveBeenCalled();
    expect(test.service.appendRows).toHaveBeenCalledTimes(appendCount);
    expect(test.service.appendRows.mock.calls.every(([input]) => input.rows.length === 1)).toBe(true);
    expect(test.service.appendRows.mock.calls.at(-1)?.[0]).toMatchObject({
      expectedAfterOrdinal: appendCount + 1,
      throughOrdinal: appendCount + 2,
      rows: [expect.objectContaining({ body: `linear-suffix-${appendCount + 2}` })],
    });
  });

  it('resyncs a watermark gap without converting ordinary worker failures into replacements', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.service.appendRows.mockClear();
    test.service.replaceChat.mockClear();

    const gapRow = providerRow('view-1', 3, 'gap');
    test.rows.get('chat-1').push(gapRow);
    test.service.appendRows.mockRejectedValueOnce(new Error('SEARCH_INDEX_GAP'));
    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [gapRow] });
    await settle();

    expect(test.service.replaceChat).toHaveBeenCalledTimes(1);
    test.service.replaceChat.mockClear();

    const failedRow = providerRow('view-1', 4, 'worker-failure');
    const continuedRow = providerRow('view-1', 5, 'continued');
    test.rows.get('chat-1').push(failedRow, continuedRow);
    test.service.appendRows.mockRejectedValueOnce(new Error('disk unavailable'));
    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [failedRow] });
    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [continuedRow] });
    await settle();

    expect(test.service.replaceChat).not.toHaveBeenCalled();
    expect(test.service.appendRows).toHaveBeenCalledWith(expect.objectContaining({
      expectedAfterOrdinal: 4,
      throughOrdinal: 5,
    }));
    expect(test.logger.warn).toHaveBeenCalledWith('Transcript search indexing job failed', {
      chatId: 'chat-1',
      operation: 'append',
      code: 'SEARCH_INDEX_UNAVAILABLE',
    });
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain('disk unavailable');
  });

  it('does not rebuild a whole chat after its committed suffix is already queued', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.service.appendRows.mockClear();
    test.service.replaceChat.mockClear();
    const row = providerRow('view-1', 3, 'later');
    test.rows.get('chat-1').push(row);

    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [row] });
    test.controller.catalogMayHaveChanged('chat-1');
    await settle();

    expect(test.service.appendRows).toHaveBeenCalledTimes(1);
    expect(test.service.replaceChat).not.toHaveBeenCalled();
  });

  it('absorbs a rejected indexing job and continues same-chat and cross-chat queues', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/rejected-index-job.ts', import.meta.url));
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('replaces old-view entries before accepting new-view navigation', async () => {
    const test = harness();
    await test.controller.initialize(true);
    test.service.replaceChat.mockClear();
    test.views.set('chat-1', { viewId: 'view-2', contentStartOrdinal: 1 });
    test.rows.set('chat-1', [userRow('view-2', 1, 'reloaded')]);

    test.listener()({
      type: 'view-replaced',
      chatId: 'chat-1',
      previousViewId: 'view-1',
      view: test.views.get('chat-1'),
    });
    await settle();

    expect(test.controller.validateResultView('chat-1', 'view-1')).toBe(false);
    expect(test.controller.validateResultView('chat-1', 'view-2')).toBe(true);
    expect(test.service.replaceChat).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'chat-1',
      transcriptViewId: 'view-2',
    }));
  });

  it('orders replacement after every already-queued old-view append', async () => {
    const test = harness();
    await test.controller.initialize(true);
    const append = deferred();
    const order = [];
    test.service.appendRows.mockImplementation(async () => {
      order.push('append-start');
      await append.promise;
      order.push('append-end');
    });
    test.service.replaceChat.mockImplementation(async () => {
      order.push('replace');
    });
    test.service.replaceChat.mockClear();
    const oldRow = providerRow('view-1', 3, 'old tail');

    test.listener()({ type: 'rows', chatId: 'chat-1', viewId: 'view-1', rows: [oldRow] });
    await settle();
    test.views.set('chat-1', { viewId: 'view-2', contentStartOrdinal: 1 });
    test.rows.set('chat-1', [userRow('view-2', 1, 'reloaded')]);
    test.listener()({
      type: 'view-replaced',
      chatId: 'chat-1',
      previousViewId: 'view-1',
      view: test.views.get('chat-1'),
    });

    expect(order).toEqual(['append-start']);
    append.resolve();
    await settle();
    expect(order).toEqual(['append-start', 'append-end', 'replace']);
  });

  it('qualifies searches by each current transcript view', async () => {
    const test = harness();
    await test.controller.initialize(true);

    const result = await test.controller.search({
      query: 'hello',
      allowedChatIds: ['chat-1', 'missing'],
    });

    expect(test.service.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1' }],
    }));
    expect(result.results).toEqual([
      expect.objectContaining({ chatId: 'chat-1', transcriptViewId: 'view-1' }),
    ]);
  });

  it('does not admit an old-view result when the transcript is replaced during the query', async () => {
    const test = harness();
    await test.controller.initialize(true);
    const pending = deferred();
    test.service.search.mockImplementation(() => pending.promise);

    const result = test.controller.search({
      query: 'hello',
      allowedChatIds: ['chat-1'],
    });
    await settle();
    test.views.set('chat-1', { viewId: 'view-2', contentStartOrdinal: 1 });
    pending.resolve({
      results: [{
        chatId: 'chat-1',
        transcriptViewId: 'view-1',
        score: 1,
        matchedMessageCount: 1,
        snippets: [],
      }],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    });

    expect((await result).results).toEqual([]);
  });

  it('keeps healthy chats searchable when another ledger is fenced', async () => {
    const test = harness();
    test.views.set('chat-fenced', { viewId: 'view-fenced', contentStartOrdinal: 1 });
    test.rows.set('chat-fenced', [userRow('view-fenced', 1, 'unavailable')]);
    test.ledger.currentView.mockImplementation((chatId) => {
      if (chatId === 'chat-fenced') throw new LedgerFencedError(chatId);
      return test.views.get(chatId) ?? null;
    });

    await test.controller.initialize(true);
    const result = await test.controller.search({
      query: 'hello',
      allowedChatIds: ['chat-1', 'chat-fenced'],
    });

    expect(test.service.replaceChat).toHaveBeenCalledTimes(1);
    expect(test.service.deleteChat).toHaveBeenCalledWith('chat-fenced');
    expect(test.service.pruneChats).toHaveBeenCalledWith(['chat-1', 'chat-fenced']);
    expect(test.service.search).toHaveBeenCalledWith(expect.objectContaining({
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1' }],
    }));
    expect(result.results).toEqual([
      expect.objectContaining({ chatId: 'chat-1', transcriptViewId: 'view-1' }),
    ]);
    expect(result.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 1,
      unsupportedChatCount: 0,
    });
    expect(test.controller.validateResultView('chat-fenced', 'view-fenced')).toBe(false);
  });
});
