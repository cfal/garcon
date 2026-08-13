import { describe, expect, it, mock } from 'bun:test';
import { UserMessage, AssistantMessage } from '../../../../common/chat-types.js';
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
  const controller = new TranscriptSearchController({
    listChatIds: () => [...views.keys()],
    ledger,
    service,
  });
  return { controller, ledger, listener: () => listener, rows, service, views };
}

async function settle() {
  await Bun.sleep(0);
  await Bun.sleep(0);
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
});
