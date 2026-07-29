import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex persistence', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('restores a tool turn from native history after restart', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const marker = `SCRIPTED_CODEX_PERSIST_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_PERSIST_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = `Run the scripted persistence command for ${marker}.`;
    const command = `printf %s ${marker}`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_persist', command)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-persistence', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      const live = expectToolTurn(
        await fixture.client.getMessages(chatId),
        command,
        marker,
        reply,
        prompt,
      );

      await fixture.restartGarcon();
      const restored = expectToolTurn(
        await fixture.client.getMessages(chatId),
        command,
        marker,
        reply,
        prompt,
      );
      expect(restored).toEqual(live);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});

function expectToolTurn(
  transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>,
  command: string,
  marker: string,
  reply: string,
  prompt: string,
): { readonly command: string; readonly content: Record<string, unknown>; readonly isError: boolean } {
  const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
    (message) => message.command === command,
  );
  if (!bash) throw new Error('Codex shell tool use was not rendered.');
  const result = messagesOfType(transcript.messages, 'tool-result').find(
    (message) => message.toolId === bash.toolId,
  );
  expect(result?.isError).toBe(false);
  expect(result?.content).toEqual({ raw: marker });
  expect(assistantContents(transcript.messages).some((content) => content.includes(reply))).toBe(true);
  expect(countUserContent(transcript.messages, prompt)).toBe(1);
  if (!result) throw new Error('Codex shell tool result was not rendered.');
  return {
    command: bash.command,
    content: result.content,
    isError: result.isError,
  };
}
