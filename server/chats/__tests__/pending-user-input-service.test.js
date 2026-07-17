import { describe, expect, it, mock } from 'bun:test';
import { PendingUserInputService } from '../pending-user-input-service.js';
import { ChatViewStore } from '../chat-view-store.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { transcriptRevision } from '../../lib/transcript-revision.js';

function createReader() {
  return {
    ensureLoaded: mock(() => Promise.resolve([])),
    getMessages: mock(() => []),
    getRetainedHistoryMessages: mock(() => []),
  };
}

describe('PendingUserInputService', () => {
  it('discards a chat without emitting clear events', async () => {
    const service = new PendingUserInputService(createReader());
    const cleared = [];
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'hello', { clientRequestId: 'req-1' });

    expect(service.listForChat('chat-1')).toHaveLength(1);
    expect(service.discardChat('chat-1')).toBe(1);
    expect(service.listForChat('chat-1')).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('discards one input without emitting a clear event', async () => {
    const service = new PendingUserInputService(createReader());
    const cleared = [];
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'first', { clientRequestId: 'req-1' });
    await service.register('chat-1', 'second', { clientRequestId: 'req-2' });

    expect(service.discard('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1').map((input) => input.clientRequestId)).toEqual(['req-2']);
    expect(cleared).toEqual([]);
  });

  it('marks one input failed without clearing the overlay', async () => {
    const service = new PendingUserInputService(createReader());
    const updated = [];
    const cleared = [];
    service.store.onUpdated((input) => {
      updated.push(input);
    });
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'first', { clientRequestId: 'req-1' });

    expect(service.markFailed('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    }]);
    expect(updated.at(-1)).toMatchObject({
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    });
    expect(cleared).toEqual([]);
  });

  it('reconciles from the returned full transcript when the retained cache is capped', async () => {
    const history = Array.from({ length: 20_000 }, () => (
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history')
    ));
    history.unshift(new UserMessage(
      '2026-06-01T00:00:00.000Z',
      'persisted',
      undefined,
      { clientRequestId: 'req-1' },
    ));
    const reader = {
      ensureLoaded: mock(async () => history),
      getMessages: mock(() => null),
      getRetainedHistoryMessages: mock(() => null),
    };
    const service = new PendingUserInputService(reader);

    await service.register('chat-1', 'persisted', { clientRequestId: 'req-1' });
    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(reader.ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it('reconciles a nearby identityless native echo after the live view is replaced', async () => {
    let messages = [];
    const reader = {
      ensureLoaded: mock(async () => messages),
      getMessages: mock(() => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.125Z', 'persisted')];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('does not reuse an older identical echo for a later pending input', async () => {
    let messages = [];
    const reader = {
      ensureLoaded: mock(async () => messages),
      getMessages: mock(() => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.100Z', 'repeat')];
    await service.reconcile('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);

    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-2',
      createdAt: '2026-06-01T00:02:00.000Z',
    });
    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-2' }]);
  });

  it('uses a retained durable echo without forcing a full transcript load', async () => {
    const retained = [new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'persisted',
      undefined,
      { clientRequestId: 'req-1' },
    )];
    const reader = {
      ensureLoaded: mock(async () => {
        throw new Error('full load should not run');
      }),
      getMessages: mock(() => null),
      getRetainedHistoryMessages: mock(() => retained),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(reader.ensureLoaded).not.toHaveBeenCalled();
  });

  it('does not reconcile an old identical native message', async () => {
    let messages = [];
    const reader = {
      ensureLoaded: mock(async () => messages),
      getMessages: mock(() => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T01:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.000Z', 'repeat')];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-1' }]);
  });

  it('does not reconcile a native message with a conflicting request identity', async () => {
    let messages = [];
    const reader = {
      ensureLoaded: mock(async () => messages),
      getMessages: mock(() => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-live',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    messages = [new UserMessage(
      '2026-06-01T00:00:00.125Z',
      'persisted',
      undefined,
      { clientRequestId: 'req-native' },
    )];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-live' }]);
  });

  it('preserves pending identity across provider timestamp differences after capped reconciliation', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-1'),
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-2'),
    ];
    let nativeMessages = history;
    const views = new ChatViewStore(() => false, { messageLimit: 2 });
    const reader = {
      ensureLoaded: (chatId) => views.getOrCreateMessages(chatId, async () => nativeMessages),
      getMessages: (chatId) => views.getLoadedMessages(chatId),
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
    const live = await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => history,
      [new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'persisted',
        undefined,
        { clientRequestId: 'req-1', turnId: 'turn-1', deliveryStatus: 'accepted' },
      )],
    );
    nativeMessages = [
      ...history,
      new UserMessage(
        '2026-06-01T00:00:00.125Z',
        'persisted',
        undefined,
        { clientRequestId: 'req-1', turnId: 'turn-1' },
      ),
    ];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(views.getCursor('chat-1')?.generationId).toBe(live.generationId);
    const retained = views.readPage('chat-1', 10);
    expect(retained.messages.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(retained.messages[1].message).toMatchObject({
      type: 'user-message',
      metadata: {
        clientRequestId: 'req-1',
        turnId: 'turn-1',
        deliveryStatus: 'accepted',
      },
    });

    const loadAll = mock(async () => nativeMessages);
    const loadPage = mock(async (limit, offset) => {
      const end = nativeMessages.length - offset;
      const start = Math.max(0, end - limit);
      return {
        messages: nativeMessages.slice(start, end),
        total: nativeMessages.length,
        hasMore: start > 0,
        offset,
        limit,
        revision: transcriptRevision(nativeMessages),
      };
    });
    const older = await views.getOrCreatePage(
      'chat-1',
      { loadAll, loadPage },
      1,
      retained.pageOldestSeq,
    );

    expect(older.generationId).toBe(live.generationId);
    expect(older.messages.map((entry) => entry.seq)).toEqual([1]);
    expect(loadPage).toHaveBeenCalledWith(1, 2);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('retains native upstream identity during capped reconciliation', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-1'),
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-2'),
    ];
    let nativeMessages = history;
    const views = new ChatViewStore(() => false, { messageLimit: 2 });
    const reader = {
      ensureLoaded: (chatId) => views.getOrCreateMessages(chatId, async () => nativeMessages),
      getMessages: (chatId) => views.getLoadedMessages(chatId),
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    });
    const live = await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => history,
      [new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'persisted',
        undefined,
        { clientRequestId: 'req-1', turnId: 'turn-1', deliveryStatus: 'accepted' },
      )],
    );
    nativeMessages = [
      ...history,
      new UserMessage(
        '2026-06-01T00:00:00.125Z',
        'persisted',
        undefined,
        { upstreamRequestId: 'upstream-1' },
      ),
    ];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(views.getCursor('chat-1')?.generationId).toBe(live.generationId);
    const retained = views.readPage('chat-1', 10);
    expect(retained.messages.at(-1)?.message).toMatchObject({
      metadata: {
        clientRequestId: 'req-1',
        upstreamRequestId: 'upstream-1',
        turnId: 'turn-1',
        deliveryStatus: 'accepted',
      },
    });

    const loadAll = mock(async () => nativeMessages);
    const loadPage = mock(async (limit, offset) => {
      const end = nativeMessages.length - offset;
      const start = Math.max(0, end - limit);
      return {
        messages: nativeMessages.slice(start, end),
        total: nativeMessages.length,
        hasMore: start > 0,
        offset,
        limit,
        revision: transcriptRevision(nativeMessages),
      };
    });
    const older = await views.getOrCreatePage(
      'chat-1',
      { loadAll, loadPage },
      1,
      retained.pageOldestSeq,
    );

    expect(older.generationId).toBe(live.generationId);
    expect(older.messages.map((entry) => entry.seq)).toEqual([1]);
    expect(loadPage).toHaveBeenCalledWith(1, 2);
    expect(loadAll).not.toHaveBeenCalled();
  });

  it('rejects conflicting native identity during capped reconciliation', async () => {
    const history = [
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-1'),
      new AssistantMessage('2026-06-01T00:00:00.000Z', 'history-2'),
    ];
    let nativeMessages = history;
    const views = new ChatViewStore(() => false, { messageLimit: 2 });
    const reader = {
      ensureLoaded: (chatId) => views.getOrCreateMessages(chatId, async () => nativeMessages),
      getMessages: (chatId) => views.getLoadedMessages(chatId),
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-live',
      turnId: 'turn-live',
    });
    const live = await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => history,
      [new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'persisted',
        undefined,
        { clientRequestId: 'req-live', turnId: 'turn-live', deliveryStatus: 'accepted' },
      )],
    );
    nativeMessages = [
      ...history,
      new UserMessage(
        '2026-06-01T00:00:00.125Z',
        'persisted',
        undefined,
        { clientRequestId: 'req-native', turnId: 'turn-native' },
      ),
    ];

    await service.reconcile('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-live', turnId: 'turn-live' },
    ]);
    expect(views.getCursor('chat-1')?.generationId).not.toBe(live.generationId);
    expect(views.readPage('chat-1', 10).messages.at(-1)?.message).toMatchObject({
      metadata: { clientRequestId: 'req-native', turnId: 'turn-native' },
    });
  });
});
