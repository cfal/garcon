import { describe, expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  ChatExecutionControlUpdatedMessage,
} from '../../../common/ws-events.js';
import { countUserContent, userMessages } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('provider failures', () => {
  test('records HTTP, SSE, empty-stream, and truncated-stream failures honestly', async () => {
    await withIntegrationFixture('provider-failure-modes', async (fixture) => {
      const chatId = fixture.newChatId();
      const failures = [
        {
          content: 'http-401',
          configure: () => fixture.fakeProviders.openAi.failNextHttp(
            { lastUserText: 'http-401' },
            401,
            'unauthorized',
          ),
        },
        {
          content: 'http-429',
          configure: () => fixture.fakeProviders.openAi.failNextHttp(
            { lastUserText: 'http-429' },
            429,
            'rate limited',
          ),
        },
        {
          content: 'http-500',
          configure: () => fixture.fakeProviders.openAi.failNextHttp(
            { lastUserText: 'http-500' },
            500,
            'upstream failed',
          ),
        },
        {
          content: 'sse-error',
          configure: () => fixture.fakeProviders.openAi.failNextStream(
            { lastUserText: 'sse-error' },
            'stream failed',
          ),
        },
        {
          content: 'empty-stream',
          configure: () => fixture.fakeProviders.openAi.respondEmptyNext(
            { lastUserText: 'empty-stream' },
          ),
        },
        {
          content: 'truncated-stream',
          configure: () => fixture.fakeProviders.openAi.truncateNextStream(
            { lastUserText: 'truncated-stream' },
          ),
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
        expect(userMessages(transcript.messages).find((message) =>
          message.content === failure.content)?.metadata).toMatchObject({
            clientMessageId,
          });
        expect(userMessages(transcript.messages).find((message) =>
          message.content === failure.content)?.metadata?.clientRequestId).toBeUndefined();
        expect(userMessages(transcript.messages).find((message) =>
          message.content === failure.content)?.metadata?.turnId).toBeUndefined();
        expect(transcript.resendCandidates).toEqual([]);

        const events = fixture.client.eventsSince(cursor);
        const userIndex = events.findIndex((event) =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === failure.content));
        const terminalIndex = events.findIndex((event) =>
          event.type === 'agent-run-failed'
          && event.chatId === chatId
          && event.turnId === accepted.turnId);
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(terminalIndex).toBeGreaterThan(userIndex);
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
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type)
        .toBe('agent-run-finished');
      expect((await fixture.client.getMessages(chatId)).messages.find((entry) =>
        entry.message.type === 'assistant-message')?.message).toMatchObject({
        type: 'assistant-message',
        content: 'valid-after-malformed',
      });
    });
  });

  test('removes a failed queue entry and pauses its undispatched successor', async () => {
    await withIntegrationFixture('queued-provider-failure', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-a' });
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'failure-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'failure-b');
      await fixture.client.enqueueNew(chatId, 'failure-c');
      fixture.fakeProviders.openAi.failNextHttp(
        { lastUserText: 'failure-b' },
        500,
        'queued turn failed',
      );
      const failureCursor = fixture.client.markEvents();
      heldA.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, first.turnId, { afterIndex: failureCursor });

      const failed = await fixture.client.waitForEvent(
        (event): event is AgentRunFailedMessage =>
          event.type === 'agent-run-failed' && event.chatId === chatId,
        'queued provider failure',
        { afterIndex: failureCursor },
      );
      expect(failed.error).toContain('500');
      await fixture.client.waitForEvent(
        (event): event is ChatExecutionControlUpdatedMessage =>
          event.type === 'chat-execution-control-updated'
          && event.chatId === chatId
          && event.control.queue.pause?.kind === 'queued-turn-failed',
        'queued failure pause',
        { afterIndex: failureCursor },
      );

      const paused = await fixture.client.getExecutionControl(chatId);
      expect(paused.queue.pause).toMatchObject({
        kind: 'queued-turn-failed',
        entryId: queuedB.entryId,
      });
      expect(paused.queue.entries.map((entry) => entry.content)).toEqual(['failure-c']);
      expect(countUserContent((await fixture.client.getMessages(chatId)).messages, 'failure-b'))
        .toBe(1);

      const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'failure-c' });
      const resumeCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, paused.queue.pause!.id);
      const requestC = await heldC.received;
      expect(requestC.body.messages.map((message) => message.content)).toEqual([
        'failure-a',
        'echo:failure-a',
        'failure-b',
        'failure-c',
      ]);
      const committedC = await fixture.client.waitForCommittedUserInput(
        chatId,
        'failure-c',
        { afterIndex: resumeCursor },
      );
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(committedC) + 1,
      });

      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'failure-a',
        'failure-b',
        'failure-c',
      ]);
    });
  });

  test('commits a failed turn before dispatching its queued successor', async () => {
    await withIntegrationFixture('failed-turn-successor-order', async (fixture) => {
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
      const committed = await fixture.client.waitForCommittedUserInput(
        chatId,
        'failure-fence-b',
        { afterIndex: cursor },
      );
      const events = fixture.client.eventsSince(cursor);
      expect(events.findIndex((event) => event === failed)).toBeLessThan(
        events.findIndex((event) => event === committed),
      );

      successor.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(committed) + 1,
      });
      expect(countUserContent((await fixture.client.getMessages(chatId)).messages, 'failure-fence-b'))
        .toBe(1);
    });
  });

  test('does not let a failure in one chat disturb a concurrent chat', async () => {
    await withIntegrationFixture('provider-failure-chat-isolation', async (fixture) => {
      const failedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      fixture.fakeProviders.openAi.failNextHttp(
        { lastUserText: 'isolated-failure' },
        500,
        'boom',
      );
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
      expect((await fixture.client.waitForTurnTerminal(failedChat, failed.turnId)).type)
        .toBe('agent-run-failed');
      expect((await fixture.client.reconnectState([failedChat, healthyChat])).processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId: healthyChat, phase: 'running', retry: null }],
      });

      const cursor = fixture.client.markEvents();
      healthy.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(
        healthyChat,
        healthyAccepted.turnId,
        { afterIndex: cursor },
      )).type).toBe('agent-run-finished');
      expect(countUserContent(
        (await fixture.client.getMessages(healthyChat)).messages,
        'isolated-healthy',
      )).toBe(1);
    });
  });
});
