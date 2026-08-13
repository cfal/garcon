import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude queue lifecycle', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('drains a queued turn after a running tool turn', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('FIRST_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_queue_sleep', 'Bash', { command: 'sleep 5' }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(firstReply)]);
    testEnvironment.model.scriptTurn([claudeText(secondReply)]);

    await withIntegrationFixture('claude-scripted-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(chatId, secondPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([secondPrompt]);
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const secondInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        secondPrompt,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(secondInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.findIndex((content) => content.includes(firstReply))).toBeGreaterThanOrEqual(0);
      expect(assistants.findIndex((content) => content.includes(secondReply)))
        .toBeGreaterThan(assistants.findIndex((content) => content.includes(firstReply)));
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_QUEUE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
