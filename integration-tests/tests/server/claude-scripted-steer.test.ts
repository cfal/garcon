import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished, LIVE_TURN_TIMEOUT_MS } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  claudeContinuationRequestText,
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

const STEERING_PREFIX = 'The user sent steering guidance for the active task:\n\n';

describe('scripted Claude strict steering', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('keeps next-priority guidance in one turn ahead of a paused future queue', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('FIRST_PROMPT');
    const steerPrompt = `/review\n${marker('STEER_PROMPT')}`;
    const futurePrompt = marker('FUTURE_PROMPT');
    const steerReply = marker('STEER_REPLY');
    const futureReply = marker('FUTURE_REPLY');
    const toolMarker = marker('TOOL_OUTPUT');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([
      claudeToolUse('toolu_steer_context', 'Bash', { command: `printf %s ${toolMarker}` }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(steerReply)]);
    testEnvironment.model.scriptTurn([claudeText(futureReply)]);

    await withIntegrationFixture('claude-scripted-steer', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      expect(catalog.agents.find((agent) => agent.id === 'claude')).toMatchObject({
        supportsSteering: true,
      });

      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      const firstTurnId = first.turnId;
      if (!firstTurnId) throw new Error('Scripted Claude start did not return a turn identity.');
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
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        firstPrompt,
        steerPrompt,
      ]);

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, firstTurnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const activeRequests = testEnvironment.model.requestsSince(requestCursor);
      expect(activeRequests).toHaveLength(2);
      const steeredModelRequest = activeRequests.at(-1);
      if (!steeredModelRequest) throw new Error('Claude did not make the steered model request.');
      const steeredToolResult = steeredModelRequest.toolResults.find(
        (result) => result.toolUseId === 'toolu_steer_context',
      );
      if (!steeredToolResult) throw new Error('Claude omitted the steering tool result.');
      expect(steeredToolResult.content).toContain(toolMarker);
      expect(steeredToolResult.content).toContain(`${STEERING_PREFIX}${steerPrompt}`);
      expect(steeredToolResult.content.indexOf(toolMarker))
        .toBeLessThan(steeredToolResult.content.indexOf(`${STEERING_PREFIX}${steerPrompt}`));
      expect(activeRequests.filter((record) =>
        record.toolResults.some((result) => result.content.includes(steerPrompt)))).toHaveLength(1);

      const stillPaused = await fixture.client.getExecutionControl(chatId);
      expect(stillPaused).toEqual(beforeSteer);
      const activeTranscript = await fixture.client.getMessages(chatId);
      expect(userContents(activeTranscript.messages)).toEqual([firstPrompt, steerPrompt]);
      expect(JSON.stringify(activeTranscript.messages)).not.toContain(STEERING_PREFIX);
      const activePreview = (await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === chatId,
      )?.preview.lastMessage;
      expect(activePreview).toContain(steerReply);
      expect(activePreview).not.toContain(STEERING_PREFIX);

      const futureCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, stillPaused.queue.pause!.id);
      const futureInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        futurePrompt,
        { afterIndex: futureCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(futureInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, steerPrompt, futurePrompt]);
      expect(JSON.stringify(transcript.messages)).not.toContain(STEERING_PREFIX);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((content) => content.includes(steerReply))).toBe(true);
      expect(assistants.some((content) => content.includes(futureReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 120_000);

  test('delivers two FIFO steers with distinct message identities', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('BATCH_FIRST_PROMPT');
    const firstSteer = marker('BATCH_FIRST_STEER');
    const secondSteer = `/review\n${marker('BATCH_SECOND_STEER')}`;
    const firstReply = marker('BATCH_FIRST_REPLY');
    const steeredReply = marker('BATCH_STEERED_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([claudeText(firstReply)]);
    testEnvironment.model.scriptTurn([claudeText(steeredReply)]);

    await withIntegrationFixture('claude-scripted-steer-batch', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!first.turnId) throw new Error('Scripted Claude start did not return a turn identity.');
      await held.requested;

      const firstResult = await fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: firstSteer,
      });
      const secondResult = await fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: secondSteer,
      });
      expect(firstResult).toMatchObject({ status: 'accepted', turnId: first.turnId });
      expect(secondResult).toMatchObject({ status: 'accepted', turnId: first.turnId });
      expect((await fixture.client.listChats()).sessions.find(
        (entry) => entry.id === chatId,
      )).toMatchObject({ isProcessing: true });

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      const steeredRequest = requests.at(-1);
      if (!steeredRequest) throw new Error('Claude did not make the batched steering request.');
      expect(steeredRequest.lastUserText).toBe(claudeContinuationRequestText([
        `${STEERING_PREFIX}${firstSteer}`,
        `${STEERING_PREFIX}${secondSteer}`,
      ].join('\n')));
      expect(steeredRequest.lastUserText.indexOf(firstSteer))
        .toBeLessThan(steeredRequest.lastUserText.indexOf(secondSteer));

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, firstSteer, secondSteer]);
      expect(JSON.stringify(transcript.messages)).not.toContain(STEERING_PREFIX);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(steeredReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 120_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_STEER_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
