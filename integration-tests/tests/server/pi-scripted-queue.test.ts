import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
} from '../../support/live-agent.js';
import {
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi queue lifecycle', () => {
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('drains queued turns in FIFO order after the active turn', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('FIRST_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    const thirdPrompt = marker('THIRD_PROMPT');
    const thirdReply = marker('THIRD_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(thirdReply)]);

    await withIntegrationFixture('pi-scripted-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;

      const queueCursor = fixture.client.markEvents();
      const secondEntry = await fixture.client.enqueueNew(chatId, secondPrompt);
      const thirdEntry = await fixture.client.enqueueNew(chatId, thirdPrompt);
      expect(thirdEntry.control.queue.entries.map((entry) => entry.content))
        .toEqual([secondPrompt, thirdPrompt]);

      firstHeld.release();
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
        'scripted Pi second queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, secondInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const thirdInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === thirdPrompt
          && typeof event.input.turnId === 'string',
        'scripted Pi third queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, thirdInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      expect(secondInput.input.turnId).not.toBe(thirdInput.input.turnId);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      const firstIndex = assistants.findIndex((content) => content.includes(firstReply));
      const secondIndex = assistants.findIndex((content) => content.includes(secondReply));
      const thirdIndex = assistants.findIndex((content) => content.includes(thirdReply));
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
      expect(thirdIndex).toBeGreaterThan(secondIndex);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('holds queued entries while paused and dispatches on resume', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('PAUSE_ACTIVE_REPLY');
    const queuedPrompt = marker('PAUSE_QUEUED_PROMPT');
    const queuedReply = marker('PAUSE_QUEUED_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(queuedReply)]);

    await withIntegrationFixture('pi-scripted-queue-pause', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('PAUSE_ACTIVE_PROMPT'),
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;
      await fixture.client.enqueueNew(chatId, queuedPrompt);
      const paused = await fixture.client.pauseQueue(chatId);
      expect(paused.control.queue.pause?.kind).toBe('manual');

      firstHeld.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      // The pause must survive the active turn settling.
      expect((await fixture.client.getExecutionControl(chatId)).queue.pause?.kind)
        .toBe('manual');

      const resumeCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, paused.control.queue.pause!.id);
      const queuedInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === queuedPrompt
          && typeof event.input.turnId === 'string',
        'scripted Pi paused queued turn identity',
        { afterIndex: resumeCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, queuedInput.input.turnId, {
        afterIndex: resumeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.some((content) => content.includes(queuedReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('rejects a duplicate queued clientRequestId without an extra turn', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('DUP_ACTIVE_REPLY');
    const queuedPrompt = marker('DUP_QUEUED_PROMPT');
    const queuedReply = marker('DUP_QUEUED_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(queuedReply)]);

    await withIntegrationFixture('pi-scripted-queue-duplicate', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('DUP_ACTIVE_PROMPT'),
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;

      const queueCursor = fixture.client.markEvents();
      const clientRequestId = crypto.randomUUID();
      const queued = await fixture.client.enqueue({
        clientRequestId,
        chatId,
        content: queuedPrompt,
      });
      expect(queued.status).toBe('accepted');
      const duplicate = await fixture.client.enqueue({
        clientRequestId,
        chatId,
        content: queuedPrompt,
      });
      expect(duplicate.status).toBe('duplicate');
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries)
        .toHaveLength(1);

      firstHeld.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const queuedInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === queuedPrompt
          && typeof event.input.turnId === 'string',
        'scripted Pi duplicate queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, queuedInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      // Exactly one extra model request: the duplicate never became a turn.
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)
        .filter((content) => content.includes(queuedReply))).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  test('never sends a cancelled queue entry to the model', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('CANCEL_ACTIVE_REPLY');
    const cancelledPrompt = marker('CANCEL_QUEUED_PROMPT');
    const survivorPrompt = marker('CANCEL_SURVIVOR_PROMPT');
    const survivorReply = marker('CANCEL_SURVIVOR_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(survivorReply)]);

    await withIntegrationFixture('pi-scripted-queue-cancel', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('CANCEL_ACTIVE_PROMPT'),
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;

      const cancelled = await fixture.client.enqueueNew(chatId, cancelledPrompt);
      const survivor = await fixture.client.enqueueNew(chatId, survivorPrompt);
      const deleted = await fixture.client.deleteQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: cancelled.entryId,
      });
      expect(deleted.control.queue.entries.map((entry) => entry.content))
        .toEqual([survivorPrompt]);

      const queueCursor = fixture.client.markEvents();
      firstHeld.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const survivorInput = await fixture.client.waitForEvent(
        (event): event is PendingUserInputUpdatedMessage =>
          event.type === 'pending-user-input-updated'
          && event.input.chatId === chatId
          && event.input.content === survivorPrompt
          && typeof event.input.turnId === 'string',
        'scripted Pi surviving queued turn identity',
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, survivorInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requestTexts = testEnvironment.model.requests().flatMap((request) => request.userTexts);
      expect(requestTexts.some((text) => text.includes(cancelledPrompt))).toBe(false);
      expect(requestTexts.some((text) => text.includes(survivorPrompt))).toBe(true);
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
  return `SCRIPTED_PI_QUEUE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
