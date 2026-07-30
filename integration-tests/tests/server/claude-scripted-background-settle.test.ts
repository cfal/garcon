import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

    await withIntegrationFixture('claude-scripted-background-settle', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
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
