import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude background settlement', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('settles a turn whose background task completed before the result', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('BG_SETTLE_PROMPT');
    const launched = marker('BG_SETTLE_LAUNCHED');
    const finished = marker('BG_SETTLE_FINISHED');
    const successorPrompt = marker('BG_SETTLE_SUCCESSOR_PROMPT');
    const successorReply = marker('BG_SETTLE_SUCCESSOR_REPLY');
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_bg_settle', 'Bash', {
        command: 'sleep 1',
        run_in_background: true,
      }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(launched)]);
    testEnvironment.model.scriptTurn((request) => {
      const messages = JSON.stringify(request.body.messages);
      expect(messages).toContain(launched);
      expect(messages).toContain('<task-notification>');
      return [claudeText(finished)];
    });
    testEnvironment.model.scriptTurn([claudeText(successorReply)]);

    await withIntegrationFixture('claude-scripted-background-settle', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'assistant-message'
            && entry.message.content.includes(launched)),
        'scripted Claude background launch response',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
        type: 'agent-run-finished',
        chatId,
        turnId: turn.turnId,
      }));

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(chatId, successorPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([
        successorPrompt,
      ]);
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: finished,
        afterIndex: cursor,
      });
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const successorInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        successorPrompt,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(successorInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const assistant = assistantContents((await fixture.client.getMessages(chatId)).messages);
      const launchedIndex = assistant.findIndex((content) => content.includes(launched));
      const finishedIndex = assistant.findIndex((content) => content.includes(finished));
      const successorIndex = assistant.findIndex((content) => content.includes(successorReply));
      expect(launchedIndex).toBeGreaterThanOrEqual(0);
      expect(finishedIndex).toBeGreaterThan(launchedIndex);
      expect(successorIndex).toBeGreaterThan(finishedIndex);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      expect((await fixture.client.ping()).processing).toEqual({
        outcome: 'snapshot',
        chats: [],
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
