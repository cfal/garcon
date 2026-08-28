import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Steering rides OpenCode's promptAsync delivery against the active session loop:
// the steer lands as a committed user row before the provider consumes it, joins
// the next model request at the tool boundary, and cannot disturb a paused
// future queue. Locked at the public server boundary against the real binary.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode steering', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
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
      chatCompletionsToolUse('call_oc_steer', 'bash', { command: `printf %s ${toolOutput}` }),
    ]);
    testEnvironment.model.scriptTurn([chatCompletionsText(steerReply)]);

    await withIntegrationFixture('opencode-steer-tool', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await held.requested;

      await fixture.client.enqueueNew(chatId, futurePrompt);
      const paused = await fixture.client.pauseQueue(chatId);
      const controlBeforeSteer = await fixture.client.getExecutionControl(chatId);
      expect(paused.control.queue.pause?.kind).toBe('manual');

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

      const committedSteer = await fixture.client.waitForCommittedUserInput(
        chatId,
        steerPrompt,
        { afterIndex: pendingCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(committedSteer.messages).toHaveLength(1);

      held.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: eventCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(2);
      const steeredRequest = requests.at(-1);
      if (!steeredRequest) throw new Error('OpenCode did not make the steered model request.');
      expect(steeredRequest.userTexts.at(-1)).toBe(steerPrompt);
      expect(steeredRequest.toolResults).toContainEqual({
        toolCallId: 'call_oc_steer',
        content: expect.stringContaining(toolOutput),
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([firstPrompt, steerPrompt]);
      expect(assistantContents(transcript.messages).some((text) => text.includes(steerReply))).toBe(true);
      expect(transcript.resendCandidates).toEqual([]);
      expect(await fixture.client.getExecutionControl(chatId)).toEqual(controlBeforeSteer);

      await expect(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId,
        content: marker('AFTER_SETTLE'),
      })).rejects.toMatchObject({ status: 409 });
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('[TLV5-CHAT-ID-DISCOVERY.05-OPENCODE-SCRIPTED-01] immediately steers a requested chat ID without creating user input', async () => {
    const testEnvironment = requireEnvironment();
    let releasePath = '';
    const receivedReply = marker('CHAT_ID_RECEIVED');
    testEnvironment.model.scriptTurn(() => [
      chatCompletionsText(`<get-garcon-chat-id />${marker('CHAT_ID_REQUEST')}`),
      chatCompletionsToolUse('call_oc_chat_id', 'bash', {
        command: `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      }),
    ]);
    const steeredHeld = testEnvironment.model.scriptHeldTurn([
      chatCompletionsText(receivedReply),
    ]);

    try {
      await withIntegrationFixture('opencode-scripted-chat-id-discovery', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-tool');
        const cursor = fixture.client.markEvents();
        const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: marker('CHAT_ID_FIRST_PROMPT'),
        }));

        await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages'
            && event.chatId === chatId
            && event.messages.some((entry) => (
              entry.message.type === 'transcript-notice'
              && entry.message.detail?.type === 'chat-id-disclosure'
            )),
          `OpenCode chat ID disclosure for ${chatId}`,
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
        );
        await writeFile(releasePath, 'release', 'utf8');

        const steeredRequest = await steeredHeld.requested;
        expect(steeredRequest.userTexts.join('\n')).toContain(
          `<garcon-chat-id>${chatId}</garcon-chat-id>`,
        );
        steeredHeld.release();
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
          afterIndex: cursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);

        const page = await fixture.client.getMessages(chatId);
        expect(userContents(page.messages)).toHaveLength(1);
        expect(JSON.stringify(page.messages)).not.toContain('<get-garcon-chat-id />');
        expect(JSON.stringify(page.messages)).not.toContain('<garcon-chat-id>');
        expect(messagesOfType(page.messages, 'transcript-notice')
          .filter((message) => message.detail?.type.startsWith('chat-id-')))
          .toEqual([
            expect.objectContaining({ detail: { type: 'chat-id-request' } }),
            expect.objectContaining({
              content: `Sent chat ID ${chatId} to agent`,
              detail: { type: 'chat-id-disclosure' },
            }),
          ]);

        await reloadUntilNativeContains(fixture, chatId, receivedReply);
        const reloaded = await fixture.client.getMessages(chatId);
        expect(userContents(reloaded.messages)).toHaveLength(1);
        expect(JSON.stringify(reloaded.messages)).not.toContain('<garcon-chat-id>');
        testEnvironment.model.assertSettled();
      }, withScriptedOpenCode());
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      steeredHeld.release();
    }
  }, 120_000);

  test('batches concurrent FIFO steers after a held reply without a restart', async () => {
    const testEnvironment = requireEnvironment();
    const bootstrapPrompt = marker('BATCH_BOOTSTRAP_PROMPT');
    const bootstrapReply = marker('BATCH_BOOTSTRAP_REPLY');
    const firstPrompt = marker('BATCH_FIRST_PROMPT');
    const firstReply = marker('BATCH_FIRST_REPLY');
    const firstSteer = marker('BATCH_FIRST_STEER');
    const secondSteer = marker('BATCH_SECOND_STEER');
    const steeredReply = marker('BATCH_STEERED_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(bootstrapReply)]);

    await withIntegrationFixture('opencode-steer-batch', async (fixture) => {
      const chatId = fixture.newChatId();
      const bootstrapCursor = fixture.client.markEvents();
      const bootstrap = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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

      const requestCursor = testEnvironment.model.markRequests();
      const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
      testEnvironment.model.scriptTurn([chatCompletionsText(steeredReply)]);
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: firstPrompt,
      }));
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
      const transcript = await fixture.client.getMessages(chatId);
      const committedInputs = userContents(transcript.messages);
      expect(committedInputs).toEqual([
        bootstrapPrompt,
        firstPrompt,
        expect.stringMatching(new RegExp(`^(?:${firstSteer}|${secondSteer})$`)),
        expect.stringMatching(new RegExp(`^(?:${firstSteer}|${secondSteer})$`)),
      ]);
      expect(new Set(committedInputs.slice(-2))).toEqual(new Set([firstSteer, secondSteer]));
      expect(requests[1].userTexts.slice(-2)).toEqual(committedInputs.slice(-2));
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((text) => text.includes(bootstrapReply))).toBe(true);
      expect(assistants.some((text) => text.includes(firstReply))).toBe(true);
      expect(assistants.some((text) => text.includes(steeredReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}
