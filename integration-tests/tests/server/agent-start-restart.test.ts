import { describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import type { ConfiguredDirectTestAgent } from '../../support/garcon-client.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

describe('agent-created chat result delivery and restart semantics', () => {
  test('records queue admission before immediate idle-source result delivery', async () => {
    await withIntegrationFixture('agent-start-idle-result-delivery', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourcePrompt = 'Start one sub-agent after this source turn finishes.';
      const childPrompt = 'Complete after the source chat becomes idle.';
      const ref = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
      const command = startAgentCommand(fixture.directAgents.openAi, childPrompt, [ref]);

      const sourceTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: sourcePrompt });
      const childTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: childPrompt });
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: sourcePrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await sourceTurn.received;
      sourceTurn.releaseText(command);

      await childTurn.received;
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        source.turnId,
        { afterIndex: sourceCursor },
      )).type).toBe('agent-run-finished');

      const resultTurn = fixture.fakeProviders.openAi.holdNext({});
      const resultCursor = fixture.client.markEvents();
      childTurn.releaseText('Created child completed.');
      const resultRequest = await resultTurn.received;
      const children = await subAgentChats(fixture);
      expect(children).toHaveLength(1);
      const resultContent = `<garcon-create-chat-result ref="${ref}" error="false" msg="created" chat-id="${children[0]!.id}" />`;
      expect(resultRequest.lastUserText).toBe(resultContent);

      const sourceTranscript = await fixture.client.getMessages(sourceChatId);
      const outcomes = messagesOfType(sourceTranscript.messages, 'transcript-notice').filter(
        (message) => message.detail?.type === 'sub-agent-start-outcome',
      );
      expect(outcomes.map((message) => (
        message.detail?.type === 'sub-agent-start-outcome'
          ? message.detail.deliveryStatus
          : null
      ))).toEqual(['queued', 'delivered']);
      expect(userContents(sourceTranscript.messages)).toEqual([sourcePrompt]);

      resultTurn.releaseText('Result delivery completed.');
      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        undefined,
        { afterIndex: resultCursor },
      )).type).toBe('agent-run-finished');
    });
  }, 120_000);

  test('drops queued result input on restart while retaining the created chat and queued audit', async () => {
    await withIntegrationFixture('agent-start-result-restart-loss', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourcePrompt = 'Start one sub-agent while result delivery is paused.';
      const childPrompt = 'Return one child response before result delivery.';
      const queuedUserPrompt = 'This queued user input is process-ephemeral too.';
      const afterRestartPrompt = 'Continue without recovering queued result control.';
      const ref = '69b623a7-757e-49f6-93b8-4b7ea1bc569b';
      const command = startAgentCommand(fixture.directAgents.openAi, childPrompt, [ref]);

      const sourceTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: sourcePrompt });
      const childTurn = fixture.fakeProviders.openAi.holdNext({ lastUserText: childPrompt });
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: sourcePrompt,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await sourceTurn.received;
      await fixture.client.enqueueNew(sourceChatId, queuedUserPrompt);
      await fixture.client.pauseQueue(sourceChatId);
      sourceTurn.releaseText(command);

      await childTurn.received;
      childTurn.releaseText('Created child completed.');
      const outcomeEvent = await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages'
          && event.chatId === sourceChatId
          && event.messages.some((entry) => (
            entry.message.type === 'transcript-notice'
            && entry.message.detail?.type === 'sub-agent-start-outcome'
            && entry.message.detail.deliveryStatus === 'queued'
          )),
        'queued sub-agent result outcome',
        { afterIndex: sourceCursor },
      );
      const queuedOutcome = outcomeEvent.messages
        .map((entry) => entry.message)
        .find((message) => message.type === 'transcript-notice'
          && message.detail?.type === 'sub-agent-start-outcome');
      if (queuedOutcome?.type !== 'transcript-notice'
        || queuedOutcome.detail?.type !== 'sub-agent-start-outcome') {
        throw new Error('Queued sub-agent outcome was not present in its commit event.');
      }
      const created = queuedOutcome.detail.results[0];
      if (!created || created.error) throw new Error('Created sub-agent result was missing.');
      const childChatId = created.chatId;
      const resultContent = `<garcon-create-chat-result ref="${ref}" error="false" msg="created" chat-id="${childChatId}" />`;

      expect((await fixture.client.waitForTurnTerminal(
        sourceChatId,
        source.turnId,
        { afterIndex: sourceCursor },
      )).type).toBe('agent-run-finished');
      const requestCountBeforeRestart = fixture.fakeProviders.openAi.requests().length;

      await fixture.crashAndRestartGarcon();

      expect((await subAgentChats(fixture)).map((chat) => chat.id)).toContain(childChatId);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCountBeforeRestart);
      expect((await fixture.client.getExecutionControl(sourceChatId)).queue).toMatchObject({
        entries: [],
        pause: null,
      });

      const restartedSource = await fixture.client.getMessages(sourceChatId);
      const outcomes = messagesOfType(restartedSource.messages, 'transcript-notice').filter(
        (message) => message.detail?.type === 'sub-agent-start-outcome',
      );
      expect(outcomes).toEqual([
        expect.objectContaining({
          detail: expect.objectContaining({
            type: 'sub-agent-start-outcome',
            deliveryStatus: 'queued',
          }),
        }),
      ]);

      const postRestartTurn = fixture.fakeProviders.openAi.holdNext({
        lastUserText: afterRestartPrompt,
      });
      const postRestart = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: afterRestartPrompt,
        agent: fixture.directAgents.openAi,
      });
      const postRestartRequest = await postRestartTurn.received;
      expect(postRestartRequest.lastUserText).toBe(afterRestartPrompt);
      expect(JSON.stringify(postRestartRequest)).not.toContain(resultContent);
      expect(JSON.stringify(postRestartRequest)).not.toContain(queuedUserPrompt);
      postRestartTurn.releaseText('Restart completed without queued result recovery.');
      expect((await fixture.client.waitForTurnTerminal(sourceChatId, postRestart.turnId)).type)
        .toBe('agent-run-finished');
    });
  }, 120_000);
});

function startAgentCommand(
  agent: ConfiguredDirectTestAgent,
  prompt: string,
  refs: readonly string[],
): string {
  return [
    '<garcon-start-agent>',
    '<garcon-prompt>',
    prompt,
    '</garcon-prompt>',
    ...refs.map((ref) => (
      `<garcon-create-chat-params ref="${ref}" agent="${agent.agentId}" provider="${agent.provider.providerId}" endpoint="${agent.provider.endpointId}" model="${agent.provider.model}" reasoning-effort="none" />`
    )),
    '</garcon-start-agent>',
  ].join('\n');
}

async function subAgentChats(
  fixture: IntegrationFixture,
) {
  return (await fixture.client.listChats()).sessions.filter((chat) => chat.tags.includes('sub-agent'));
}
