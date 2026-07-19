import { describe, expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID } from '../../../common/agents.js';
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
      const persistedProvider = catalog.apiProviders.find((provider) => provider.id === fixture.directAgents.openAi.provider.providerId);
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
      const request = fixture.fakeProviders.openAi.requests().at(-1)!;
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
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'durable-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'durable-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'durable-b');
      const queuedC = await fixture.client.enqueueNew(chatId, 'durable-c');
		const before = queuedC.control.queue;
		const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'durable-b' });
		const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'durable-c' });

      const activeAborted = heldA.expectAbort();
      await fixture.restartGarcon();
      await activeAborted;
      heldA.releaseTruncatedStream();
      await heldB.received;
      const restored = (await fixture.client.getExecutionControl(chatId)).queue;
      expect(restored.pause).toBeNull();
      expect(restored.dispatchingEntryId).toBe(queuedB.entryId);
      expect(restored.entries).toEqual([before.entries[1]]);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'durable-a',
        'durable-b',
      ]);

      heldB.releaseEcho();
      await heldC.received;
      const cursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'durable-a',
        'durable-b',
        'durable-c',
      ]);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      expect(queuedB.entryId).toBe(before.entries[0].id);
      expect(queuedC.entryId).toBe(before.entries[1].id);
    });
  });

  test('recovers accepted input after abrupt process loss without duplicate execution ownership', async () => {
    await withIntegrationFixture('abrupt-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'crash-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'crash-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      expect(countUserContent((await fixture.client.getMessages(chatId)).messages, 'crash-a')).toBe(1);

      const activeAborted = heldA.expectAbort();
      await fixture.crashAndRestartGarcon();
      await activeAborted;
      heldA.releaseTruncatedStream();
      const installedControl = await fixture.client.getExecutionControl(chatId);
      expect(installedControl.recoveredInputContinuation).toMatchObject({
        id: expect.any(String),
        installedAt: expect.any(String),
      });
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

		const recoveredControl = await fixture.client.getExecutionControl(chatId);
		expect(recoveredControl.queue.entries).toEqual([]);
		expect(recoveredControl.queue.pause).toBeNull();
		expect(recoveredControl.recoveredInputContinuation).toBeNull();

      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'crash-b',
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.getExecutionControl(chatId)).recoveredInputContinuation).toBeNull();
      expect((await fixture.client.waitForTurnTerminal(chatId, next.turnId)).type).toBe('agent-run-finished');
      const completed = await fixture.client.getMessages(chatId);
      expect(userContents(completed.messages)).toEqual(['crash-a', 'crash-b']);
      expect(countUserContent(completed.messages, 'crash-a')).toBe(1);
      expect(countUserContent(completed.messages, 'crash-b')).toBe(1);
    });
  });

  test('consumes exact empty recovered-input continuation with the next interactive run', async () => {
    await withIntegrationFixture('empty-recovered-input-continuation', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldPredecessor = fixture.fakeOpenAi.holdNext({ lastUserText: 'unconfirmed-before-restart' });
      const predecessor = await fixture.client.startDirectChat({
        chatId,
        content: 'unconfirmed-before-restart',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldPredecessor.received;
      const predecessorAborted = heldPredecessor.expectAbort();
      await fixture.crashAndRestartBeforeNativeUserPersistence({
        chatId,
        clientRequestId: predecessor.clientRequestId,
      });
      await predecessorAborted;
      heldPredecessor.releaseTruncatedStream();

      const recovered = await fixture.client.getExecutionControl(chatId);
      const firstContinuationId = recovered.recoveredInputContinuation?.id;
      if (!firstContinuationId) throw new Error('Recovered continuation was not installed.');
      expect(recovered.queue).toMatchObject({ entries: [], pause: null });
      expect(recovered.recoveredInputContinuation).toMatchObject({
        id: expect.any(String),
        installedAt: expect.any(String),
      });
      const restoredMessages = await fixture.client.getMessages(chatId);
      expect(restoredMessages.pendingUserInputs).toHaveLength(1);
      expect(restoredMessages.pendingUserInputs[0]).toMatchObject({
        content: 'unconfirmed-before-restart',
        deliveryStatus: 'unconfirmed',
      });

      const heldSuccessor = fixture.fakeOpenAi.holdNext({});
      const submissions = await Promise.allSettled([
        fixture.client.runDirectChat({
          chatId,
          content: 'continuation-successor-a',
          provider: fixture.provider,
        }),
        fixture.client.runDirectChat({
          chatId,
          content: 'continuation-successor-b',
          provider: fixture.provider,
        }),
      ]);
      const accepted = submissions.find((result) => result.status === 'fulfilled');
      const rejected = submissions.find((result) => result.status === 'rejected');
      if (!accepted || accepted.status !== 'fulfilled') throw new Error('No direct successor was accepted.');
      if (!rejected || rejected.status !== 'rejected') throw new Error('Concurrent successor was not rejected.');
      expect(rejected.reason).toBeInstanceOf(GarconApiError);
      expect((rejected.reason as GarconApiError).body).toMatchObject({
        errorCode: 'SESSION_BUSY',
        retryable: true,
        control: { recoveredInputContinuation: null },
      });
      const providerRequest = await heldSuccessor.received;
      const rejectedContent = providerRequest.lastUserText === 'continuation-successor-a'
        ? 'continuation-successor-b'
        : 'continuation-successor-a';
      expect((await fixture.client.getExecutionControl(chatId)).recoveredInputContinuation).toBeNull();
      const inFlight = await fixture.client.getMessages(chatId);
      expect(countUserContent(inFlight.messages, providerRequest.lastUserText)).toBe(1);
      expect(countUserContent(inFlight.messages, rejectedContent)).toBe(0);
      const cursor = fixture.client.markEvents();
      heldSuccessor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, accepted.value.turnId, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'unconfirmed-before-restart',
        providerRequest.lastUserText,
      ]);

      await fixture.crashAndRestartGarcon();
      const reconstructed = await fixture.client.getExecutionControl(chatId);
      expect(reconstructed.recoveredInputContinuation?.id).toBeString();
      expect(reconstructed.recoveredInputContinuation?.id).not.toBe(firstContinuationId);
    });
  });

  test('keeps queue pause and recovered continuation independent across restart', async () => {
    await withIntegrationFixture('queued-recovered-input-continuation', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldPredecessor = fixture.fakeOpenAi.holdNext({ lastUserText: 'blocked-predecessor' });
      const predecessor = await fixture.client.startDirectChat({
        chatId,
        content: 'blocked-predecessor',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldPredecessor.received;
      const queued = await fixture.client.enqueueNew(chatId, 'blocked-successor');
      const paused = await fixture.client.pauseQueue(chatId);
      const pauseId = paused.control.queue.pause?.id;
      if (!pauseId) throw new Error('Manual pause was not installed.');
      const heldSuccessor = fixture.fakeOpenAi.holdNext({ lastUserText: 'blocked-successor' });
      const predecessorAborted = heldPredecessor.expectAbort();
      await fixture.crashAndRestartBeforeNativeUserPersistence({
        chatId,
        clientRequestId: predecessor.clientRequestId,
      });
      await predecessorAborted;
      heldPredecessor.releaseTruncatedStream();

      const recovered = await fixture.client.getExecutionControl(chatId);
      expect(recovered.queue.pause).toMatchObject({ id: pauseId, kind: 'manual' });
      expect(recovered.queue.entries.map((entry) => entry.id)).toEqual([queued.entryId]);
      const continuationId = recovered.recoveredInputContinuation?.id;
      if (!continuationId) throw new Error('Recovered continuation was not installed.');
      const reconnect = await fixture.client.reconnectState([chatId]);
      expect(reconnect.controlResults).toEqual([expect.objectContaining({
        chatId,
        outcome: 'snapshot',
        control: expect.objectContaining({
          recoveredInputContinuation: expect.objectContaining({ id: continuationId }),
        }),
      })]);

      const resumed = await fixture.client.resumeQueue(chatId, pauseId);
      expect(resumed.control.queue.pause).toBeNull();
      expect(resumed.control.recoveredInputContinuation?.id).toBe(continuationId);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'blocked-predecessor',
      ]);

      const deleted = await fixture.client.deleteQueued({
        chatId,
        entryId: queued.entryId,
        clientRequestId: crypto.randomUUID(),
      });
      expect(deleted.control.queue.entries).toEqual([]);
      expect(deleted.control.recoveredInputContinuation?.id).toBe(continuationId);
      await fixture.client.enqueueNew(chatId, 'discard-before-continue');
      const cleared = await fixture.client.clearQueue(chatId);
      expect(cleared.control.queue.entries).toEqual([]);
      expect(cleared.control.recoveredInputContinuation?.id).toBe(continuationId);
      const replacement = await fixture.client.enqueueNew(chatId, 'blocked-successor');
      expect(replacement.control.recoveredInputContinuation?.id).toBe(continuationId);
      const repaused = await fixture.client.pauseQueue(chatId);
      const replacementPauseId = repaused.control.queue.pause?.id;
      if (!replacementPauseId) throw new Error('Replacement queue pause was not installed.');

      await expect(fixture.client.continueRecoveredInput({
        chatId,
        continuationId: crypto.randomUUID(),
      })).rejects.toMatchObject({
        status: 409,
        body: {
          errorCode: 'RECOVERED_INPUT_CONTINUATION_CHANGED',
          control: { recoveredInputContinuation: { id: continuationId } },
        },
      });

      const continued = await fixture.client.continueRecoveredInput({ chatId, continuationId });
      expect(continued.control.recoveredInputContinuation).toBeNull();
      expect(continued.control.queue.pause?.id).toBe(replacementPauseId);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'blocked-predecessor',
      ]);
      await fixture.client.resumeQueue(chatId, replacementPauseId);
      await heldSuccessor.received;
      const cursor = fixture.client.markEvents();
      heldSuccessor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor });
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
    });
  });

  test('retries a recovered direct queue delivery without duplicating its user turn', async () => {
    await withIntegrationFixture('recovered-queue-delivery-idempotency', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'crash-proof-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);

      const heldActive = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'hold-active' });
      const active = await fixture.client.runDirectChat({
        chatId,
        content: 'hold-active',
        agent: fixture.directAgents.openAi,
      });
      await heldActive.received;
      const queued = await fixture.client.enqueueNew(chatId, 'crash-proof-b');
      const heldQueued = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'crash-proof-b' });
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
      const recoveredQueue = (await fixture.client.getExecutionControl(chatId)).queue;
      expect(recoveredQueue.pause).toMatchObject({ kind: 'recovered-inflight' });
      const cursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, recoveredQueue.pause!.id);
      await fixture.client.waitForEvent(
        (event): event is AgentRunFinishedMessage =>
          event.type === 'agent-run-finished' && event.chatId === chatId,
        'recovered queue retry completion',
        { afterIndex: cursor },
      );

      const retry = fixture.fakeProviders.openAi.requests().at(-1)!;
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
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      const sessionDir = join(
        fixture.dirs.workspace,
        'agent-data',
        DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
        'openai-compatible-sessions',
        fixture.directAgents.openAi.provider.endpointId,
      );
      const sessionFiles = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'));
      expect(sessionFiles).toHaveLength(1);
      const nativeRows = (await readFile(join(sessionDir, sessionFiles[0]), 'utf8'))
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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, seed.turnId);

      const heldActive = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'shutdown-active' });
      await fixture.client.runDirectChat({
        chatId,
        content: 'shutdown-active',
        agent: fixture.directAgents.openAi,
      });
      await heldActive.received;
      await fixture.client.enqueueNew(chatId, 'shutdown-successor');
      const heldSuccessor = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'shutdown-successor' });

      const activeAborted = heldActive.expectAbort();
      await fixture.restartGarcon();
      await activeAborted;
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'shutdown-seed',
        'shutdown-active',
      ]);
      heldActive.releaseEcho();

      await heldSuccessor.received;
      const recovered = (await fixture.client.getExecutionControl(chatId)).queue;
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

      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, seed.turnId);

      const blocker = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queue-shutdown-blocker' });
      const blockerTurn = await fixture.client.runDirectChat({
        chatId,
        content: 'queue-shutdown-blocker',
        agent: fixture.directAgents.openAi,
      });
      await blocker.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'queue-shutdown-b');
      await fixture.client.enqueueNew(chatId, 'queue-shutdown-c');
      const activeQueued = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queue-shutdown-b' });
      blocker.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, blockerTurn.turnId);
      const firstBRequest = await activeQueued.received;

      const queuedAbort = activeQueued.expectAbort();
      await fixture.restartGarcon();
      await queuedAbort;
      activeQueued.releaseText('stale response must be ignored');

      const recovered = (await fixture.client.getExecutionControl(chatId)).queue;
      expect(recovered.pause).toMatchObject({
        kind: 'completion-uncertain',
        entryId: queuedB.entryId,
      });
      expect(recovered.entries.map((entry) => entry.content)).toEqual([
        'queue-shutdown-b',
        'queue-shutdown-c',
      ]);
      const retryB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queue-shutdown-b' });
      const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queue-shutdown-c' });
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
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
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
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'invalid-queue-active' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'invalid-queue-active',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
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
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(fullChatId, fullRun.turnId);
      const boundedRun = await fixture.client.runDirectChat({
        chatId: boundedChatId,
        content: 'bounded-fork-turn',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(boundedChatId, boundedRun.turnId);

      const fullRequest = fixture.fakeProviders.openAi.requests().find((request) =>
        request.lastUserText === 'full-fork-turn')!;
      expect(fullRequest.body.messages.map((message) => message.content)).toEqual([
        'fork-a',
        'echo:fork-a',
        'fork-b',
        'echo:fork-b',
        'full-fork-turn',
      ]);
      const boundedRequest = fixture.fakeProviders.openAi.requests().find((request) =>
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
