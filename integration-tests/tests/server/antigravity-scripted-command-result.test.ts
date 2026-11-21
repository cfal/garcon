import { expect, test } from 'bun:test';
import { assistantContents, messagesOfType } from '../../support/chat-assertions.js';
import { geminiFunctionCall, geminiText } from '../../support/fake-gemini-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import {
  ANTIGRAVITY_BINARY,
  scriptedAntigravityStartRequest,
  startScriptedAntigravityTestEnvironment,
} from '../../support/scripted-antigravity.js';

test.skipIf(!ANTIGRAVITY_BINARY)('Antigravity reports a nonzero command as a tool error, not a failed turn', async () => {
  const environment = startScriptedAntigravityTestEnvironment();
  const output = 'synthetic-command-output';
  const reply = 'Synthetic recovery reply';
  try {
    environment.model.scriptTurn([geminiFunctionCall('nonzero-command', 'run_command', {
      CommandLine: `printf %s ${output}; exit 9`, toolSummary: 'Report a failing exit code', WaitMsBeforeAsync: 5000,
    })]);
    environment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-nonzero-command', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'run the failing command',
        permissionMode: 'bypassPermissions',
      }));
      expect(await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).toMatchObject({ type: 'agent-run-finished', outcome: 'finished' });
      const { messages } = await fixture.client.getMessages(chatId);
      expect(assistantContents(messages)).toEqual([reply]);
      expect(messagesOfType(messages, 'error')).toEqual([]);
      const results = messagesOfType(messages, 'tool-result');
      expect(results.map((result) => result.toolId)).toEqual(['nonzero-command']);
      expect(results[0]?.content.raw).toContain('Command exited with code 9.');
      expect(results[0]?.content.raw).toContain(output);
      expect(results[0]?.isError).toBe(true);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);
