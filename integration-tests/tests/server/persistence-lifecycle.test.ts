import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseServerRuntimeProbe } from '../../../common/server-runtime.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import {
  AssistantMessage,
  BashToolUseMessage,
} from '../../../common/chat-types.js';
import type { LedgerRowDraft } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { expectedCarriedInput } from '../../support/carried-context.js';
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

  test('builds direct context from native history while retaining ledger-only rows', async () => {
    await withIntegrationFixture('direct-context-ledger-fold', async (fixture) => {
      const chatId = fixture.newChatId();
      const initial = await fixture.client.startDirectChat({
        chatId,
        content: 'context-initial-user',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, initial.turnId);
      const before = await fixture.client.getMessages(chatId);
      const at = '2026-08-15T00:00:00.000Z';
      const injected: LedgerRowDraft[] = [
        {
          kind: 'notice',
          at,
          message: 'context-notice-must-not-reach-provider',
          detail: { type: 'ordinary-notice' },
          providerMeta: null,
        },
        {
          kind: 'permission-requested',
          at,
          lifecycle: {
            kind: 'requested',
            permissionOccurrenceId: 'context-incarnation',
            requestedTool: new BashToolUseMessage(at, 'context-tool', 'printf hidden'),
            options: [],
          },
          providerMeta: null,
        },
        {
          kind: 'provider-row',
          at,
          message: new AssistantMessage(at, 'context-late-provider-output'),
          providerMeta: null,
        },
        {
          kind: 'permission-cancelled',
          at,
          lifecycle: {
            kind: 'cancelled',
            permissionOccurrenceId: 'context-incarnation',
            reason: 'run ended',
          },
          providerMeta: null,
        },
      ];

      await fixture.restartGarcon({
        beforeStart: async () => {
          const store = new TranscriptLedgerStore(
            join(fixture.dirs.workspace, 'transcript-ledgers'),
          );
          try {
            const view = store.currentView(chatId);
            if (view?.viewId !== before.transcriptViewId) {
              throw new Error('The context fixture opened a different transcript view.');
            }
            store.append(chatId, view.viewId, injected);
          } finally {
            store.close();
          }
        },
      });

      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'context-next-user',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, next.turnId);

      const providerMessages = fixture.fakeProviders.openAi.requests().at(-1)?.body.messages;
      expect(providerMessages).toEqual([
        { role: 'user', content: 'context-initial-user' },
        { role: 'assistant', content: 'echo:context-initial-user' },
        { role: 'user', content: 'context-next-user' },
      ]);
      expect(JSON.stringify(providerMessages)).not.toContain('context-late-provider-output');
      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'assistant-message',
        'transcript-notice',
        'permission-request',
        'assistant-message',
        'permission-cancelled',
        'user-message',
        'assistant-message',
      ]);
      const ordinals = transcript.messages.map((entry) => entry.ordinal);
      expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
      expect(new Set(ordinals).size).toBe(ordinals.length);
    });
  }, 20_000);

  test('[TLV5-L04.04-SERVER-RESTART-01] deduplicates committed submissions after a crash restart', async () => {
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

  test('[TLV5-L03.04-SERVER-RESTART-01] drops queue control and pending input state on restart', async () => {
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
      const reloaded = await fixture.client.reloadChat(chatId);
      expect(reloaded.transcriptViewId).not.toBe(restored.transcriptViewId);
      expect(userContents(reloaded.messages)).toEqual(['ephemeral-active']);
      expect(assistantContents(reloaded.messages)).toEqual([]);

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

  test('[TLV5-A07-SERVER-RESTART-01] recomputes unanswered resend candidates after every restart', async () => {
    await withIntegrationFixture('ephemeral-resend-exclusion-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const prompt = 'resend-candidate-survives-client-opt-out';
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
      await fixture.client.startDirectChat({
        chatId,
        content: prompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;

      const aborted = held.expectAbort();
      await fixture.restartGarcon();
      await aborted;
      held.releaseTruncatedStream();

      const firstRestart = await fixture.client.getMessages(chatId);
      expect(firstRestart.resendCandidates).toEqual([{
        ordinal: 1,
        content: prompt,
        attachmentNames: [],
      }]);

      await fixture.restartGarcon();
      const secondRestart = await fixture.client.getMessages(chatId);
      expect(secondRestart.transcriptViewId).toBe(firstRestart.transcriptViewId);
      expect(secondRestart.messages).toEqual(firstRestart.messages);
      expect(secondRestart.resendCandidates).toEqual(firstRestart.resendCandidates);
    });
  }, 60_000);

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
      const fullFork = await fixture.client.forkChat({ sourceChatId, chatId: fullChatId });
      const boundedFork = await fixture.client.forkChat({
        sourceChatId,
        chatId: boundedChatId,
        transcriptViewId: sourceBefore.transcriptViewId,
        upToOrdinal: firstAssistantSeq,
      });
      expect(fullFork.chat).toMatchObject({
        id: fullChatId,
        parentChat: {
          chatId: sourceChatId,
          relation: 'fork',
          transcriptViewId: sourceBefore.transcriptViewId,
          ordinal: sourceBefore.lastOrdinal,
        },
      });
      expect(boundedFork.chat).toMatchObject({
        id: boundedChatId,
        parentChat: {
          chatId: sourceChatId,
          relation: 'fork',
          transcriptViewId: sourceBefore.transcriptViewId,
          ordinal: firstAssistantSeq,
        },
      });

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

      const fullInput = expectedCarriedInput([
        'fork-a',
        'echo:fork-a',
        'fork-b',
        'echo:fork-b',
      ], 'full-fork-turn');
      const fullRequest = fixture.fakeProviders.openAi.requests().find((request) => (
        request.lastUserText === fullInput
      ));
      expect(fullRequest?.body.messages.map((message) => message.content)).toEqual([
        fullInput,
      ]);
      const boundedInput = expectedCarriedInput([
        'fork-a',
        'echo:fork-a',
      ], 'bounded-fork-turn');
      const boundedRequest = fixture.fakeProviders.openAi.requests().find((request) => (
        request.lastUserText === boundedInput
      ));
      expect(boundedRequest?.body.messages.map((message) => message.content)).toEqual([
        boundedInput,
      ]);
      // Forking leaves the source conversation alone. It does rebuild the source view from that
      // chat's own transcript, so persisted timestamps replace the ones assigned while streaming.
      const sourceAfter = await fixture.client.getMessages(sourceChatId);
      expect(conversationOf(sourceAfter.messages)).toEqual(conversationOf(sourceBefore.messages));

      await fixture.restartGarcon();
      const restartedChats = (await fixture.client.listChats()).sessions;
      expect(restartedChats.find((chat) => chat.id === fullChatId)?.parentChat)
        .toEqual(fullFork.chat.parentChat);
      expect(restartedChats.find((chat) => chat.id === boundedChatId)?.parentChat)
        .toEqual(boundedFork.chat.parentChat);

      expect(await fixture.client.deleteChat(sourceChatId)).toEqual({ success: true });
      const afterParentDeletion = (await fixture.client.listChats()).sessions;
      expect(afterParentDeletion.find((chat) => chat.id === fullChatId)?.parentChat)
        .toEqual(fullFork.chat.parentChat);
      expect(afterParentDeletion.find((chat) => chat.id === boundedChatId)?.parentChat)
        .toEqual(boundedFork.chat.parentChat);

      expect(await fixture.client.deleteChat(fullChatId)).toEqual({ success: true });
      const afterChildDeletion = (await fixture.client.listChats()).sessions;
      expect(afterChildDeletion.map((chat) => chat.id)).not.toContain(fullChatId);
      expect(afterChildDeletion.find((chat) => chat.id === boundedChatId)?.parentChat)
        .toEqual(boundedFork.chat.parentChat);
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
