import { expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';

test('runs Pi codemode worker assets and renders tool discovery with canonical messages', async () => {
  const environment = startScriptedPiTestEnvironment({ extensionSource: `
export default function (pi) {
  pi.on('session_start', () => pi.setActiveTools(['bash', 'codemode', 'tool_search']));
}
` });
  const code = "text(await tools.bash({ command: 'printf codemode-output' }));";
  try {
    environment.model.scriptTurn([chatCompletionsToolUse('discover', 'tool_search', { query: 'read files', limit: 2 })]);
    environment.model.scriptTurn([chatCompletionsToolUse('execute', 'codemode', { code })]);
    environment.model.scriptTurn([chatCompletionsText('tools finished')]);
    await withIntegrationFixture('pi-scripted-tools', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'run tools',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: 'tools finished', afterIndex: cursor });
      const { messages } = await fixture.client.getMessages(chatId);
      expect(messagesOfType(messages, 'pi-tool-search-tool-use')).toEqual([
        expect.objectContaining({ query: 'read files', limit: 2 }),
      ]);
      const execution = messagesOfType(messages, 'exec-tool-use').find((message) => message.code === code);
      expect(execution?.language).toBe('javascript');
      const result = messagesOfType(messages, 'tool-result').find((message) => message.toolId === execution?.toolId);
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain('codemode-output');
      expect(messagesOfType(messages, 'unknown-tool-use')).toEqual([]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);
