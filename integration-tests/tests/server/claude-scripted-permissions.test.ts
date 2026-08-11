import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude permissions', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('answers AskUserQuestion through the permission channel', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('ASK_PROMPT');
    const reply = marker('ASK_REPLY');
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_ask', 'AskUserQuestion', {
        questions: [{
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: '' },
            { label: 'SQLite', description: '' },
          ],
        }],
      }),
    ]);
    testEnvironment.model.scriptTurn((request) => {
      expect(JSON.stringify(request.body.messages)).toContain('Postgres');
      return [claudeText(reply)];
    });

    await withIntegrationFixture('claude-scripted-permissions', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        // AskUserQuestion remains interactive while every other tool bypasses approval.
        permissionMode: 'bypassPermissions',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        () => true,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') {
        throw new Error('Scripted AskUserQuestion permission request was not found.');
      }
      const permissionRequestId = permission.message.permissionRequestId;
      expect(permission.message.requestedTool.type).toBe('ask-user-question-tool-use');

      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
        allow: true,
        alwaysAllow: false,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{
            questionId: 'Which database?',
            selectedOptionIds: ['Postgres'],
          }],
        },
      });
      expect(decision.status).toBe('accepted');
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.some((entry) =>
        entry.message.type === 'permission-resolved'
        && entry.message.permissionRequestId === permissionRequestId
        && entry.message.allowed)).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
