import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
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
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Permission flows through the real binary: OpenCode's permission.asked events cross Garcon's
// public boundary, user decisions execute or refuse the real shell tool, and manualBypass
// auto-replies without surfacing a user row.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

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

      const permissionRequestId = await waitForBashPermissionRequest(
        fixture.client,
        chatId,
        cursor,
      );
      const decision = await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
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
        && entry.message.permissionRequestId === permissionRequestId
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

      const permissionRequestId = await waitForBashPermissionRequest(
        fixture.client,
        chatId,
        cursor,
      );
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionRequestId,
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
        && entry.message.permissionRequestId === permissionRequestId
        && !entry.message.allowed)).toBe(true);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
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
  const request = await client.waitForEvent(
    (event): event is ChatMessagesMessage =>
      event.type === 'chat-messages'
      && event.chatId === chatId
      && event.messages.some((entry) => entry.message.type === 'permission-request'),
    'opencode bash permission request',
    { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
  const permission = request.messages.find(
    (entry) => entry.message.type === 'permission-request',
  );
  if (permission?.message.type !== 'permission-request') {
    throw new Error('OpenCode bash permission request was not found.');
  }
  expect(permission.message.requestedTool.type).toBe('request-permissions-tool-use');
  return permission.message.permissionRequestId;
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
