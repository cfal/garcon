import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunFinishedMessage } from '../../../common/ws-events.js';
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

  test('resumes queued successors without transferring direct-turn shutdown uncertainty', async () => {
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
      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'durable-b' });
      const heldC = fixture.fakeOpenAi.holdNext({ lastUserText: 'durable-c' });

      const activeAborted = heldA.expectAbort();
      await fixture.restartGarcon();
      await activeAborted;
      heldA.releaseTruncatedStream();
      await heldB.received;
      const restored = await fixture.client.getQueue(chatId);
      expect(restored.pause).toBeNull();
      expect(restored.dispatchingEntryId).toBe(queuedB.entryId);
      expect(restored.entries).toEqual([before.entries[1]]);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'durable-a',
        'durable-b',
      ]);

      heldB.releaseEcho();
      await heldC.received;
      const cursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
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

      const activeAborted = heldA.expectAbort();
      await fixture.crashAndRestartGarcon();
      await activeAborted;
      heldA.releaseTruncatedStream();
      const recovered = await fixture.client.getMessages(chatId);
      expect(countUserContent(recovered.messages, 'crash-a')).toBe(1);
      expect(assistantContents(recovered.messages)).toEqual([]);
      expect(recovered.pendingUserInputs).toEqual([]);
      expect(recovered.messages[0]?.message).toMatchObject({
        type: 'user-message',
        metadata: {
          clientRequestId: expect.any(String),
          turnId: expect.any(String),
        },
      });

      const recoveryPause = await fixture.client.getQueue(chatId);
      expect(recoveryPause.entries).toEqual([]);
      expect(recoveryPause.pause).toMatchObject({ kind: 'recovered-unconfirmed-input' });
      await expect(fixture.client.runDirectChat({
        chatId,
        content: 'must-not-bypass-recovery',
        provider: fixture.provider,
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'SESSION_BUSY' },
      });
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'crash-a',
      ]);
      await fixture.client.resumeQueue(chatId, recoveryPause.pause!.id);

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

  test('retries a recovered direct queue delivery without duplicating its user turn', async () => {
    await withIntegrationFixture('recovered-queue-delivery-idempotency', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'crash-proof-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);

      const heldActive = fixture.fakeOpenAi.holdNext({ lastUserText: 'hold-active' });
      const active = await fixture.client.runDirectChat({
        chatId,
        content: 'hold-active',
        provider: fixture.provider,
      });
      await heldActive.received;
      const queued = await fixture.client.enqueueNew(chatId, 'crash-proof-b');
      const heldQueued = fixture.fakeOpenAi.holdNext({ lastUserText: 'crash-proof-b' });
      heldActive.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, active.turnId);
      await heldQueued.received;
      const storedQueue = JSON.parse(await readFile(
        join(fixture.dirs.workspace, 'queues', `${chatId}.queue.json`),
        'utf8',
      )) as {
        entries: Array<{
          id: string;
          delivery?: { clientRequestId: string; clientMessageId: string; turnId: string };
        }>;
      };
      const originalDelivery = storedQueue.entries.find((entry) => entry.id === queued.entryId)?.delivery;
      expect(originalDelivery).toBeDefined();

      const queuedAborted = heldQueued.expectAbort();
      await fixture.crashAndRestartGarcon();
      await queuedAborted;
      heldQueued.releaseTruncatedStream();
      const recoveredQueue = await fixture.client.getQueue(chatId);
      expect(recoveredQueue.pause).toMatchObject({ kind: 'recovered-inflight' });
      const cursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, recoveredQueue.pause!.id);
      await fixture.client.waitForEvent(
        (event): event is AgentRunFinishedMessage =>
          event.type === 'agent-run-finished' && event.chatId === chatId,
        'recovered queue retry completion',
        { afterIndex: cursor },
      );

      const retry = fixture.fakeOpenAi.requests().at(-1)!;
      expect(retry.lastUserText).toBe('crash-proof-b');
      expect(retry.body.messages.map((message) => message.content)).toEqual([
        'crash-proof-a',
        'echo:crash-proof-a',
        'hold-active',
        'echo:hold-active',
        'crash-proof-b',
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, 'crash-proof-b')).toBe(1);
      expect(transcript.pendingUserInputs).toEqual([]);
      expect((await fixture.client.getQueue(chatId)).entries).toEqual([]);
      const nativeRows = (await readFile(join(
        fixture.dirs.workspace,
        'openai-compatible-sessions',
        fixture.provider.endpointId,
        `${chatId}.jsonl`,
      ), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(nativeRows.filter((row) => (
        row.role === 'user' && row.content === 'crash-proof-b'
      ))).toEqual([expect.objectContaining(originalDelivery!)]);
    });
  });

  test('does not dispatch a queued successor after graceful shutdown begins', async () => {
    await withIntegrationFixture('graceful-shutdown-queue-fence', async (fixture) => {
      const chatId = fixture.newChatId();
      const seed = await fixture.client.startDirectChat({
        chatId,
        content: 'shutdown-seed',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, seed.turnId);

      const heldActive = fixture.fakeOpenAi.holdNext({ lastUserText: 'shutdown-active' });
      await fixture.client.runDirectChat({
        chatId,
        content: 'shutdown-active',
        provider: fixture.provider,
      });
      await heldActive.received;
      await fixture.client.enqueueNew(chatId, 'shutdown-successor');
      const heldSuccessor = fixture.fakeOpenAi.holdNext({ lastUserText: 'shutdown-successor' });

      const activeAborted = heldActive.expectAbort();
      await fixture.restartGarcon();
      await activeAborted;
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'shutdown-seed',
        'shutdown-active',
      ]);
      heldActive.releaseEcho();

      await heldSuccessor.received;
      const recovered = await fixture.client.getQueue(chatId);
      expect(recovered.pause).toBeNull();
      expect(recovered.dispatchingEntryId).toBeString();
      expect(recovered.entries).toEqual([]);
      const cursor = fixture.client.markEvents();
      heldSuccessor.releaseEcho();
      await fixture.client.waitForEvent(
        (event): event is AgentRunFinishedMessage =>
          event.type === 'agent-run-finished' && event.chatId === chatId,
        'post-shutdown queued successor completion',
        { afterIndex: cursor },
      );

      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'shutdown-seed',
        'shutdown-active',
        'shutdown-successor',
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, 'shutdown-active')).toBe(1);
      expect(countUserContent(transcript.messages, 'shutdown-successor')).toBe(1);
      expect(transcript.pendingUserInputs).toEqual([]);
    });
  });

  test('preserves the active queued delivery when graceful shutdown aborts it', async () => {
    await withIntegrationFixture('graceful-shutdown-active-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const seed = await fixture.client.startDirectChat({
        chatId,
        content: 'queue-shutdown-seed',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await fixture.client.waitForTurnTerminal(chatId, seed.turnId);

      const blocker = fixture.fakeOpenAi.holdNext({ lastUserText: 'queue-shutdown-blocker' });
      const blockerTurn = await fixture.client.runDirectChat({
        chatId,
        content: 'queue-shutdown-blocker',
        provider: fixture.provider,
      });
      await blocker.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'queue-shutdown-b');
      await fixture.client.enqueueNew(chatId, 'queue-shutdown-c');
      const activeQueued = fixture.fakeOpenAi.holdNext({ lastUserText: 'queue-shutdown-b' });
      blocker.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, blockerTurn.turnId);
      const firstBRequest = await activeQueued.received;

      const queuedAbort = activeQueued.expectAbort();
      await fixture.restartGarcon();
      await queuedAbort;
      activeQueued.releaseText('stale response must be ignored');

      const recovered = await fixture.client.getQueue(chatId);
      expect(recovered.pause).toMatchObject({
        kind: 'completion-uncertain',
        entryId: queuedB.entryId,
      });
      expect(recovered.entries.map((entry) => entry.content)).toEqual([
        'queue-shutdown-b',
        'queue-shutdown-c',
      ]);
      const retryB = fixture.fakeOpenAi.holdNext({ lastUserText: 'queue-shutdown-b' });
      const heldC = fixture.fakeOpenAi.holdNext({ lastUserText: 'queue-shutdown-c' });
      await fixture.client.resumeQueue(chatId, recovered.pause!.id);
      const retryBRequest = await retryB.received;
      expect(retryBRequest.id).toBeGreaterThan(firstBRequest.id);
      retryB.releaseEcho();
      await heldC.received;
        const completionCursor = fixture.client.markEvents();
        heldC.releaseEcho();
        expect((await fixture.client.waitForTurnTerminal(chatId, undefined, {
          afterIndex: completionCursor,
        })).type).toBe('agent-run-finished');

      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, 'queue-shutdown-b')).toBe(1);
      expect(countUserContent(transcript.messages, 'queue-shutdown-c')).toBe(1);
      expect(transcript.pendingUserInputs).toEqual([]);
      expect((await fixture.client.getQueue(chatId)).entries).toEqual([]);
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
      const requestAborted = held.expectAbort();
      expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
      await requestAborted;
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

  test('fails restart without replacing structurally invalid durable queue state', async () => {
    await withIntegrationFixture('invalid-queue-startup', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'invalid-queue-active' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'invalid-queue-active',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, 'must not be erased');

      const providerAborted = held.expectAbort();
      await fixture.client.close();
      await fixture.garcon.stop();
      await providerAborted;
      held.releaseTruncatedStream();
      const queuePath = join(fixture.dirs.workspace, 'queues', `${chatId}.queue.json`);
      await writeFile(queuePath, 'null', 'utf8');

      await expect(fixture.restartGarcon()).rejects.toThrow(
        `Could not recover chat queue ${chatId}`,
      );
      expect(await readFile(queuePath, 'utf8')).toBe('null');
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
