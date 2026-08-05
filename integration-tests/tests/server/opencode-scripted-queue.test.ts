import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PendingUserInputUpdatedMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
} from '../../support/live-agent.js';
import {
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Queue lifecycle against the real binary: FIFO dispatch, pause/resume, cancel, client-request
// dedupe, and failure-triggered pause all hold while OpenCode runs one turn at a time.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode queue lifecycle', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('dispatches queued turns FIFO after a held active turn', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    const thirdPrompt = marker('THIRD_PROMPT');
    const thirdReply = marker('THIRD_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(secondReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(thirdReply)]);

    await withIntegrationFixture('opencode-scripted-queue', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('FIRST_PROMPT'),
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;

      const queueCursor = fixture.client.markEvents();
      await fixture.client.enqueueNew(chatId, secondPrompt);
      const thirdEntry = await fixture.client.enqueueNew(chatId, thirdPrompt);
      expect(thirdEntry.control.queue.entries.map((entry) => entry.content))
        .toEqual([secondPrompt, thirdPrompt]);

      firstHeld.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const secondInput = await waitForQueuedTurnIdentity(fixture.client, chatId, secondPrompt, queueCursor);
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, secondInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const thirdInput = await waitForQueuedTurnIdentity(fixture.client, chatId, thirdPrompt, queueCursor);
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
    }, withScriptedOpenCode());
  }, 120_000);

  test('pauses and resumes without sending paused entries to OpenCode', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('PAUSE_ACTIVE_REPLY');
    const queuedPrompt = marker('PAUSE_QUEUED_PROMPT');
    const queuedReply = marker('PAUSE_QUEUED_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(queuedReply)]);
    const requestCursor = testEnvironment.model.markRequests();

    await withIntegrationFixture('opencode-scripted-queue-pause', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      // The pause survives the active turn settling and the queued entry never ran.
      expect((await fixture.client.getExecutionControl(chatId)).queue.pause?.kind)
        .toBe('manual');
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);

      const resumeCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, paused.control.queue.pause!.id);
      const queuedInput = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        queuedPrompt,
        resumeCursor,
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, queuedInput.input.turnId, {
        afterIndex: resumeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.some((content) => content.includes(queuedReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('cancels a queued turn before any model request', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('CANCEL_ACTIVE_REPLY');
    const cancelledPrompt = marker('CANCEL_QUEUED_PROMPT');
    const survivorPrompt = marker('CANCEL_SURVIVOR_PROMPT');
    const survivorReply = marker('CANCEL_SURVIVOR_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(survivorReply)]);

    await withIntegrationFixture('opencode-scripted-queue-cancel', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      await fixture.client.enqueueNew(chatId, survivorPrompt);
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
      const survivorInput = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        survivorPrompt,
        queueCursor,
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, survivorInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      const requestTexts = testEnvironment.model.requests().flatMap((request) => request.userTexts);
      expect(requestTexts.some((text) => text.includes(cancelledPrompt))).toBe(false);
      expect(requestTexts.some((text) => text.includes(survivorPrompt))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('deduplicates a repeated client request identity', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('DUP_ACTIVE_REPLY');
    const queuedPrompt = marker('DUP_QUEUED_PROMPT');
    const queuedReply = marker('DUP_QUEUED_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptTurn([chatCompletionsText(queuedReply)]);

    await withIntegrationFixture('opencode-scripted-queue-duplicate', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
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
      const queuedInput = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        queuedPrompt,
        queueCursor,
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, queuedInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);

      // Exactly one extra model request: the duplicate never became a turn.
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)
        .filter((content) => content.includes(queuedReply))).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('pauses the queue on a non-retryable provider failure and resumes an edited retry', async () => {
    const testEnvironment = requireEnvironment();
    const firstReply = marker('FAIL_ACTIVE_REPLY');
    const failingPrompt = marker('FAIL_QUEUED_PROMPT');
    const editedPrompt = marker('FAIL_EDITED_PROMPT');
    const editedReply = marker('FAIL_EDITED_REPLY');
    const firstHeld = testEnvironment.model.scriptHeldTurn([chatCompletionsText(firstReply)]);
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 401,
      message: marker('FAIL_QUEUED_FAULT'),
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(editedReply)]);

    await withIntegrationFixture('opencode-scripted-queue-failure', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('FAIL_ACTIVE_PROMPT'),
      }));
      await fixture.client.waitForProcessing(chatId, true, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      await firstHeld.requested;
      const failing = await fixture.client.enqueueNew(chatId, failingPrompt);

      const queueCursor = fixture.client.markEvents();
      firstHeld.release();
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, first.turnId, {
        afterIndex: firstCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const failingInput = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        failingPrompt,
        queueCursor,
      );
      expect((await fixture.client.waitForTurnTerminal(chatId, failingInput.input.turnId, {
        afterIndex: queueCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-failed');

      const paused = await fixture.client.getExecutionControl(chatId);
      expect(paused.queue.pause).toMatchObject({ kind: 'queued-turn-failed' });
      const entry = paused.queue.entries.find((queuedEntry) => queuedEntry.id === failing.entryId);
      if (!entry) throw new Error('Failed queue entry was not retained for retry.');
      const replaced = await fixture.client.replaceQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: entry.id,
        content: editedPrompt,
        expectedRevision: entry.revision,
      });
      expect(replaced.control.queue.entries.map((queuedEntry) => queuedEntry.content))
        .toEqual([editedPrompt]);

      const resumeCursor = fixture.client.markEvents();
      await fixture.client.resumeQueue(chatId, paused.queue.pause!.id);
      const editedInput = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        editedPrompt,
        resumeCursor,
      );
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, editedInput.input.turnId, {
        afterIndex: resumeCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)
        .some((content) => content.includes(editedReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);
});

function waitForQueuedTurnIdentity(
  client: GarconTestClient,
  chatId: string,
  content: string,
  afterIndex: number,
): Promise<PendingUserInputUpdatedMessage> {
  return client.waitForEvent(
    (event): event is PendingUserInputUpdatedMessage =>
      event.type === 'pending-user-input-updated'
      && event.input.chatId === chatId
      && event.input.content === content
      && typeof event.input.turnId === 'string',
    `opencode queued turn identity for ${content.slice(0, 48)}`,
    { afterIndex, timeoutMs: LIVE_TURN_TIMEOUT_MS },
  );
}

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
  return `SCRIPTED_OPENCODE_QUEUE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
