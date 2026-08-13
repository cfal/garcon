import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { parseServerRuntimeProbe } from '../../../common/server-runtime.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function getRuntimeInstanceId(baseUrl: string): Promise<string> {
  const challenge = randomBytes(32).toString('base64url');
  const response = await fetch(`${baseUrl}/api/v1/runtime?challenge=${challenge}`);
  expect(response.ok).toBe(true);
  return parseServerRuntimeProbe(await response.json()).instanceId;
}

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
      expect(restored.messages.map((entry) => entry.ordinal)).toEqual(before.messages.map((entry) => entry.ordinal));
      expect((await fixture.client.reconnectState([])).processing).toEqual({
        outcome: 'snapshot',
        chats: [],
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

  test('deduplicates committed submissions after a crash restart', async () => {
    await withIntegrationFixture('committed-submission-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const initial = await fixture.client.startDirectChat({
        chatId,
        content: 'idempotency-bootstrap',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId);

      const request = fixture.client.directRunRequest({
        chatId,
        content: 'idempotency-committed',
        agent: fixture.directAgents.openAi,
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
      });
      const committed = await fixture.client.runChat(request);
      await fixture.client.waitForTurnTerminal(chatId, committed.turnId);
      const beforeRestart = await fixture.client.getMessages(chatId);
      const requestCount = fixture.fakeProviders.openAi.requests().length;

      await fixture.crashAndRestartGarcon();
      await fixture.client.runChat(request);

      const afterRetry = await fixture.client.getMessages(chatId);
      expect(afterRetry.messages).toEqual(beforeRestart.messages);
      expect(countUserContent(afterRetry.messages, 'idempotency-committed')).toBe(1);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      expect((await fixture.client.reconnectState([])).processing).toEqual({
        outcome: 'snapshot',
        chats: [],
      });

      await expect(fixture.client.runChat({
        ...request,
        clientRequestId: crypto.randomUUID(),
        command: 'idempotency-conflict',
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'IDEMPOTENCY_CONFLICT' },
      });
      expect((await fixture.client.getMessages(chatId)).messages).toEqual(beforeRestart.messages);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
    });
  });

  test('drops queue control and pending input state on restart', async () => {
    await withIntegrationFixture('ephemeral-queue-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'ephemeral-active' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'ephemeral-active',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const initialInstanceId = await getRuntimeInstanceId(fixture.garcon.baseUrl);
      await fixture.client.enqueueNew(chatId, 'discard-on-restart');
      const paused = await fixture.client.pauseQueue(chatId);
      expect(paused.control.serverInstanceId).toBe(initialInstanceId);
      expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual(['discard-on-restart']);
      expect(paused.control.queue.pause?.kind).toBe('manual');
      const initialReconnect = await fixture.client.reconnectState([chatId]);
      expect(initialReconnect.serverInstanceId).toBe(initialInstanceId);
      const initialControl = initialReconnect.controlResults[0];
      if (!initialControl || initialControl.outcome !== 'snapshot') {
        throw new Error('Initial reconnect did not return the queue snapshot.');
      }
      expect(initialControl.control.serverInstanceId).toBe(initialInstanceId);
      expect(initialReconnect.processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId, phase: 'running' }],
      });

      const activeAborted = held.expectAbort();
      await fixture.restartGarcon();
      await activeAborted;
      held.releaseTruncatedStream();

      const restartedInstanceId = await getRuntimeInstanceId(fixture.garcon.baseUrl);
      expect(restartedInstanceId).not.toBe(initialInstanceId);
      const restarted = await fixture.client.reconnectState([chatId]);
      expect(restarted.serverInstanceId).toBe(restartedInstanceId);
      expect(restarted.processing).toEqual({
        outcome: 'snapshot',
        chats: [],
      });
      expect(restarted.controlResults).toEqual([{
        chatId,
        outcome: 'snapshot',
        control: {
          serverInstanceId: restartedInstanceId,
          queue: {
            entries: [],
            steeringEntryId: null,
            recentlyDispatched: [],
            pause: null,
            reorderRevision: 0,
          },
          version: 0,
          updatedAt: null,
        },
      }]);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual({
        serverInstanceId: restartedInstanceId,
        queue: {
          entries: [],
          steeringEntryId: null,
          recentlyDispatched: [],
          pause: null,
          reorderRevision: 0,
        },
        version: 0,
        updatedAt: null,
      });
      const restored = await fixture.client.getMessages(chatId);
      expect(restored.resendCandidates).toEqual([
        { ordinal: 1, content: 'ephemeral-active', attachmentNames: [] },
      ]);
      expect(countUserContent(restored.messages, 'discard-on-restart')).toBe(0);
      expect(countUserContent(restored.messages, 'ephemeral-active')).toBe(1);
      await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({
        response: { code: 'HISTORY_LOAD_FAILED' },
      });

      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'after-restart',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, next.turnId);
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.lastUserText).toBe(
        'ephemeral-active\n\nafter-restart',
      );
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
      ))!.ordinal;

      const fullChatId = fixture.newChatId();
      const boundedChatId = fixture.newChatId();
      expect((await fixture.client.forkChat({ sourceChatId, chatId: fullChatId })).chat.id).toBe(fullChatId);
      expect((await fixture.client.forkChat({
        sourceChatId,
        chatId: boundedChatId,
        transcriptViewId: sourceBefore.transcriptViewId,
        upToOrdinal: firstAssistantSeq,
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
      // Forking leaves the source conversation alone. It does rebuild the source view from that
      // chat's own transcript, so persisted timestamps replace the ones assigned while streaming.
      const sourceAfter = await fixture.client.getMessages(sourceChatId);
      expect(conversationOf(sourceAfter.messages)).toEqual(conversationOf(sourceBefore.messages));
    });
  });
});

function conversationOf(messages: readonly TranscriptMessage[]) {
  return messages.map((entry) => ({
    seq: entry.ordinal,
    type: entry.message.type,
    content: 'content' in entry.message ? entry.message.content : null,
  }));
}
