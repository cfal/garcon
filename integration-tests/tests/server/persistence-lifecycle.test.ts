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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'restart-b',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);
      const before = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon();
      const catalog = await fixture.client.listAgentCatalog();
      const persistedProvider = catalog.apiProviders.find((provider) => (
        provider.id === fixture.directAgents.openAi.provider.providerId
      ));
      expect(persistedProvider).toBeDefined();
      expect(persistedProvider?.endpoints[0]).toMatchObject({
        id: fixture.directAgents.openAi.provider.endpointId,
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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, third.turnId);
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => (
        message.content
      ))).toEqual([
        'restart-a',
        'echo:restart-a',
        'restart-b',
        'echo:restart-b',
        'restart-c',
      ]);
    });
  });

  test('drops queue control and pending input state on restart', async () => {
    await withIntegrationFixture('ephemeral-queue-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'ephemeral-active' });
      const active = await fixture.client.startDirectChat({
        chatId,
        content: 'ephemeral-active',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, 'discard-on-restart');
      const paused = await fixture.client.pauseQueue(chatId);
      expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual(['discard-on-restart']);
      expect(paused.control.queue.pause?.kind).toBe('manual');
      expect((await fixture.client.reconnectState([chatId])).processing).toEqual({
        outcome: 'snapshot',
        runningChatIds: [chatId],
      });

      const activeAborted = held.expectAbort();
      await fixture.restartGarcon({
        beforeStart: () => fixture.appendDirectOpenAiNativeMessage({
          chatId,
          role: 'assistant',
          content: 'terminal persisted after disconnect',
          clientRequestId: active.clientRequestId,
          turnId: active.turnId,
        }),
      });
      await activeAborted;
      held.releaseTruncatedStream();

      const restarted = await fixture.client.reconnectState([chatId]);
      expect(restarted.processing).toEqual({
        outcome: 'snapshot',
        runningChatIds: [],
      });
      expect(restarted.controlResults).toEqual([{
        chatId,
        outcome: 'snapshot',
        control: {
          queue: {
            entries: [],
            dispatchingEntryId: null,
            recentlyDispatched: [],
            pause: null,
            reorderRevision: 0,
          },
          version: 0,
          updatedAt: null,
        },
      }]);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual({
        queue: {
          entries: [],
          dispatchingEntryId: null,
          recentlyDispatched: [],
          pause: null,
          reorderRevision: 0,
        },
        version: 0,
        updatedAt: null,
      });
      const reloaded = await fixture.client.reloadChat(chatId);
      expect(assistantContents(reloaded.messages)).toContain('terminal persisted after disconnect');
      const restored = await fixture.client.getMessages(chatId);
      expect(restored.pendingUserInputs).toEqual([]);
      expect(countUserContent(restored.messages, 'discard-on-restart')).toBe(0);
      expect(assistantContents(restored.messages)).toContain('terminal persisted after disconnect');

      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'after-restart',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, next.turnId);
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.lastUserText).toBe('after-restart');
    });
  });

  test('deletes a running chat without stale provider resurrection', async () => {
    await withIntegrationFixture('delete-running-chat', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'delete-running' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'delete-running',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const requestAborted = held.expectAbort();
      expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
      await requestAborted;
      held.releaseEcho();

      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id)).not.toContain(chatId);
      await expect(fixture.client.getMessages(chatId)).rejects.toBeInstanceOf(GarconApiError);

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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'fork-b',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, second.turnId);
      const sourceBefore = await fixture.client.getMessages(sourceChatId);
      const firstAssistantSeq = sourceBefore.messages.find((entry) => (
        entry.message.type === 'assistant-message'
      ))!.seq;

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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(fullChatId, fullRun.turnId);
      const boundedRun = await fixture.client.runDirectChat({
        chatId: boundedChatId,
        content: 'bounded-fork-turn',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(boundedChatId, boundedRun.turnId);

      const fullRequest = fixture.fakeProviders.openAi.requests().find((request) => (
        request.lastUserText === 'full-fork-turn'
      ));
      expect(fullRequest?.body.messages.map((message) => message.content)).toEqual([
        'fork-a',
        'echo:fork-a',
        'fork-b',
        'echo:fork-b',
        'full-fork-turn',
      ]);
      const boundedRequest = fixture.fakeProviders.openAi.requests().find((request) => (
        request.lastUserText === 'bounded-fork-turn'
      ));
      expect(boundedRequest?.body.messages.map((message) => message.content)).toEqual([
        'fork-a',
        'echo:fork-a',
        'bounded-fork-turn',
      ]);
      expect((await fixture.client.getMessages(sourceChatId)).messages).toEqual(sourceBefore.messages);
    });
  });
});
