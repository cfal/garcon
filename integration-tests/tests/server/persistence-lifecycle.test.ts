import { describe, expect, test } from 'bun:test';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('persistence lifecycle', () => {
  test('restores an idle direct chat and provider configuration after graceful restart', async () => {
    await withIntegrationFixture('idle-chat-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'restart-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'restart-b',
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);
      const before = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon();
      const catalog = await fixture.client.listAgentCatalog();
      const persistedProvider = catalog.apiProviders.find((provider) => provider.id === fixture.provider.providerId);
      expect(persistedProvider).toBeDefined();
      expect(persistedProvider?.endpoints[0]).toMatchObject({
        id: fixture.provider.endpointId,
        hasApiKey: true,
      });
      expect(JSON.stringify(persistedProvider)).not.toContain('sk-integration-test');
      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).toContain(chatId);
      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual(userContents(before.messages));
      expect(assistantContents(restored.messages)).toEqual(assistantContents(before.messages));
      expect(restored.messages.map((entry) => entry.seq)).toEqual(before.messages.map((entry) => entry.seq));
      expect((await fixture.client.reconnectState([])).processing).toEqual({
        outcome: 'snapshot',
        runningChatIds: [],
      });

      const third = await fixture.client.runDirectChat({
        chatId,
        content: 'restart-c',
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, third.turnId);
      const request = fixture.fakeOpenAi.requests().at(-1)!;
      expect(request.body.messages.map((message) => message.content)).toEqual([
        'restart-a',
        'echo:restart-a',
        'restart-b',
        'echo:restart-b',
        'restart-c',
      ]);
    });
  });

  test('restores queued entry identities and recovered pause state', async () => {
    await withIntegrationFixture('queue-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'durable-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'durable-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'durable-b');
      const queuedC = await fixture.client.enqueueNew(chatId, 'durable-c');
      const before = queuedC.queue;

      await fixture.restartGarcon();
      heldA.disconnect();
      const restored = await fixture.client.getQueue(chatId);
      expect(restored.entries).toEqual(before.entries);
      expect(restored.pause).not.toBeNull();
      expect(['recovered-inflight', 'completion-uncertain', 'manual']).toContain(restored.pause!.kind);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual(['durable-a']);

      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'durable-b' });
      const heldC = fixture.fakeOpenAi.holdNext({ lastUserText: 'durable-c' });
      await fixture.client.resumeQueue(chatId, restored.pause!.id);
      await heldB.received;
      heldB.releaseEcho();
      await heldC.received;
      const cursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'durable-a',
        'durable-b',
        'durable-c',
      ]);
      expect((await fixture.client.getQueue(chatId)).entries).toEqual([]);
      expect(queuedB.entryId).toBe(before.entries[0].id);
      expect(queuedC.entryId).toBe(before.entries[1].id);
    });
  });

  test('recovers accepted input after abrupt process loss without duplicate execution ownership', async () => {
    await withIntegrationFixture('abrupt-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'crash-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'crash-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      expect(countUserContent((await fixture.client.getMessages(chatId)).messages, 'crash-a')).toBe(1);

      await fixture.crashAndRestartGarcon();
      heldA.disconnect();
      const recovered = await fixture.client.getMessages(chatId);
      expect(countUserContent(recovered.messages, 'crash-a')).toBe(1);
      expect(assistantContents(recovered.messages)).toEqual([]);
      expect(recovered.pendingUserInputs.every((input) => input.deliveryStatus !== 'submitting')).toBe(true);

      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'crash-b',
        provider: fixture.provider,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, next.turnId)).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(userContents(completed.messages)).toEqual(['crash-a', 'crash-b']);
      expect(countUserContent(completed.messages, 'crash-a')).toBe(1);
      expect(countUserContent(completed.messages, 'crash-b')).toBe(1);
    });
  });

  test('deletes a running chat without stale provider resurrection', async () => {
    await withIntegrationFixture('delete-running-chat', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'delete-running' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'delete-running',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
      held.releaseEcho();

      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).not.toContain(chatId);
      let messagesError: unknown;
      try {
        await fixture.client.getMessages(chatId);
      } catch (error) {
        messagesError = error;
      }
      expect(messagesError).toBeInstanceOf(GarconApiError);
      expect((messagesError as GarconApiError).status).toBe(404);
      expect(fixture.client.events().some((event) =>
        event.type === 'chat-session-deleted' && event.chatId === chatId)).toBe(true);

      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).not.toContain(chatId);
    });
  });

  test('forks full and sequence-bounded direct histories independently', async () => {
    await withIntegrationFixture('direct-chat-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'fork-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'fork-b',
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, second.turnId);
      const sourceBefore = await fixture.client.getMessages(sourceChatId);
      const firstAssistantSeq = sourceBefore.messages.find((entry) =>
        entry.message.type === 'assistant-message')!.seq;

      const fullChatId = fixture.newChatId();
      const boundedChatId = fixture.newChatId();
      expect((await fixture.client.forkChat({ sourceChatId, chatId: fullChatId })).chat.id).toBe(fullChatId);
      expect((await fixture.client.forkChat({
        sourceChatId,
        chatId: boundedChatId,
        upToSeq: firstAssistantSeq,
      })).chat.id).toBe(boundedChatId);

      const fullRun = await fixture.client.runDirectChat({
        chatId: fullChatId,
        content: 'full-fork-turn',
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(fullChatId, fullRun.turnId);
      const boundedRun = await fixture.client.runDirectChat({
        chatId: boundedChatId,
        content: 'bounded-fork-turn',
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(boundedChatId, boundedRun.turnId);

      const fullRequest = fixture.fakeOpenAi.requests().find((request) =>
        request.lastUserText === 'full-fork-turn')!;
      expect(fullRequest.body.messages.map((message) => message.content)).toEqual([
        'fork-a',
        'echo:fork-a',
        'fork-b',
        'echo:fork-b',
        'full-fork-turn',
      ]);
      const boundedRequest = fixture.fakeOpenAi.requests().find((request) =>
        request.lastUserText === 'bounded-fork-turn')!;
      expect(boundedRequest.body.messages.map((message) => message.content)).toEqual([
        'fork-a',
        'echo:fork-a',
        'bounded-fork-turn',
      ]);
      expect((await fixture.client.getMessages(sourceChatId)).messages).toEqual(sourceBefore.messages);
    });
  });
});
