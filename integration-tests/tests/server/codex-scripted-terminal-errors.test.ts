import { expect, test } from 'bun:test';
import { assistantContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('fails an incomplete Codex response once after its visible output and resumes normally', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    const partial = 'Synthetic partial output before the response limit.';
    environment.model.scriptFault({
      kind: 'incomplete-response', reason: 'max_output_tokens',
      items: [{ ...codexAssistantMessage(partial), phase: 'commentary' }],
    });
    await withIntegrationFixture('codex-scripted-incomplete', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Produce a synthetic incomplete response.',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor });
      expect(terminal.type).toBe('agent-run-failed');
      expect(terminal).toMatchObject({ error: expect.stringContaining('max_output_tokens') });
      expect(environment.model.requests()).toHaveLength(1);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toContain(partial);

      const events = fixture.client.eventsSince(cursor);
      const partialIndex = events.findIndex((event) => (
        event.type === 'chat-messages' && event.chatId === chatId
        && assistantContents(event.messages).includes(partial)
      ));
      const terminalIndex = events.indexOf(terminal);
      expect(partialIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(partialIndex);

      const answer = 'Synthetic answer after the failed response.';
      environment.model.scriptTurn([codexAssistantMessage(answer)]);
      const continuedCursor = fixture.client.markEvents();
      const continued = await fixture.client.runChat(liveCodexRunRequest({
        chatId, command: 'Continue after the synthetic failure.',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: continued.turnId, marker: answer, afterIndex: continuedCursor,
      });
      expect(fixture.client.eventsSince(cursor).filter((event) => (
        (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
        && event.chatId === chatId && event.turnId === started.turnId
      ))).toHaveLength(1);
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);
