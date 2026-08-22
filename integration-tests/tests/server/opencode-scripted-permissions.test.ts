import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Permission flows through the real binary: Garcon answers OpenCode's permission and question
// blockers while manualBypass remains automatic only for ordinary tool approval.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;
const PERMISSION_OCCURRENCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describeOnLinux('scripted OpenCode permissions', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('asks in default mode, resolves allow-once, executes the tool, and continues', async () => {
    const testEnvironment = requireEnvironment();
    const toolMarker = marker('ALLOWED_OUTPUT');
    const reply = marker('ALLOWED_REPLY');
    const command = `printf %s ${toolMarker} > allowed-marker.txt`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_allowed', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-permission-allow', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('ALLOWED_PROMPT'),
        permissionMode: 'default',
      }));

      const permissionOccurrenceId = await waitForBashPermissionRequest(
        fixture.client,
        chatId,
        cursor,
      );
      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
      });
      expect(decision.status).toBe('accepted');

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(await readMarker(fixture.dirs.project, 'allowed-marker.txt')).toBe(toolMarker);

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.some((entry) =>
        entry.message.type === 'permission-resolved'
        && entry.message.permissionOccurrenceId === permissionOccurrenceId
        && entry.message.allowed)).toBe(true);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      if (!bash) throw new Error('Allowed OpenCode shell tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('resolves rejection without executing the command or wedging the chat', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('REJECTED_REPLY');
    const command = `printf %s nope > rejected-marker.txt`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_rejected', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-permission-reject', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('REJECTED_PROMPT'),
        permissionMode: 'default',
      }));

      const permissionOccurrenceId = await waitForBashPermissionRequest(
        fixture.client,
        chatId,
        cursor,
      );
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId,
        allow: false,
        alwaysAllow: false,
      });

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      await expect(access(join(fixture.dirs.project, 'rejected-marker.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.some((entry) =>
        entry.message.type === 'permission-resolved'
        && entry.message.permissionOccurrenceId === permissionOccurrenceId
        && !entry.message.allowed)).toBe(true);
      const rejectedTool = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      if (!rejectedTool) throw new Error('Rejected OpenCode shell tool use was not rendered.');
      const rejectedResult = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === rejectedTool.toolId,
      );
      expect(rejectedResult?.isError).toBe(true);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('answers the question tool through the permission channel in bypass mode', async () => {
    const testEnvironment = requireEnvironment();
    const reply = 'SCRIPTED_OPENCODE_QUESTION_ANSWERED_REPLY';
    testEnvironment.model.scriptTurn([chatCompletionsToolUse(
      'call_question_answered',
      'question',
      {
        questions: [
          {
            header: 'Mode',
            question: 'Which mode?',
            options: [
              { label: 'Fast', description: 'Complete quickly.' },
              { label: 'Careful', description: 'Check boundaries.' },
            ],
          },
          {
            header: 'Checks',
            question: 'Which checks?',
            multiple: true,
            options: [
              { label: 'Unit', description: 'Run unit tests.' },
              { label: 'Integration', description: 'Run integration tests.' },
            ],
          },
        ],
      },
    )]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-question-answer', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'SCRIPTED_OPENCODE_QUESTION_ANSWERED_PROMPT',
        permissionMode: 'bypassPermissions',
      }));

      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        () => true,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (
        permission.message.type !== 'permission-request'
        || permission.message.requestedTool.type !== 'ask-user-question-tool-use'
      ) {
        throw new Error('OpenCode question permission request was not found.');
      }
      expect(permission.message.permissionOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
      expect(permission.message.permissionOccurrenceId).not.toBe('call_question_answered');
      expect(permission.message.requestedTool.questions).toEqual([
        {
          id: 'question-1',
          prompt: 'Which mode?',
          header: 'Mode',
          options: [
            {
              id: 'question-1-option-1',
              label: 'Fast',
              description: 'Complete quickly.',
            },
            {
              id: 'question-1-option-2',
              label: 'Careful',
              description: 'Check boundaries.',
            },
          ],
          allowMultiple: false,
        },
        {
          id: 'question-2',
          prompt: 'Which checks?',
          header: 'Checks',
          options: [
            {
              id: 'question-2-option-1',
              label: 'Unit',
              description: 'Run unit tests.',
            },
            {
              id: 'question-2-option-2',
              label: 'Integration',
              description: 'Run integration tests.',
            },
          ],
          allowMultiple: true,
        },
      ]);

      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [
            { questionId: 'question-1', selectedOptionIds: ['question-1-option-2'] },
            {
              questionId: 'question-2',
              selectedOptionIds: ['question-2-option-1', 'question-2-option-2'],
            },
          ],
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
      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.toolResults).toEqual([{
        toolCallId: 'call_question_answered',
        content: expect.stringContaining('"Which mode?"="Careful"'),
      }]);

      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'ask-user-question-tool-use')).toHaveLength(1);
      expect(messagesOfType(transcript.messages, 'unknown-tool-use')).toEqual([]);
      expect(messagesOfType(transcript.messages, 'permission-resolved')).toEqual([
        expect.objectContaining({
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
          allowed: true,
        }),
      ]);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('rejects Skip without letting manual bypass hide the question', async () => {
    const testEnvironment = requireEnvironment();
    const reply = 'SCRIPTED_OPENCODE_QUESTION_SKIPPED_REPLY';
    testEnvironment.model.scriptTurn([chatCompletionsToolUse(
      'call_question_skipped',
      'question',
      {
        questions: [{
          header: 'Continue',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue.' }],
        }],
      },
    )]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-question-skip', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'SCRIPTED_OPENCODE_QUESTION_SKIPPED_PROMPT',
        permissionMode: 'manualBypass',
      }));

      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        () => true,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (
        permission.message.type !== 'permission-request'
        || permission.message.requestedTool.type !== 'ask-user-question-tool-use'
      ) {
        throw new Error('OpenCode question permission request was not found.');
      }
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: false,
        alwaysAllow: false,
        response: {
          type: 'ask-user-question-response',
          outcome: 'skipped',
          reason: 'User skipped question',
        },
      });

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-finished');

      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: 'SCRIPTED_OPENCODE_QUESTION_SKIPPED_RECOVERY_PROMPT',
        permissionMode: 'manualBypass',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: reply,
        afterIndex: recoveryCursor,
      });
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'ask-user-question-tool-use')).toHaveLength(1);
      expect(messagesOfType(transcript.messages, 'unknown-tool-use')).toEqual([]);
      expect(messagesOfType(transcript.messages, 'permission-resolved')).toEqual([
        expect.objectContaining({
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
          allowed: false,
        }),
      ]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('rejects an empty question request instead of leaving the turn blocked', async () => {
    const testEnvironment = requireEnvironment();
    testEnvironment.model.scriptTurn([chatCompletionsToolUse(
      'call_question_empty',
      'question',
      { questions: [] },
    )]);
    const requestCursor = testEnvironment.model.markRequests();

    await withIntegrationFixture('opencode-question-empty', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'SCRIPTED_OPENCODE_EMPTY_QUESTION_PROMPT',
        permissionMode: 'bypassPermissions',
      }));

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-finished');
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('auto-replies once in manualBypass without emitting a user permission row', async () => {
    const testEnvironment = requireEnvironment();
    const toolMarker = marker('MANUAL_BYPASS_OUTPUT');
    const reply = marker('MANUAL_BYPASS_REPLY');
    const command = `printf %s ${toolMarker} > manual-bypass-marker.txt`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_manual_bypass', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-permission-manual-bypass', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('MANUAL_BYPASS_PROMPT'),
        permissionMode: 'manualBypass',
      }));

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(await readMarker(fixture.dirs.project, 'manual-bypass-marker.txt'))
        .toBe(toolMarker);

      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([]);
      expect(messagesOfType(transcript.messages, 'permission-resolved')).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('emits no permission request in bypassPermissions mode', async () => {
    const testEnvironment = requireEnvironment();
    const toolMarker = marker('BYPASS_OUTPUT');
    const reply = marker('BYPASS_REPLY');
    const command = `printf %s ${toolMarker} > bypass-marker.txt`;
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_bypass', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    const requestCursor = testEnvironment.model.markRequests();
    await withIntegrationFixture('opencode-permission-bypass', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('BYPASS_PROMPT'),
        permissionMode: 'bypassPermissions',
      }));

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expect(await readMarker(fixture.dirs.project, 'bypass-marker.txt')).toBe(toolMarker);

      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'permission-request')).toEqual([]);
      expect(fixture.client.eventsSince(cursor).some((event) =>
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.messages.some((entry) => entry.message.type === 'permission-request')
      )).toBe(false);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

async function waitForBashPermissionRequest(
  client: GarconTestClient,
  chatId: string,
  cursor: number,
): Promise<string> {
  const permission = await client.waitForTransientPermission(
    chatId,
    () => true,
    { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
  if (permission.message.type !== 'permission-request') {
    throw new Error('OpenCode bash permission request was not found.');
  }
  expect(permission.message.requestedTool.type).toBe('request-permissions-tool-use');
  return permission.message.permissionOccurrenceId;
}

async function readMarker(projectDir: string, name: string): Promise<string> {
  return readFile(join(projectDir, name), 'utf8');
}

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_PERMISSION_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
