import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import {
  readSupervisorStates,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode automatic compaction against a scripted model', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ autoCompact: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('continues after a recoverable context overflow without surfacing a false failure', async () => {
    const testEnvironment = requireEnvironment();
    const summary = marker('SUMMARY');
    const reply = marker('REPLY');
    const prompt = marker('PROMPT');
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: 'scripted context overflow',
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(summary)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-scripted-compaction', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      expect(messagesOfType(transcript.messages, 'assistant-message').map(
        (message) => message.content,
      )).toEqual([reply]);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(testEnvironment.model.requests()).toHaveLength(3);

      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      expect(previousSupervisors).toHaveLength(1);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });

      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual([prompt]);
      expect(assistantContents(restored.messages)).toEqual([reply]);
      expect(messagesOfType(restored.messages, 'error')).toEqual([]);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('routes a post-compaction permission and its streamed tool turn to the originating operation', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('PERMISSION_REPLY');
    const prompt = marker('PERMISSION_PROMPT');
    const toolOutput = marker('TOOL_OUTPUT');
    const command = `printf %s ${toolOutput} > post-compaction-marker.txt`;
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: 'scripted context overflow',
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('PERMISSION_SUMMARY'))]);
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_after_compaction', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-scripted-compaction-permission', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'default',
      }));

      const permissionRequestId = await waitForPermission(fixture.client, chatId, cursor);
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
      expect(await readFile(join(fixture.dirs.project, 'post-compaction-marker.txt'), 'utf8'))
        .toBe(toolOutput);

      const transcript = await fixture.client.getMessages(chatId);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      expect(bash).toBeDefined();
      expect(messagesOfType(transcript.messages, 'permission-resolved').some(
        (message) => message.permissionRequestId === permissionRequestId && message.allowed,
      )).toBe(true);
      expect(messagesOfType(transcript.messages, 'assistant-message').map(
        (message) => message.content,
      )).toEqual([reply]);
      expect(testEnvironment.model.requests()).toHaveLength(4);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

async function waitForPermission(
  client: GarconTestClient,
  chatId: string,
  cursor: number,
): Promise<string> {
  const permission = await client.waitForTransientPermission(
    chatId,
    () => true,
    { afterIndex: cursor, timeoutMs: 30_000 },
  );
  if (permission.message.type !== 'permission-request') {
    throw new Error('Post-compaction OpenCode permission request was not found.');
  }
  return permission.message.permissionRequestId;
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
  return `SCRIPTED_OPENCODE_COMPACTION_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
