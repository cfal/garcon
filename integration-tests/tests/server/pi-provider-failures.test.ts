import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  type FakeChatCompletionsModel,
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

// Locks Pi's provider-failure contract. Pi surfaces the final failure as an ErrorMessage and
// the Garcon-visible run finishes only after agent_settled closes the four-attempt retry cycle.
const PI_ATTEMPTS_PER_PROCESS = 4;

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi provider failures', () => {
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('surfaces an HTTP 500 as an error message, finishes the turn, and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('HTTP500_PROMPT');
    const faultMessage = 'scripted http failure';
    const recoveryReply = marker('HTTP500_RECOVERY_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    for (let attempt = 0; attempt < PI_ATTEMPTS_PER_PROCESS; attempt += 1) {
      testEnvironment.model.scriptFault({
        kind: 'http-error',
        status: 500,
        message: faultMessage,
      });
    }

    await withIntegrationFixture('pi-scripted-http-500', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);
      const errors = messagesOfType(
        (await fixture.client.getMessages(chatId)).messages,
        'error',
      );
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(errors)).toContain(faultMessage);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)
        .some((content) => content.includes(prompt))).toBe(false);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      await waitForNewRequestCount(
        testEnvironment.model,
        requestCursor,
        PI_ATTEMPTS_PER_PROCESS,
      );
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: marker('HTTP500_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 240_000);

  test('surfaces a truncated stream the same way and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const recoveryReply = marker('TRUNCATED_RECOVERY_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    for (let attempt = 0; attempt < PI_ATTEMPTS_PER_PROCESS; attempt += 1) {
      testEnvironment.model.scriptFault({
        kind: 'stream-error',
        message: 'scripted stream truncation',
      });
    }

    await withIntegrationFixture('pi-scripted-truncated-stream', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('TRUNCATED_PROMPT'),
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);
      expect(messagesOfType(
        (await fixture.client.getMessages(chatId)).messages,
        'error',
      ).length).toBeGreaterThanOrEqual(1);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      await waitForNewRequestCount(
        testEnvironment.model,
        requestCursor,
        PI_ATTEMPTS_PER_PROCESS,
      );
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: marker('TRUNCATED_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 240_000);

  test('never wedges the chat when the model has no scripted response', async () => {
    const testEnvironment = requireEnvironment();
    const requestCursor = testEnvironment.model.markRequests();
    // With no scripted turn, every retry receives a 500 and records a protocol violation.
    // The run still settles and the bounded retry appetite remains observable.
    await withIntegrationFixture('pi-scripted-exhaustion', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('EXHAUSTION_PROMPT'),
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(testEnvironment.model.protocolViolations().length).toBeGreaterThanOrEqual(1);

      await waitForNewRequestCount(
        testEnvironment.model,
        requestCursor,
        PI_ATTEMPTS_PER_PROCESS,
      );
      // The violations above were provoked on purpose; clear them before recovery.
      testEnvironment.model.clearProtocolViolations();

      const recoveryReply = marker('EXHAUSTION_RECOVERY_REPLY');
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: marker('EXHAUSTION_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 240_000);
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
  return `SCRIPTED_PI_FAILURES_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

// Waits for one complete retry cycle before another scripted turn is installed.
async function waitForNewRequestCount(
  model: FakeChatCompletionsModel,
  cursor: number,
  count: number,
  timeoutMs: number = LIVE_TURN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (model.requestsSince(cursor).length >= count) return;
    await Bun.sleep(250);
  }
  throw new Error(
    `Pi never made ${count} new model requests (saw ${model.requestsSince(cursor).length}).`,
  );
}
