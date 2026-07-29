import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
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
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const secondInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === secondPrompt
          && typeof event.input.turnId === 'string',
        'scripted Codex queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, secondInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
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
