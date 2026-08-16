import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
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

const PERMISSION_OCCURRENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

      const control = {
        serverInstanceId: (await fixture.client.getChatSnapshot(chatId, 0))
          .transientFeed.serverInstanceId,
        chatId,
        runId: permission.runId,
        id: permission.id,
        incarnation: permission.incarnation,
      };
      await expect(fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
        allow: true,
        alwaysAllow: false,
        control: { ...control, incarnation: crypto.randomUUID() },
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{
            questionId: 'Which database?',
            selectedOptionIds: ['SQLite'],
          }],
        },
      })).rejects.toMatchObject({
        status: 409,
        body: {
          errorCode: 'VALIDATION_FAILED',
          retryable: false,
        },
      });
      expect(messagesOfType(
        (await fixture.client.getMessages(chatId)).messages,
        'permission-resolved',
      )).toEqual([]);

      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
        allow: true,
        alwaysAllow: false,
        control,
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

  test('[TLV5-PERM.07-CLAUDE-SCRIPTED-01] keeps permission history inert after a server restart', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('STALE_PERMISSION_PROMPT');
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_stale_permission', 'AskUserQuestion', {
        questions: [{
          question: 'Keep this permission active?',
          header: 'Permission',
          multiSelect: false,
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        }],
      }),
    ]);

    await withIntegrationFixture('claude-stale-permission-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        () => true,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') {
        throw new Error('Scripted stale permission request was not found.');
      }
      expect(permission.incarnation).toMatch(PERMISSION_OCCURRENCE_UUID);
      const beforeRestart = await fixture.client.getChatSnapshot(chatId, 0);
      const staleControl = {
        serverInstanceId: beforeRestart.transientFeed.serverInstanceId,
        chatId,
        runId: permission.runId,
        id: permission.id,
        incarnation: permission.incarnation,
      };

      await fixture.restartGarcon();

      const restarted = await fixture.client.getChatSnapshot(chatId, 0);
      expect(restarted.transientFeed.serverInstanceId).not.toBe(staleControl.serverInstanceId);
      expect(restarted.transientFeed.rows).toEqual([]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([
        expect.objectContaining({
          permissionRequestId: permission.message.permissionRequestId,
        }),
      ]);

      await expect(fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId: permission.message.permissionRequestId,
        allow: false,
        alwaysAllow: false,
        control: staleControl,
      })).rejects.toMatchObject({
        status: 409,
        body: {
          errorCode: 'VALIDATION_FAILED',
          retryable: false,
        },
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
