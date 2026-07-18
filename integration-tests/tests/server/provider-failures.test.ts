import { describe, expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  QueueStateUpdatedMessage,
} from '../../../common/ws-events.js';
import { countUserContent } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('provider failures', () => {
  test('reports HTTP, SSE, empty-stream, and truncated-stream failures honestly', async () => {
    await withIntegrationFixture('provider-failure-modes', async (fixture) => {
      const chatId = fixture.newChatId();
      const failures = [
        {
          content: 'http-401',
          configure: () => fixture.fakeOpenAi.failNextHttp({ lastUserText: 'http-401' }, 401, 'unauthorized'),
        },
        {
          content: 'http-429',
          configure: () => fixture.fakeOpenAi.failNextHttp({ lastUserText: 'http-429' }, 429, 'rate limited'),
        },
        {
          content: 'http-500',
          configure: () => fixture.fakeOpenAi.failNextHttp({ lastUserText: 'http-500' }, 500, 'upstream failed'),
        },
        {
          content: 'sse-error',
          configure: () => fixture.fakeOpenAi.failNextStream({ lastUserText: 'sse-error' }, 'stream failed'),
        },
        {
          content: 'empty-stream',
          configure: () => fixture.fakeOpenAi.respondEmptyNext({ lastUserText: 'empty-stream' }),
        },
        {
          content: 'truncated-stream',
          configure: () => fixture.fakeOpenAi.truncateNextStream({ lastUserText: 'truncated-stream' }),
        },
      ];

      for (const [index, failure] of failures.entries()) {
        failure.configure();
        const cursor = fixture.client.markEvents();
        const accepted = index === 0
          ? await fixture.client.startDirectChat({
              chatId,
              content: failure.content,
              projectPath: fixture.dirs.project,
              provider: fixture.provider,
            })
          : await fixture.client.runDirectChat({
              chatId,
              content: failure.content,
              provider: fixture.provider,
            });
        expect(accepted.status).toBe('accepted');
        const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: cursor,
        });
        expect(terminal.type).toBe('agent-run-failed');
        expect((terminal as AgentRunFailedMessage).error).toBeString();
        expect(countUserContent((await fixture.client.getMessages(chatId)).messages, failure.content)).toBe(1);
      }
      expect(fixture.fakeOpenAi.requests()).toHaveLength(failures.length);
    });
  });

  test('skips malformed SSE data and retains a later valid completion', async () => {
    await withIntegrationFixture('provider-malformed-sse', async (fixture) => {
      const chatId = fixture.newChatId();
      fixture.fakeOpenAi.respondMalformedThenTextNext(
        { lastUserText: 'malformed-then-valid' },
        'valid-after-malformed',
      );
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'malformed-then-valid',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
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
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'failure-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'failure-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'failure-b');
      await fixture.client.enqueueNew(chatId, 'failure-c');
      fixture.fakeOpenAi.failNextHttp({ lastUserText: 'failure-b' }, 500, 'queued turn failed');
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
        (event): event is QueueStateUpdatedMessage => event.type === 'queue-state-updated'
          && event.chatId === chatId
          && event.queue.pause?.kind === 'queued-turn-failed',
        'queued failure pause',
        { afterIndex: failureCursor },
      );
      const failureEvents = fixture.client.events().slice(failureCursor);
      const pauseEventIndex = failureEvents.findIndex((event) => (
        event.type === 'queue-state-updated'
        && event.chatId === chatId
        && event.queue.pause?.kind === 'queued-turn-failed'
      ));
      const terminalEventIndex = failureEvents.findIndex((event) => (
        event.type === 'agent-run-failed' && event.chatId === chatId
      ));
      expect(pauseEventIndex).toBeGreaterThanOrEqual(0);
      expect(terminalEventIndex).toBeGreaterThan(pauseEventIndex);
      expect(failed.clientRequestId).toBeString();
      const queue = await fixture.client.getQueue(chatId);
      expect(queue.pause).toMatchObject({
        kind: 'queued-turn-failed',
        entryId: queuedB.entryId,
      });
      expect(queue.entries.map((entry) => entry.content)).toEqual(['failure-b', 'failure-c']);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
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
      const editedEntry = replaced.queue.entries.find((entry) => entry.id === failedEntry.id);
      expect(editedEntry).toMatchObject({
        content: 'failure-b-edited',
        revision: failedEntry.revision + 1,
      });

      const heldEdited = fixture.fakeOpenAi.holdNext({ lastUserText: 'failure-b-edited' });
      const heldC = fixture.fakeOpenAi.holdNext({ lastUserText: 'failure-c' });
      await fixture.client.resumeQueue(chatId, replaced.queue.pause!.id);
      const editedRequest = await heldEdited.received;
      expect(editedRequest.body.messages.map((message) => message.content)).toEqual([
        'failure-a',
        'echo:failure-a',
        'failure-b',
        'failure-b-edited',
      ]);
      heldEdited.releaseEcho();
      await heldC.received;
      const completionCursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: completionCursor });

      expect((await fixture.client.getQueue(chatId)).entries).toEqual([]);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
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
      const failedTurn = fixture.fakeOpenAi.holdNext({ lastUserText: 'failure-fence-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'failure-fence-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await failedTurn.received;
      await fixture.client.enqueueNew(chatId, 'failure-fence-b');
      const successor = fixture.fakeOpenAi.holdNext({ lastUserText: 'failure-fence-b' });
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
      expect(inFlight.pendingUserInputs.find((input) => input.content === 'failure-fence-b'))
        .toMatchObject({ deliveryStatus: 'accepted' });

      const terminalCursor = fixture.client.markEvents();
      successor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: terminalCursor });
      const settled = await fixture.client.getMessages(chatId);
      expect(countUserContent(settled.messages, 'failure-fence-b')).toBe(1);
      expect(settled.pendingUserInputs).toEqual([]);
    });
  });

  test('does not let a failure in one chat disturb a concurrent chat', async () => {
    await withIntegrationFixture('provider-failure-chat-isolation', async (fixture) => {
      const failedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      fixture.fakeOpenAi.failNextHttp({ lastUserText: 'isolated-failure' }, 500, 'boom');
      const healthy = fixture.fakeOpenAi.holdNext({ lastUserText: 'isolated-healthy' });

      const failed = await fixture.client.startDirectChat({
        chatId: failedChat,
        content: 'isolated-failure',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      const healthyAccepted = await fixture.client.startDirectChat({
        chatId: healthyChat,
        content: 'isolated-healthy',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
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
