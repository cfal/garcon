import { describe, expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  ChatExecutionControlUpdatedMessage,
} from '../../../common/ws-events.js';
import { countUserContent, userMessages } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('provider failures', () => {
  test('reports HTTP, SSE, empty-stream, and truncated-stream failures honestly', async () => {
    await withIntegrationFixture('provider-failure-modes', async (fixture) => {
      const chatId = fixture.newChatId();
      const failures = [
        {
          content: 'http-401',
          configure: () => fixture.fakeProviders.openAi.failNextHttp({ lastUserText: 'http-401' }, 401, 'unauthorized'),
        },
        {
          content: 'http-429',
          configure: () => fixture.fakeProviders.openAi.failNextHttp({ lastUserText: 'http-429' }, 429, 'rate limited'),
        },
        {
          content: 'http-500',
          configure: () => fixture.fakeProviders.openAi.failNextHttp({ lastUserText: 'http-500' }, 500, 'upstream failed'),
        },
        {
          content: 'sse-error',
          configure: () => fixture.fakeProviders.openAi.failNextStream({ lastUserText: 'sse-error' }, 'stream failed'),
        },
        {
          content: 'empty-stream',
          configure: () => fixture.fakeProviders.openAi.respondEmptyNext({ lastUserText: 'empty-stream' }),
        },
        {
          content: 'truncated-stream',
          configure: () => fixture.fakeProviders.openAi.truncateNextStream({ lastUserText: 'truncated-stream' }),
        },
      ];

      for (const [index, failure] of failures.entries()) {
        failure.configure();
        const clientRequestId = crypto.randomUUID();
        const clientMessageId = crypto.randomUUID();
        const cursor = fixture.client.markEvents();
        const accepted = index === 0
          ? await fixture.client.startDirectChat({
              chatId,
              content: failure.content,
              projectPath: fixture.dirs.project,
              agent: fixture.directAgents.openAi,
              clientRequestId,
              clientMessageId,
            })
          : await fixture.client.runDirectChat({
              chatId,
              content: failure.content,
              agent: fixture.directAgents.openAi,
              clientRequestId,
              clientMessageId,
            });
        expect(accepted).toMatchObject({ status: 'accepted', clientRequestId });
        expect(accepted.turnId).toBeString();
        const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: cursor,
        });
        expect(terminal).toMatchObject({
          type: 'agent-run-failed',
          chatId,
          clientRequestId,
          turnId: accepted.turnId,
        });
        expect((terminal as AgentRunFailedMessage).error).toBeString();
        const transcript = await fixture.client.getMessages(chatId);
        expect(countUserContent(transcript.messages, failure.content)).toBe(1);
        const failedUser = userMessages(transcript.messages).find((message) =>
          message.content === failure.content);
        expect(failedUser?.metadata).toMatchObject({
          clientRequestId,
          turnId: accepted.turnId,
        });
        expect(transcript.pendingUserInputs).toEqual([]);
        const events = fixture.client.eventsSince(cursor);
        expect(events).toContainEqual(expect.objectContaining({
          type: 'pending-user-input-updated',
          input: expect.objectContaining({
            chatId,
            clientRequestId,
            clientMessageId,
            turnId: accepted.turnId,
          }),
        }));
        const clearedIndex = events.findIndex((event) =>
          event.type === 'pending-user-input-cleared'
          && event.clientRequestId === clientRequestId
          && event.reason === 'persisted');
        const terminalIndex = events.findIndex((event) =>
          event.type === 'agent-run-failed'
          && event.clientRequestId === clientRequestId
          && event.turnId === accepted.turnId);
        expect(clearedIndex).toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBeGreaterThan(clearedIndex);
      }
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(failures.length);
    });
  });

  test('skips malformed SSE data and retains a later valid completion', async () => {
    await withIntegrationFixture('provider-malformed-sse', async (fixture) => {
      const chatId = fixture.newChatId();
      fixture.fakeProviders.openAi.respondMalformedThenTextNext(
        { lastUserText: 'malformed-then-valid' },
        'valid-after-malformed',
      );
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'malformed-then-valid',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type).toBe('agent-run-finished');
      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.find((entry) => entry.message.type === 'assistant-message')?.message).toMatchObject({
        type: 'assistant-message',
        content: 'valid-after-malformed',
      });
    });
  });

  test('pauses queued work and gives an edited retry a new delivery identity', async () => {
    await withIntegrationFixture('queued-provider-failure', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'failure-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'failure-b');
      await fixture.client.enqueueNew(chatId, 'failure-c');
      fixture.fakeProviders.openAi.failNextHttp({ lastUserText: 'failure-b' }, 500, 'queued turn failed');
      const failureCursor = fixture.client.markEvents();
      heldA.releaseEcho();

      const failed = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage =>
          event.type === 'agent-run-failed' && event.chatId === chatId,
        'queued provider failure',
        { afterIndex: failureCursor },
      );
      expect(failed.error).toContain('500');
      await fixture.client.waitForEvent(
        (event): event is ChatExecutionControlUpdatedMessage => event.type === 'chat-execution-control-updated'
          && event.chatId === chatId
          && event.control.queue.pause?.kind === 'queued-turn-failed',
        'queued failure pause',
        { afterIndex: failureCursor },
      );
      const failureEvents = fixture.client.events().slice(failureCursor);
      const failedPending = failureEvents.find((event) =>
        event.type === 'pending-user-input-updated'
        && event.input.content === 'failure-b');
      if (failedPending?.type !== 'pending-user-input-updated') {
        throw new Error('Missing failed queued input identity.');
      }
      if (!failed.turnId || !failed.clientRequestId) {
        throw new Error('Missing failed queued delivery identity.');
      }
      expect(failedPending.input.clientRequestId).toBe(failed.clientRequestId);
      expect(failedPending.input.turnId).toBe(failed.turnId);
      expect(failedPending.input.clientMessageId).toBeString();
      const pauseEventIndex = failureEvents.findIndex((event) => (
        event.type === 'chat-execution-control-updated'
        && event.chatId === chatId
        && event.control.queue.pause?.kind === 'queued-turn-failed'
      ));
      const dispatchEventIndex = failureEvents.findIndex((event) => (
        event.type === 'queue-dispatching'
        && event.chatId === chatId
        && event.content === 'failure-b'
      ));
      const processingStoppedIndex = failureEvents.findIndex((event, index) => (
        index > dispatchEventIndex
        && event.type === 'chat-processing-updated'
        && event.chatId === chatId
        && event.isProcessing === false
      ));
      const terminalEventIndex = failureEvents.findIndex((event) => (
        event.type === 'agent-run-failed' && event.chatId === chatId
      ));
      expect(pauseEventIndex).toBeGreaterThanOrEqual(0);
      expect(dispatchEventIndex).toBeGreaterThanOrEqual(0);
      expect(processingStoppedIndex).toBeGreaterThan(dispatchEventIndex);
      expect(terminalEventIndex).toBeGreaterThan(pauseEventIndex);
      expect(terminalEventIndex).toBeGreaterThan(processingStoppedIndex);
      expect(failed.clientRequestId).toBeString();
      const queue = (await fixture.client.getExecutionControl(chatId)).queue;
      expect(queue.pause).toMatchObject({
        kind: 'queued-turn-failed',
        entryId: queuedB.entryId,
      });
      expect(queue.entries.map((entry) => entry.content)).toEqual(['failure-b', 'failure-c']);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'failure-a',
        'failure-b',
      ]);

      const failedEntry = queue.entries.find((entry) => entry.id === queuedB.entryId);
      if (!failedEntry) throw new Error('Failed queue entry was not retained.');
      const replaced = await fixture.client.replaceQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: failedEntry.id,
        content: 'failure-b-edited',
        expectedRevision: failedEntry.revision,
      });
      const editedEntry = replaced.control.queue.entries.find((entry) => entry.id === failedEntry.id);
      expect(editedEntry).toMatchObject({
        content: 'failure-b-edited',
        revision: failedEntry.revision + 1,
      });

		const heldEdited = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-b-edited' });
		const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-c' });
		await fixture.client.resumeQueue(chatId, replaced.control.queue.pause!.id);
      const editedRequest = await heldEdited.received;
      expect(editedRequest.body.messages.map((message) => message.content)).toEqual([
        'failure-a',
        'echo:failure-a',
        'failure-b',
        'failure-b-edited',
      ]);
      heldEdited.releaseEcho();
      await heldC.received;
      const pendingC = (await fixture.client.getMessages(chatId)).pendingUserInputs.find(
        (input) => input.content === 'failure-c',
      );
      if (!pendingC) throw new Error('Missing pending identity for failure-c.');
      expect(pendingC.clientRequestId).toBeString();
      expect(pendingC.clientMessageId).toBeString();
      expect(pendingC.turnId).toBeString();
      const pendingCTurnId = pendingC.turnId;
      const completionCursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, pendingCTurnId, {
        afterIndex: completionCursor,
      });

		expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
		expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'failure-a',
        'failure-b',
        'failure-b-edited',
        'failure-c',
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      for (const content of ['failure-a', 'failure-b', 'failure-b-edited', 'failure-c']) {
        expect(countUserContent(transcript.messages, content)).toBe(1);
      }
      const failedUser = transcript.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === 'failure-b');
      const editedUser = transcript.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === 'failure-b-edited');
      const failedRequestId = failedUser?.message.type === 'user-message'
        ? failedUser.message.metadata?.clientRequestId
        : undefined;
      const editedRequestId = editedUser?.message.type === 'user-message'
        ? editedUser.message.metadata?.clientRequestId
        : undefined;
      expect(failedRequestId).toBeString();
      expect(editedRequestId).toBeString();
      expect(editedRequestId).not.toBe(failedRequestId);
    });
  });

  test('finishes failed-turn recovery before dispatching or settling its queued successor', async () => {
    await withIntegrationFixture('failed-turn-successor-fence', async (fixture) => {
      const chatId = fixture.newChatId();
      const failedTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-fence-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'failure-fence-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await failedTurn.received;
      await fixture.client.enqueueNew(chatId, 'failure-fence-b');
      const successor = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-fence-b' });
      const cursor = fixture.client.markEvents();

      failedTurn.releaseStreamError('failed predecessor');
      const failed = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage =>
          event.type === 'agent-run-failed' && event.chatId === chatId,
        'failed predecessor terminal',
        { afterIndex: cursor },
      );
      expect(failed.error).toContain('failed predecessor');
      await successor.received;

      const events = fixture.client.events().slice(cursor);
      const failedIndex = events.findIndex((event) => (
        event.type === 'agent-run-failed' && event.chatId === chatId
      ));
      const dispatchIndex = events.findIndex((event) => (
        event.type === 'queue-dispatching' && event.chatId === chatId
      ));
      expect(failedIndex).toBeGreaterThanOrEqual(0);
      expect(dispatchIndex).toBeGreaterThan(failedIndex);
      const inFlight = await fixture.client.getMessages(chatId);
      const successorInput = inFlight.pendingUserInputs.find(
        (input) => input.content === 'failure-fence-b',
      );
      if (!successorInput) throw new Error('Missing pending successor identity.');
      expect(successorInput.deliveryStatus).toBe('accepted');
      expect(successorInput.clientRequestId).toBeString();
      expect(successorInput.clientMessageId).toBeString();
      expect(successorInput.turnId).toBeString();
      const successorTurnId = successorInput.turnId;

      const terminalCursor = fixture.client.markEvents();
      successor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, successorTurnId, {
        afterIndex: terminalCursor,
      });
      const settled = await fixture.client.getMessages(chatId);
      expect(countUserContent(settled.messages, 'failure-fence-b')).toBe(1);
      expect(settled.pendingUserInputs).toEqual([]);
    });
  });

  test('does not let a failure in one chat disturb a concurrent chat', async () => {
    await withIntegrationFixture('provider-failure-chat-isolation', async (fixture) => {
      const failedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      fixture.fakeProviders.openAi.failNextHttp({ lastUserText: 'isolated-failure' }, 500, 'boom');
      const healthy = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'isolated-healthy' });

      const failed = await fixture.client.startDirectChat({
        chatId: failedChat,
        content: 'isolated-failure',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      const healthyAccepted = await fixture.client.startDirectChat({
        chatId: healthyChat,
        content: 'isolated-healthy',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await healthy.received;
      expect((await fixture.client.waitForTurnTerminal(failedChat, failed.turnId)).type).toBe('agent-run-failed');
      const reconnect = await fixture.client.reconnectState([failedChat, healthyChat]);
      expect(reconnect.processing).toEqual({ outcome: 'snapshot', runningChatIds: [healthyChat] });
      expect((await fixture.client.getMessages(healthyChat)).pendingUserInputs).toHaveLength(1);

      const completionCursor = fixture.client.markEvents();
      healthy.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(healthyChat, healthyAccepted.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect((await fixture.client.getMessages(healthyChat)).pendingUserInputs).toEqual([]);
      const completionEvents = fixture.client.events().slice(completionCursor);
      const terminalIndex = completionEvents.findIndex((event) =>
        event.type === 'agent-run-finished' && event.chatId === healthyChat);
      const assistantIndex = completionEvents.findIndex((event) =>
        event.type === 'chat-messages'
        && event.chatId === healthyChat
        && event.messages.some((entry) => entry.message.type === 'assistant-message'));
      const persistedIndex = completionEvents.findIndex((event) =>
        event.type === 'pending-user-input-cleared'
        && event.chatId === healthyChat
        && event.clientRequestId === healthyAccepted.clientRequestId
        && event.reason === 'persisted');
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(persistedIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(assistantIndex);
      expect(terminalIndex).toBeGreaterThan(persistedIndex);
    });
  });
});
