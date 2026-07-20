import { describe, expect, it, mock } from 'bun:test';
import { PendingUserInputService } from '../pending-user-input-service.js';
import { ChatViewStore } from '../chat-view-store.js';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { transcriptRevision } from '../../lib/transcript-revision.js';

function createReader() {
  return {
    loadNativeMessages: mock(() => Promise.resolve([])),
    getRetainedHistoryMessages: mock(() => []),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('PendingUserInputService', () => {
  it('classifies pending delivery lifecycle for chat idleness', async () => {
    const service = new PendingUserInputService(createReader());

    expect(service.hasInFlightForChat('missing-chat')).toBe(false);

    for (const [deliveryStatus, expected] of [
      ['submitting', true],
      ['accepted', true],
      ['unconfirmed', false],
      ['failed', false],
    ]) {
      const chatId = `chat-${deliveryStatus}`;
      await service.register(chatId, deliveryStatus, {
        clientRequestId: `req-${deliveryStatus}`,
        deliveryStatus,
      });
      expect(service.hasInFlightForChat(chatId)).toBe(expected);
    }

    await service.register('chat-terminal', 'unconfirmed', {
      clientRequestId: 'req-unconfirmed',
      deliveryStatus: 'unconfirmed',
    });
    await service.register('chat-terminal', 'failed', {
      clientRequestId: 'req-failed',
      deliveryStatus: 'failed',
    });
    expect(service.hasInFlightForChat('chat-terminal')).toBe(false);

    await service.register('chat-terminal', 'accepted', {
      clientRequestId: 'req-accepted',
      deliveryStatus: 'accepted',
    });
    expect(service.hasInFlightForChat('chat-terminal')).toBe(true);
  });

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
    const statusUpdated = [];
    const cleared = [];
    service.store.onUpdated((input) => {
      updated.push(input);
    });
    service.store.onStatusUpdated((chatId, clientRequestId, deliveryStatus) => {
      statusUpdated.push({ chatId, clientRequestId, deliveryStatus });
    });
    service.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });

    await service.register('chat-1', 'first', {
      clientRequestId: 'req-1',
      images: [{
        name: 'large.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${'a'.repeat(20_000)}`,
      }],
    });

    expect(service.markFailed('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    }]);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      clientRequestId: 'req-1',
      deliveryStatus: 'accepted',
    });
    expect(statusUpdated).toEqual([{
      chatId: 'chat-1',
      clientRequestId: 'req-1',
      deliveryStatus: 'failed',
    }]);
    expect(JSON.stringify(statusUpdated)).not.toContain('base64');
    expect(cleared).toEqual([]);
  });

  it('marks an accepted input unconfirmed without clearing the overlay', async () => {
    const service = new PendingUserInputService(createReader());
    await service.register('chat-1', 'possibly delivered', { clientRequestId: 'req-1' });

    expect(service.markUnconfirmed('chat-1', 'req-1')).toBe(true);
    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-1',
      deliveryStatus: 'unconfirmed',
    }]);
  });

  it('omits attachment bytes from repeatable transport snapshots', async () => {
    const service = new PendingUserInputService(createReader());
    await service.register('chat-1', 'with image', {
      clientRequestId: 'req-image',
      images: [{
        name: 'large.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${'a'.repeat(20_000)}`,
      }],
    });

    expect(service.listForChat('chat-1')[0].images).toHaveLength(1);
    expect(service.listForTransport('chat-1')[0]).not.toHaveProperty('images');
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
      loadNativeMessages: mock(async () => history),
      getRetainedHistoryMessages: mock(() => null),
    };
    const service = new PendingUserInputService(reader);

    await service.register('chat-1', 'persisted', { clientRequestId: 'req-1' });
    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(reader.loadNativeMessages).toHaveBeenCalledTimes(1);
  });

  it('reconciles a nearby identityless native echo after the live view is replaced', async () => {
    let messages = [];
    const reader = {
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.125Z', 'persisted')];

    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('does not use an earlier identityless row as persistence evidence', async () => {
    const messages = [new UserMessage('2026-06-01T00:00:00.000Z', 'repeat')];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    });
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-later',
      createdAt: '2026-06-01T00:00:10.000Z',
    });

    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-later', deliveryStatus: 'accepted' },
    ]);
  });

  it('consumes each identityless echo at most once across reconciliation calls', async () => {
    let messages = [];
    const reader = {
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.100Z', 'repeat')];
    await service.reconcileRetainedHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);

    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-2',
      createdAt: '2026-06-01T00:00:10.000Z',
    });
    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-2' }]);

    messages.push(new UserMessage('2026-06-01T00:00:10.100Z', 'repeat'));
    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('assigns ambiguous identityless evidence to the earliest pending input', async () => {
    const timestamp = '2026-06-01T00:00:00.000Z';
    const messages = [];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    });
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-a',
      createdAt: timestamp,
    });
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-b',
      createdAt: timestamp,
    });
    messages.push(new UserMessage(timestamp, 'repeat'));

    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-b', deliveryStatus: 'accepted' },
    ]);
  });

  it('conserves identityless evidence across repeated reconciliation batches', async () => {
    const baseTime = Date.parse('2026-06-01T00:00:00.000Z');
    const messages = [];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    });
    const clearedRequestIds = [];
    service.store.onCleared((_chatId, clientRequestId, reason) => {
      if (reason === 'persisted') clearedRequestIds.push(clientRequestId);
    });
    for (let index = 0; index < 12; index += 1) {
      await service.register('chat-1', 'repeat', {
        clientRequestId: `req-${index}`,
        createdAt: new Date(baseTime + index * 1_000).toISOString(),
      });
    }

    for (let index = 0; index < 5; index += 1) {
      messages.push(new UserMessage(
        new Date(baseTime + index * 1_000 + 100).toISOString(),
        'repeat',
      ));
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.reconcileRetainedHistory('chat-1');
    }

    expect(service.listForChat('chat-1')).toHaveLength(7);
    expect(clearedRequestIds).toHaveLength(5);

    for (let index = 5; index < 9; index += 1) {
      messages.push(new UserMessage(
        new Date(baseTime + index * 1_000 + 100).toISOString(),
        'repeat',
      ));
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.reconcileRetainedHistory('chat-1');
    }

    expect(service.listForChat('chat-1')).toHaveLength(3);
    expect(new Set(clearedRequestIds).size).toBe(9);
  });

  it('clears a failed input when later native evidence proves persistence', async () => {
    let messages = [];
    const reader = {
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'eventually persisted', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    service.markFailed('chat-1', 'req-1');
    messages = [new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'eventually persisted',
      undefined,
      { clientRequestId: 'req-1' },
    )];

    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('settles a stopped-turn cohort from native evidence and leaves later inputs untouched', async () => {
    let messages = [new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'persisted before stop',
      undefined,
      { clientRequestId: 'req-persisted' },
    )];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => []),
    });
    await service.register('chat-1', 'persisted before stop', {
      clientRequestId: 'req-persisted',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    const stoppedTurn = service.captureCohort('chat-1');
    await service.register('chat-1', 'not persisted before stop', {
      clientRequestId: 'req-failed',
      createdAt: '2026-06-01T00:00:01.000Z',
    });

    await service.settleNativeCohort(stoppedTurn);

    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-failed',
      deliveryStatus: 'accepted',
    }]);

    messages = [...messages, new UserMessage(
      '2026-06-01T00:00:01.100Z',
      'not persisted before stop',
      undefined,
      { clientRequestId: 'req-failed' },
    )];
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('does not settle an input registered while stopped-turn native evidence is loading', async () => {
    const nativeLoad = deferred();
    const reader = {
      loadNativeMessages: mock(() => nativeLoad.promise),
      getRetainedHistoryMessages: mock(() => []),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'interrupted', { clientRequestId: 'req-a' });
    const interruptedCohort = service.captureCohort('chat-1');

    const settlement = service.settleNativeCohort(interruptedCohort);
    await Promise.resolve();
    await service.register('chat-1', 'sent next', { clientRequestId: 'req-b' });
    nativeLoad.resolve([]);
    await settlement;

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-b', deliveryStatus: 'accepted' },
    ]);
  });

  it('does not assign an identical successor echo to the interrupted cohort', async () => {
    const now = Date.now();
    const interruptedAt = new Date(now - 1_000).toISOString();
    const successorAt = new Date(now + 1_000).toISOString();
    const nativeMessages = [new UserMessage(successorAt, 'repeat this')];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => nativeMessages),
      getRetainedHistoryMessages: mock(() => []),
    });
    await service.register('chat-1', 'repeat this', {
      clientRequestId: 'req-a',
      createdAt: interruptedAt,
    });
    const interruptedCohort = service.captureCohort('chat-1');
    await service.register('chat-1', 'repeat this', {
      clientRequestId: 'req-b',
      createdAt: successorAt,
    });

    await service.settleNativeCohort(interruptedCohort);

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-b', deliveryStatus: 'accepted' },
    ]);

    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
    ]);
  });

  it('requires request identity when settling a terminal cohort', async () => {
    const timestamp = '2026-06-01T00:00:00.000Z';
    const nativeMessages = [new UserMessage(timestamp, 'same content')];
    const service = new PendingUserInputService({
      loadNativeMessages: mock(async () => nativeMessages),
      getRetainedHistoryMessages: mock(() => nativeMessages),
    });
    await service.register('chat-1', 'same content', {
      clientRequestId: 'req-a',
      createdAt: timestamp,
    });
    const cohort = service.captureCohort('chat-1');

    await service.settleNativeCohort(cohort);

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
    ]);
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('coalesces repeated native reconciliation into one dirty rerun', async () => {
    const firstLoad = deferred();
    const loadNativeMessages = mock()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementation(async () => []);
    const service = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: mock(() => []),
    });
    await service.register('chat-1', 'pending', { clientRequestId: 'req-a' });

    const first = service.reconcileNativeHistory('chat-1');
    await Promise.resolve();
    const duplicates = Array.from(
      { length: 20 },
      () => service.reconcileNativeHistory('chat-1'),
    );
    firstLoad.resolve([]);
    await Promise.all([first, ...duplicates]);

    expect(loadNativeMessages).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh native read for settlement queued behind reconciliation', async () => {
    const firstLoad = deferred();
    const loadNativeMessages = mock()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(async () => []);
    const service = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: mock(() => []),
    });
    await service.register('chat-1', 'interrupted', { clientRequestId: 'req-a' });
    const reconciliation = service.reconcileNativeHistory('chat-1');
    await Promise.resolve();
    const settlement = service.settleNativeCohort(service.captureCohort('chat-1'));

    firstLoad.resolve([]);
    await Promise.all([reconciliation, settlement]);

    expect(loadNativeMessages).toHaveBeenCalledTimes(2);
    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
    ]);
  });

  it('does not resurrect or update a cohort cleared during native settlement', async () => {
    const nativeLoad = deferred();
    const service = new PendingUserInputService({
      loadNativeMessages: mock(() => nativeLoad.promise),
      getRetainedHistoryMessages: mock(() => []),
    });
    const statusUpdates = [];
    service.store.onStatusUpdated((_chatId, clientRequestId, deliveryStatus) => {
      statusUpdates.push({ clientRequestId, deliveryStatus });
    });
    await service.register('chat-1', 'interrupted', { clientRequestId: 'req-a' });
    const settlement = service.settleNativeCohort(service.captureCohort('chat-1'));
    await Promise.resolve();

    service.clearChat('chat-1');
    nativeLoad.resolve([]);
    await settlement;

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(statusUpdates).toEqual([]);
  });

  it('does not settle a replacement registration with the same request ID', async () => {
    const nativeLoad = deferred();
    const service = new PendingUserInputService({
      loadNativeMessages: mock(() => nativeLoad.promise),
      getRetainedHistoryMessages: mock(() => []),
    });
    await service.register('chat-1', 'first registration', { clientRequestId: 'req-a' });
    const settlement = service.settleNativeCohort(service.captureCohort('chat-1'));
    await Promise.resolve();

    service.discard('chat-1', 'req-a');
    await service.register('chat-1', 'replacement registration', { clientRequestId: 'req-a' });
    nativeLoad.resolve([]);
    await settlement;

    expect(service.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-a',
      content: 'replacement registration',
      deliveryStatus: 'accepted',
    }]);
  });

  it('uses a retained durable echo without forcing a full transcript load', async () => {
    const retained = [new UserMessage(
      '2026-06-01T00:00:00.100Z',
      'persisted',
      undefined,
      { clientRequestId: 'req-1' },
    )];
    const reader = {
      loadNativeMessages: mock(async () => {
        throw new Error('full load should not run');
      }),
      getRetainedHistoryMessages: mock(() => retained),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(reader.loadNativeMessages).not.toHaveBeenCalled();
  });

  it('never treats a complete view optimistic row as native persistence evidence', async () => {
    const history = [new AssistantMessage('2026-06-01T00:00:00.000Z', 'history')];
    let nativeMessages = history;
    const loadNativeMessages = mock(async () => nativeMessages);
    const views = new ChatViewStore(() => false);
    const service = new PendingUserInputService({
      loadNativeMessages,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    await service.register('chat-1', 'accepted input', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => history,
      [new UserMessage(
        '2026-06-01T00:00:00.000Z',
        'accepted input',
        undefined,
        { clientRequestId: 'req-1', turnId: 'turn-1', deliveryStatus: 'accepted' },
      )],
    );

    await service.reconcileRetainedHistory('chat-1');
    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-1' }]);
    expect(loadNativeMessages).toHaveBeenCalledTimes(1);

    nativeMessages = [
      ...history,
      new UserMessage(
        '2026-06-01T00:00:00.125Z',
        'accepted input',
        undefined,
        { clientRequestId: 'req-1', turnId: 'turn-1' },
      ),
    ];
    await service.reconcileNativeHistory('chat-1');
    expect(service.listForChat('chat-1')).toEqual([]);
  });

  it('does not reconcile an old identical native message', async () => {
    let messages = [];
    const reader = {
      loadNativeMessages: mock(async () => messages),
      getRetainedHistoryMessages: mock(() => messages),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'repeat', {
      clientRequestId: 'req-1',
      createdAt: '2026-06-01T01:00:00.000Z',
    });
    messages = [new UserMessage('2026-06-01T00:00:00.000Z', 'repeat')];

    await service.reconcileRetainedHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([{ clientRequestId: 'req-1' }]);
  });

  it('does not reconcile a native message with a conflicting request identity', async () => {
    let messages = [];
    const reader = {
      loadNativeMessages: mock(async () => messages),
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

    await service.reconcileRetainedHistory('chat-1');

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
      loadNativeMessages: async () => nativeMessages,
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

    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    expect(views.getCursor('chat-1')?.generationId).toBe(live.generationId);
    await views.getOrCreateMessages('chat-1', async () => nativeMessages);
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
      loadNativeMessages: async () => nativeMessages,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    };
    const service = new PendingUserInputService(reader);
    await service.register('chat-1', 'persisted', {
      clientRequestId: 'req-1',
      turnId: 'turn-1',
      createdAt: '2026-06-01T00:00:00.000Z',
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

    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toEqual([]);
    await views.getOrCreateMessages('chat-1', async () => nativeMessages);
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
      loadNativeMessages: async () => nativeMessages,
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

    await service.reconcileNativeHistory('chat-1');

    expect(service.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-live', turnId: 'turn-live' },
    ]);
    await views.getOrCreateMessages('chat-1', async () => nativeMessages);
    expect(views.getCursor('chat-1')?.generationId).not.toBe(live.generationId);
    expect(views.readPage('chat-1', 10).messages.at(-1)?.message).toMatchObject({
      metadata: { clientRequestId: 'req-native', turnId: 'turn-native' },
    });
  });

});
