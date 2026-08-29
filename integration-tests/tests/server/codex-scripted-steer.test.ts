import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
} from '../../support/live-agent.js';
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

  test('[TLV5-CHAT-ID-DISCOVERY.05-CODEX-SCRIPTED-01] immediately steers a requested chat ID without creating user input', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    let releasePath = '';
    const receivedReply = marker('CHAT_ID_RECEIVED');
    testEnvironment.model.scriptTurn(() => [
      codexAssistantMessage(`<get-garcon-chat-id />${marker('CHAT_ID_REQUEST')}`),
      codexExecCommandCall(
        'call_chat_id_gate',
        `while [ ! -f "${releasePath}" ]; do sleep 0.05; done`,
      ),
    ]);
    const steeredHeld = testEnvironment.model.scriptHeldTurn([
      codexAssistantMessage(receivedReply),
    ]);

    try {
      await withIntegrationFixture('codex-scripted-chat-id-discovery', async (fixture) => {
        const chatId = fixture.newChatId();
        releasePath = path.join(fixture.dirs.project, 'release-chat-id-tool');
        const cursor = fixture.client.markEvents();
        const active = await fixture.client.startChat(liveCodexStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: marker('CHAT_ID_FIRST_PROMPT'),
          permissionMode: 'bypassPermissions',
        }));

        await fixture.client.waitForEvent(
          (event): event is ChatMessagesMessage => event.type === 'chat-messages'
            && event.chatId === chatId
            && event.messages.some((entry) => (
              entry.message.type === 'transcript-notice'
              && entry.message.detail?.type === 'chat-id-disclosure'
            )),
          `Codex chat ID disclosure for ${chatId}`,
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
      }, {
        serverEnvironment: testEnvironment.serverEnvironment,
        prepareWorkspace: testEnvironment.prepareWorkspace,
      });
    } finally {
      if (releasePath) await writeFile(releasePath, 'release', 'utf8').catch(() => undefined);
      steeredHeld.release();
      testEnvironment.model.reset();
    }
  }, 120_000);

  test('delivers concurrent steers in committed ledger order', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const firstPrompt = marker('BATCH_FIRST_PROMPT');
    const firstSteer = marker('BATCH_FIRST_STEER');
    const secondSteer = `/review\n${marker('BATCH_SECOND_STEER')}`;
    const firstReply = marker('BATCH_FIRST_REPLY');
    const steeredReply = marker('BATCH_STEERED_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    const held = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(firstReply)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(steeredReply)]);

    await withIntegrationFixture('codex-scripted-steer-batch', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
        permissionMode: 'bypassPermissions',
      }));
      if (!first.turnId) throw new Error('Scripted Codex start did not return a turn identity.');
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
      const steeredRequest = requests.at(-1);
      if (!steeredRequest) throw new Error('Codex did not make the batched steering request.');

      const transcript = await fixture.client.getMessages(chatId);
      const committedSteers = userContents(transcript.messages).slice(1);
      expect(committedSteers).toHaveLength(2);
      expect(new Set(committedSteers)).toEqual(new Set([firstSteer, secondSteer]));
      expect(steeredRequest.userTexts.filter((text) => (
        text === firstSteer || text === secondSteer
      ))).toEqual(committedSteers);
      const assistants = assistantContents(transcript.messages);
      expect(assistants.some((content) => content.includes(firstReply))).toBe(true);
      expect(assistants.some((content) => content.includes(steeredReply))).toBe(true);
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
