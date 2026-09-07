import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
} from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex queue lifecycle', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('drains a queued turn after a running tool turn', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('FIRST_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    testEnvironment.model.scriptTurn([
      codexExecCommandCall('call_queue_sleep', 'sleep 5'),
    ]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(firstReply)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(secondReply)]);

    await withIntegrationFixture('codex-scripted-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const queueCursor = fixture.client.markEvents();
      const queued = await fixture.client.enqueueNew(chatId, secondPrompt);
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([secondPrompt]);
      const firstTerminal = await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(firstTerminal.type);

      const secondInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        secondPrompt,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(secondInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const queueEvents = fixture.client.eventsSince(queueCursor);
      const firstReplyEventIndex = queueEvents.findIndex((event) =>
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.messages.some((entry) =>
          entry.message.type === 'assistant-message'
          && entry.message.content === firstReply));
      const firstTerminalIndex = queueEvents.findIndex((event) => event === firstTerminal);
      const secondInputIndex = queueEvents.findIndex((event) => event === secondInput);
      expect(firstReplyEventIndex).toBeGreaterThanOrEqual(0);
      expect(firstTerminalIndex).toBeGreaterThan(firstReplyEventIndex);
      expect(secondInputIndex).toBeGreaterThan(firstTerminalIndex);

      const page = await fixture.client.getMessages(chatId);
      const firstReplyEntry = page.messages.find((entry) =>
        entry.message.type === 'assistant-message' && entry.message.content === firstReply);
      const secondInputEntry = page.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === secondPrompt);
      if (!firstReplyEntry || !secondInputEntry) {
        throw new Error('Queued transcript omitted an expected exact marker');
      }
      expect(secondInputEntry.ordinal).toBeGreaterThan(firstReplyEntry.ordinal + 1);

      const assistants = assistantContents(page.messages);
      expect(assistants.findIndex((content) => content.includes(firstReply))).toBeGreaterThanOrEqual(0);
      expect(assistants.findIndex((content) => content.includes(secondReply)))
        .toBeGreaterThan(assistants.findIndex((content) => content.includes(firstReply)));
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});

function marker(label: string): string {
  return `SCRIPTED_CODEX_QUEUE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
