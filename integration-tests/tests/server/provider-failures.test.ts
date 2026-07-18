import { describe, expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  QueueStateUpdatedMessage,
} from '../../../common/ws-events.js';
import { countUserContent } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('provider failures', () => {
  test('reports HTTP, SSE, empty-stream, and disconnect failures honestly', async () => {
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
          content: 'disconnect-stream',
          configure: () => fixture.fakeOpenAi.disconnectNext({ lastUserText: 'disconnect-stream' }),
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
        await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
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

  test('pauses remaining queued work after a queued provider failure', async () => {
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

      healthy.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(healthyChat, healthyAccepted.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect((await fixture.client.getMessages(healthyChat)).pendingUserInputs).toEqual([]);
    });
  });
});
