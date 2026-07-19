import { describe, expect, test } from 'bun:test';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  countUserContent,
  userMessages,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Anthropic provider failures', () => {
  test('reports protocol failures without fabricating assistant turns and recovers', async () => {
    await withIntegrationFixture('anthropic-provider-failures', async (fixture) => {
      const failures = [
        {
          content: 'anthropic-http-401',
          configure: () => fixture.fakeProviders.anthropic.failNextHttp(
            { lastUserText: 'anthropic-http-401' },
            401,
            'unauthorized',
          ),
        },
        {
          content: 'anthropic-http-429',
          configure: () => fixture.fakeProviders.anthropic.failNextHttp(
            { lastUserText: 'anthropic-http-429' },
            429,
            'rate limited',
          ),
        },
        {
          content: 'anthropic-http-500',
          configure: () => fixture.fakeProviders.anthropic.failNextHttp(
            { lastUserText: 'anthropic-http-500' },
            500,
            'upstream failed',
          ),
        },
        {
          content: 'anthropic-stream-error',
          configure: () => fixture.fakeProviders.anthropic.failNextStream(
            { lastUserText: 'anthropic-stream-error' },
            'stream failed',
          ),
        },
        {
          content: 'anthropic-empty-stream',
          configure: () => fixture.fakeProviders.anthropic.respondEmptyNext({
            lastUserText: 'anthropic-empty-stream',
          }),
        },
        {
          content: 'anthropic-truncated-stream',
          configure: () => fixture.fakeProviders.anthropic.truncateNextStream({
            lastUserText: 'anthropic-truncated-stream',
          }),
        },
      ];

      for (const failure of failures) {
        const chatId = fixture.newChatId();
        failure.configure();
        const cursor = fixture.client.markEvents();
        const accepted = await fixture.client.startDirectChat({
          chatId,
          content: failure.content,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.anthropic,
        });
        const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
          afterIndex: cursor,
        });
        expect(terminal).toMatchObject({
          type: 'agent-run-failed',
          chatId,
          turnId: accepted.turnId,
        });
        expect((terminal as AgentRunFailedMessage).error).toBeString();

        const failedTranscript = await fixture.client.getMessages(chatId);
        expect(countUserContent(failedTranscript.messages, failure.content)).toBe(1);
        expect(assistantContents(failedTranscript.messages)).not.toContain(
          `echo:${failure.content}`,
        );
        expect(userMessages(failedTranscript.messages).find((message) =>
          message.content === failure.content)?.metadata).toMatchObject({
            turnId: accepted.turnId,
          });

        const retryContent = `${failure.content}-retry`;
        const retry = await fixture.client.runDirectChat({
          chatId,
          content: retryContent,
          agent: fixture.directAgents.anthropic,
        });
        expect((await fixture.client.waitForTurnTerminal(chatId, retry.turnId)).type).toBe(
          'agent-run-finished',
        );
        const recovered = await fixture.client.getMessages(chatId);
        expect(assistantContents(recovered.messages)).toContain(`echo:${retryContent}`);
      }

      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(failures.length * 2);
      expect(fixture.fakeProviders.openAi.requests()).toEqual([]);
    });
  });
});
