import { expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('a committed goal pause ends the successor while retaining its native turn and output', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  const reply = 'Synthetic goal turn completed.';
  const prompt = '/goal Complete the synthetic task.';
  const held = environment.model.scriptHeldTurn([codexAssistantMessage(reply)]);
  try {
    await withIntegrationFixture('codex-scripted-goal-handoff', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.dirs.project, command: prompt, permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      const initial = await fixture.client.getMessages(chatId);
      const cursor = fixture.client.markEvents();
      const goal = await fixture.client.submitGoalControl({
        chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        transcriptViewId: initial.transcriptViewId, content: '/goal pause',
      });
      expect(goal.delivery).toBe('active');
      expect(goal.turnId).not.toBe(started.turnId);
      if (!goal.turnId) throw new Error('Goal handoff did not return its successor turn.');
      held.release();
      const terminal = await fixture.client.waitForTurnTerminal(chatId, goal.turnId, { afterIndex: cursor });
      expect(terminal.type).toBe('agent-run-finished');
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([prompt, '/goal pause']);
      expect(assistantContents(transcript.messages)).toContain(reply);
      expect(transcript.transcriptViewId).toBe(initial.transcriptViewId);
      const events = fixture.client.eventsSince(cursor);
      const outputIndex = events.findIndex((event) => event.type === 'chat-messages'
        && event.chatId === chatId && event.messages.some((entry) =>
          entry.message.type === 'assistant-message' && entry.message.content === reply));
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(terminal)).toBeGreaterThan(outputIndex);
      expect(environment.model.requests()).toHaveLength(1);
      environment.model.assertSettled();
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
    });
  } finally {
    held.release();
    await environment.dispose();
  }
}, 60_000);
