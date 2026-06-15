import { describe, expect, it } from 'bun:test';
import { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { PendingUserInputService } from '../chats/pending-user-input-service.js';
import {
  AgentRunFailedMessage,
  ChatGenerationResetMessage,
  ChatMessagesMessage,
} from '../../common/ws-events.ts';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../common/chat-types.js';

const TS = '2026-06-01T00:00:00.000Z';
const RELOAD_FAILED_NOTICE = 'The process died. Reloading chat history failed.';

function user(content, metadata = {}) {
  return new UserMessage(TS, content, undefined, metadata);
}

function assistant(content) {
  return new AssistantMessage(TS, content);
}

function contents(result) {
  return result.messages.map((entry) => entry.message.content);
}

describe('chat stream resume integration', () => {
  it('replays missed same-generation output after reconnect', async () => {
    const views = new ChatViewStore(() => false);
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };

    await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [user('hello', { ...turn, deliveryStatus: 'accepted' })],
    );
    const first = await views.appendAfterEnsuringGeneration('chat-1', async () => [], [assistant('first')]);
    const cursor = { generationId: first.generationId, lastSeq: first.lastSeq };

    await views.appendAfterEnsuringGeneration('chat-1', async () => [], [assistant('missed')]);

    const replay = views.readReplay('chat-1', cursor.generationId, cursor.lastSeq);

    expect(replay.mode).toBe('delta');
    expect(contents(replay)).toEqual(['missed']);
    expect(replay.lastSeq).toBe(3);
  });

  it('process failure reload resets generation and prevents stale late output', async () => {
    const views = new ChatViewStore(() => false);
    const nativeReloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: async () => [assistant('last native message')] },
      () => true,
    );
    const pendingInputs = new PendingUserInputService({
      ensureLoaded: async (chatId) => views.getOrCreateMessages(chatId, async () => []),
      getMessages: (chatId) => views.getLoadedMessages(chatId),
    });
    const broadcasts = [];
    const turn = { clientRequestId: 'req-1', turnId: 'turn-1' };
    const staleFence = views.captureFence('chat-1');

    await pendingInputs.register('chat-1', 'lost prompt', turn);
    views.invalidateFence('chat-1');
    const reload = await nativeReloader.reloadFromNative('chat-1', 'process-error');
    pendingInputs.discardChat('chat-1');
    broadcasts.push(new ChatGenerationResetMessage(
      'chat-1',
      reload.generationId,
      'process-error',
      reload.lastSeq,
    ));
    broadcasts.push(new AgentRunFailedMessage('chat-1', 'process died', turn.turnId, turn.clientRequestId));

    const late = await views.appendAfterEnsuringGeneration(
      'chat-1',
      async () => [],
      [assistant('late')],
      { fence: staleFence },
    );
    const page = views.readPage('chat-1', 100);

    expect(late.skipped).toBe(true);
    expect(contents(page)).toEqual(['last native message', 'The process died.']);
    expect(pendingInputs.listForChat('chat-1')).toEqual([]);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'chat-generation-reset',
      generationId: reload.generationId,
      reason: 'process-error',
      lastSeq: 2,
    }));
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'agent-run-failed',
      clientRequestId: 'req-1',
      turnId: 'turn-1',
    }));
  });

  it('process failure reload failure broadcasts an explanatory in-generation error message', async () => {
    const views = new ChatViewStore(() => false);
    const nativeReloader = new ChatNativeReloader(
      views,
      { loadNativeMessages: async () => { throw new Error('native read failed'); } },
      () => true,
    );
    const broadcasts = [];

    const original = await views.appendAfterEnsuringGeneration('chat-1', async () => [], [assistant('warm output')]);
    views.invalidateFence('chat-1');
    await expect(nativeReloader.reloadFromNative('chat-1', 'process-error')).rejects.toThrow('native read failed');
    const appended = await views.appendToCurrentOrEmpty('chat-1', [
      new ErrorMessage(TS, RELOAD_FAILED_NOTICE),
    ]);
    broadcasts.push(new ChatMessagesMessage(
      'chat-1',
      appended.generationId,
      appended.messages,
      'turn-1',
      'req-1',
    ));
    broadcasts.push(new AgentRunFailedMessage('chat-1', 'process died', 'turn-1', 'req-1'));

    const page = views.readPage('chat-1', 100);
    const replay = views.readReplay('chat-1', original.generationId, original.lastSeq);

    expect(page.generationId).toBe(original.generationId);
    expect(contents(page)).toEqual(['warm output', RELOAD_FAILED_NOTICE]);
    expect(replay).toMatchObject({
      mode: 'delta',
      generationId: original.generationId,
    });
    expect(contents(replay)).toEqual([RELOAD_FAILED_NOTICE]);
    expect(broadcasts).toContainEqual(expect.objectContaining({
      type: 'chat-messages',
      generationId: original.generationId,
      messages: [expect.objectContaining({ message: expect.any(ErrorMessage) })],
    }));
  });
});
