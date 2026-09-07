import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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
      const permissionOccurrenceId = permission.message.permissionOccurrenceId;
      expect(permission.message.requestedTool.type).toBe('ask-user-question-tool-use');

      const control = {
        serverInstanceId: (await fixture.client.getChatSnapshot(chatId, 0))
          .transientFeed.serverInstanceId,
        chatId,
        runId: permission.runId,
        permissionOccurrenceId: permission.permissionOccurrenceId,
      };
      await expect(fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
        control: { ...control, serverInstanceId: crypto.randomUUID() },
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
        permissionOccurrenceId,
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
        && entry.message.permissionOccurrenceId === permissionOccurrenceId
        && entry.message.allowed)).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);

  test('executes an allowed Bash command and records its successful result', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('ALLOWED_BASH_PROMPT');
    const output = marker('ALLOWED_BASH_OUTPUT');
    const reply = marker('ALLOWED_BASH_REPLY');
    const outputName = '.claude-scripted-allowed-bash';
    const command = `printf %s ${output} > ${outputName} && cat ${outputName}`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_allowed_bash', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-allowed-bash', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request'
          && row.message.requestedTool.type === 'bash-tool-use'
          && row.message.requestedTool.command === command,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') {
        throw new Error('Scripted Bash permission request was not found.');
      }
      const permissionOccurrenceId = permission.message.permissionOccurrenceId;

      expect((await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
      })).status).toBe('accepted');
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const resolution = messagesOfType(transcript.messages, 'permission-resolved').find(
        (message) => message.permissionOccurrenceId === permissionOccurrenceId,
      );
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash?.toolId,
      );
      expect(resolution?.allowed).toBe(true);
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(output);
      expect(await Bun.file(join(fixture.dirs.project, outputName)).text()).toBe(output);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);

  test('records a denied Bash result without executing the command', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = marker('DENIED_BASH_PROMPT');
    const reply = marker('DENIED_BASH_REPLY');
    const outputName = '.claude-scripted-denied-bash';
    const command = `touch ${outputName}`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_denied_bash', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-denied-bash', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request'
          && row.message.requestedTool.type === 'bash-tool-use'
          && row.message.requestedTool.command === command,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') {
        throw new Error('Scripted Bash permission request was not found.');
      }
      const permissionOccurrenceId = permission.message.permissionOccurrenceId;

      expect((await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId,
        allow: false,
        alwaysAllow: false,
      })).status).toBe('accepted');
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const resolution = messagesOfType(transcript.messages, 'permission-resolved').find(
        (message) => message.permissionOccurrenceId === permissionOccurrenceId,
      );
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash?.toolId,
      );
      expect(resolution?.allowed).toBe(false);
      expect(result?.isError).toBe(true);
      expect(await Bun.file(join(fixture.dirs.project, outputName)).exists()).toBe(false);
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
      expect(permission.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
      const beforeRestart = await fixture.client.getChatSnapshot(chatId, 0);
      const staleControl = {
        serverInstanceId: beforeRestart.transientFeed.serverInstanceId,
        chatId,
        runId: permission.runId,
        permissionOccurrenceId: permission.permissionOccurrenceId,
      };

      await fixture.restartGarcon();

      const restarted = await fixture.client.getChatSnapshot(chatId, 0);
      expect(restarted.transientFeed.serverInstanceId).not.toBe(staleControl.serverInstanceId);
      expect(restarted.transientFeed.rows).toEqual([]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([
        expect.objectContaining({
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
        }),
      ]);

      await expect(fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
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
