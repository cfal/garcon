import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex strict steering', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('steers the active turn once ahead of a paused future queue', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('FIRST_PROMPT');
    const steerPrompt = marker('STEER_PROMPT');
    const futurePrompt = marker('FUTURE_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const steerReply = marker('STEER_REPLY');
    const futureReply = marker('FUTURE_REPLY');
    const toolMarker = marker('TOOL_OUTPUT');
    testEnvironment.model.scriptTurn([
      codexExecCommandCall('call_steer_context', `printf ${toolMarker}`),
    ]);
    const held = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(firstReply)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(steerReply)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(futureReply)]);

    await withIntegrationFixture('codex-scripted-steer', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      const firstTurnId = first.turnId;
      if (!firstTurnId) throw new Error('Scripted Codex start did not return a turn identity.');
      await held.requested;

      await fixture.client.enqueueNew(chatId, futurePrompt);
      const paused = await fixture.client.pauseQueue(chatId);
      expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual([futurePrompt]);
      expect(paused.control.queue.pause?.kind).toBe('manual');
      const beforeSteer = await fixture.client.getExecutionControl(chatId);
      const request = {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: steerPrompt,
      };

      const steered = await fixture.client.steer(request);
      const duplicate = await fixture.client.steer(request);

      expect(steered.turnId).toBe(firstTurnId);
      expect(duplicate).toMatchObject({ status: 'duplicate', turnId: firstTurnId });
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(beforeSteer);

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, firstTurnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const activeRequests = testEnvironment.model.requests();
      expect(activeRequests).toHaveLength(3);
      const steeredModelRequest = activeRequests[2];
      if (!steeredModelRequest) throw new Error('Codex did not make the steered model request.');
      expect(steeredModelRequest.lastUserText).toContain(steerPrompt);
      expect(steeredModelRequest.functionCallOutputs).toContainEqual(expect.objectContaining({
        callId: 'call_steer_context',
        output: expect.stringContaining(toolMarker),
      }));
      expect(activeRequests.filter((requestRecord) =>
        requestRecord.lastUserText.includes(steerPrompt))).toHaveLength(1);

      const stillPaused = await fixture.client.getExecutionControl(chatId);
      expect(stillPaused.queue.entries.map((entry) => entry.content)).toEqual([futurePrompt]);
      expect(stillPaused.queue.pause?.kind).toBe('manual');
      const futureCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, stillPaused.queue.pause!.id);
      const futureInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === futurePrompt
          && typeof event.input.turnId === 'string',
        'scripted Codex future queued turn identity',
        { afterIndex: futureCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, futureInput.input.turnId, {
        afterIndex: futureCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, steerPrompt, futurePrompt]);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(steerReply))).toBe(true);
      expect(assistants.some((content) => content.includes(futureReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CODEX_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
