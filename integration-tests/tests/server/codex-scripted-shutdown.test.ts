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
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex shutdown', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('flushes the completed rollout tail before an immediate restart', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const marker = `SCRIPTED_CODEX_SHUTDOWN_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_SHUTDOWN_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = `Run the scripted shutdown command for ${marker}.`;
    const command = `printf %s ${marker}`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_shutdown', command)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-shutdown', async (fixture) => {
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

      await fixture.restartGarcon();
      const restored = await fixture.client.getMessages(chatId);
      const bash = messagesOfType(restored.messages, 'bash-tool-use').find(
        (message) => message.command === command,
      );
      if (!bash) throw new Error('Codex shutdown command was not restored.');
      const result = messagesOfType(restored.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result).toMatchObject({
        content: { raw: marker },
        isError: false,
      });
      expect(assistantContents(restored.messages)).toContain(reply);
      expect(countUserContent(restored.messages, prompt)).toBe(1);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});
