import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi steering', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('delivers a steer at the tool boundary without changing a paused future queue', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('TOOL_FIRST_PROMPT');
    const steerPrompt = marker('TOOL_STEER_PROMPT');
    const futurePrompt = marker('TOOL_FUTURE_PROMPT');
    const toolOutput = marker('TOOL_OUTPUT');
    const steerReply = marker('TOOL_STEER_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([
      chatCompletionsToolUse('call_pi_steer', 'bash', { command: `printf %s ${toolOutput}` }),
    ]);
    testEnvironment.model.scriptTurn([chatCompletionsText(steerReply)]);

    await withIntegrationFixture('pi-scripted-steer-tool', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      if (!first.turnId) throw new Error('Pi start response omitted its turn id.');
      await held.requested;

      await fixture.client.enqueueNew(chatId, futurePrompt);
      const paused = await fixture.client.pauseQueue(chatId);
      const controlBeforeSteer = await fixture.client.getExecutionControl(chatId);
      expect(paused.control.queue.pause?.kind).toBe('manual');

      await expect(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: `/review\n${marker('INVALID_SLASH')}`,
      })).rejects.toMatchObject({ status: 400 });

      const pendingCursor = fixture.client.markEvents();
      const steerRequest = {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: steerPrompt,
      };
      const steered = await fixture.client.steer(steerRequest);
      const duplicate = await fixture.client.steer(steerRequest);
      expect(steered).toMatchObject({ status: 'accepted', turnId: first.turnId });
      expect(duplicate).toMatchObject({ status: 'duplicate', turnId: first.turnId });
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(controlBeforeSteer);

      const pending = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === steerPrompt,
        'Pi steering pending input',
        { afterIndex: pendingCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(pending.input.turnId).toBe(first.turnId);

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      const steeredRequest = requests.at(-1);
      if (!steeredRequest) throw new Error('Pi did not make the steered model request.');
      expect(steeredRequest.userTexts.at(-1)).toBe(steerPrompt);
      expect(steeredRequest.toolResults).toContainEqual({
        toolCallId: 'call_pi_steer',
        content: expect.stringContaining(toolOutput),
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, steerPrompt]);
      expect(assistantContents(transcript.messages).some((text) => text.includes(steerReply))).toBe(true);
      expect(transcript.pendingUserInputs).toEqual([]);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(controlBeforeSteer);

      await expect(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: marker('AFTER_SETTLE'),
      })).rejects.toMatchObject({ status: 409 });
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('batches concurrent FIFO steers on a resumed process after a held final reply', async () => {
    const testEnvironment = requireEnvironment();
    const bootstrapPrompt = marker('BATCH_BOOTSTRAP_PROMPT');
    const bootstrapReply = marker('BATCH_BOOTSTRAP_REPLY');
    const firstPrompt = marker('BATCH_FIRST_PROMPT');
    const firstReply = marker('BATCH_FIRST_REPLY');
    const firstSteer = marker('BATCH_FIRST_STEER');
    const secondSteer = marker('BATCH_SECOND_STEER');
    const steeredReply = marker('BATCH_STEERED_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(bootstrapReply)]);

    await withIntegrationFixture('pi-scripted-steer-batch', async (fixture) => {
      const chatId = fixture.newChatId();
      const bootstrapCursor = fixture.client.markEvents();
      const bootstrap = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: bootstrapPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: bootstrap.turnId,
        marker: bootstrapReply,
        afterIndex: bootstrapCursor,
      });
      await fixture.restartGarcon();

      const requestCursor = testEnvironment.model.markRequests();
      const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
      testEnvironment.model.scriptTurn([chatCompletionsText(steeredReply)]);
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: firstPrompt,
      }));
      if (!first.turnId) throw new Error('Pi run response omitted its turn id.');
      await held.requested;

      const [firstResult, secondResult] = await Promise.all([
        fixture.client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content: firstSteer,
        }),
        fixture.client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content: secondSteer,
        }),
      ]);
      expect(firstResult).toMatchObject({ status: 'accepted', turnId: first.turnId });
      expect(secondResult).toMatchObject({ status: 'accepted', turnId: first.turnId });

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      expect(requests[1].userTexts.slice(-2)).toEqual([firstSteer, secondSteer]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([
        bootstrapPrompt,
        firstPrompt,
        firstSteer,
        secondSteer,
      ]);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((text) => text.includes(bootstrapReply))).toBe(true);
      expect(assistants.some((text) => text.includes(firstReply))).toBe(true);
      expect(assistants.some((text) => text.includes(steeredReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);
});

function requireEnvironment(): ScriptedPiTestEnvironment {
  if (!environment) throw new Error('Scripted Pi environment was not initialized.');
  return environment;
}

function withScriptedPi(): {
  serverEnvironment: Record<string, string>;
  prepareWorkspace: ScriptedPiTestEnvironment['prepareWorkspace'];
} {
  const testEnvironment = requireEnvironment();
  return {
    serverEnvironment: testEnvironment.serverEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
  };
}

function marker(label: string): string {
  return `SCRIPTED_PI_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
