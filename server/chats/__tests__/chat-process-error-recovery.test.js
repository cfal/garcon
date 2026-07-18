import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { ChatNativeReloader } from '../chat-native-reload.js';
import { ChatProcessErrorRecovery } from '../chat-process-error-recovery.js';
import { PendingUserInputService } from '../pending-user-input-service.js';
import { ChatViewStore } from '../chat-view-store.js';

const TS = '2026-06-01T00:00:00.000Z';

function fullLoader(loadAll) {
  return { loadAll };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ChatProcessErrorRecovery', () => {
  it('clears persisted records and marks unpersisted cohort records unconfirmed', async () => {
    const nativeMessages = [
      new UserMessage(TS, 'persisted', undefined, { clientRequestId: 'req-persisted' }),
    ];
    const views = new ChatViewStore(() => false);
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: async () => nativeMessages,
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    const reloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: async () => nativeMessages },
      () => true,
    );
    const recovery = new ChatProcessErrorRecovery(views, reloader, pendingInputs);
    const cleared = [];
    pendingInputs.store.onCleared((chatId, clientRequestId, reason) => {
      cleared.push({ chatId, clientRequestId, reason });
    });
    await pendingInputs.register('chat-1', 'persisted', {
      clientRequestId: 'req-persisted',
      createdAt: TS,
    });
    await pendingInputs.register('chat-1', 'lost', {
      clientRequestId: 'req-lost',
      createdAt: '2026-06-01T00:00:01.000Z',
    });

    const result = await recovery.recover('chat-1', 'provider crashed');

    expect(result.kind).toBe('generation-reset');
    expect(cleared).toContainEqual({
      chatId: 'chat-1',
      clientRequestId: 'req-persisted',
      reason: 'persisted',
    });
    expect(pendingInputs.listForChat('chat-1')).toMatchObject([{
      clientRequestId: 'req-lost',
      deliveryStatus: 'unconfirmed',
    }]);
  });

  it('returns a committed generation reset when pending settlement fails', async () => {
    const views = new ChatViewStore(() => false);
    const reloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: async () => [new AssistantMessage(TS, 'native')] },
      () => false,
    );
    const settlementError = new Error('pending store unavailable');
    const pendingInputs = {
      captureCohort: mock((chatId) => ({ chatId, records: [] })),
      settleRetainedCohort: mock(() => { throw settlementError; }),
    };
    const recovery = new ChatProcessErrorRecovery(views, reloader, pendingInputs);

    const result = await recovery.recover('chat-1', 'provider crashed');

    expect(result).toMatchObject({
      kind: 'generation-reset',
      settlementError,
    });
    expect(pendingInputs.captureCohort).toHaveBeenCalledWith('chat-1');
    expect(pendingInputs.settleRetainedCohort).toHaveBeenCalledTimes(1);
    expect(views.readPage('chat-1', 20).messages.map((entry) => entry.message.content)).toEqual([
      'native',
      'provider crashed',
    ]);
  });

  it('does not settle a pending input accepted while process-error reload is in flight', async () => {
    const nativeLoad = deferred();
    const views = new ChatViewStore(() => false);
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: async () => [],
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    const reloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: () => nativeLoad.promise },
      () => true,
    );
    const recovery = new ChatProcessErrorRecovery(views, reloader, pendingInputs);
    await pendingInputs.register('chat-1', 'failed turn', { clientRequestId: 'req-a' });

    const recovering = recovery.recover('chat-1', 'provider crashed');
    await Promise.resolve();
    await pendingInputs.register('chat-1', 'later turn', { clientRequestId: 'req-b' });
    nativeLoad.resolve([]);
    await recovering;

    expect(pendingInputs.listForChat('chat-1')).toMatchObject([
      { clientRequestId: 'req-a', deliveryStatus: 'unconfirmed' },
      { clientRequestId: 'req-b', deliveryStatus: 'accepted' },
    ]);
  });

  it('keeps a cold fallback provisional so the next page load retries native history', async () => {
    const views = new ChatViewStore(() => false);
    const pendingInputs = new PendingUserInputService({
      loadNativeMessages: async () => [],
      getRetainedHistoryMessages: (chatId) => views.getRetainedHistoryMessages(chatId),
    });
    const reloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: async () => { throw new Error('native unavailable'); } },
      () => true,
    );
    const recovery = new ChatProcessErrorRecovery(views, reloader, pendingInputs);

    const result = await recovery.recover('chat-1', 'provider crashed');
    const loadAll = mock(async () => [new AssistantMessage(TS, 'native history')]);
    const page = await views.getOrCreatePage('chat-1', fullLoader(loadAll), 20);

    expect(result.kind).toBe('fallback-appended');
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(page.messages.map((entry) => entry.message.content)).toEqual(['native history']);
  });
});
