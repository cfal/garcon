import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

// Locks the CURRENT transport's failure contract. Observed current behavior for a failed
// model request (HTTP 500 or truncated stream): Pi surfaces the failure as an ErrorMessage,
// the Garcon-visible run still reaches its finished terminal, and the CLI process then makes
// three more orphaned auto-retry attempts (~15s apart) that Garcon does not see. The retry
// budget is four attempts per process. Tests script all four attempts so nothing leaks into
// later turns, and drain the orphaned attempts before continuing.
const PI_ATTEMPTS_PER_PROCESS = 4;

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi provider failures', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('surfaces an HTTP 500 as an error message, finishes the turn, and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('HTTP500_PROMPT');
    const faultMessage = 'scripted http failure';
    const recoveryReply = marker('HTTP500_RECOVERY_REPLY');
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

      // Drain the orphaned retry attempts before scripting the recovery turn.
      await waitForRequestCount(testEnvironment.model, PI_ATTEMPTS_PER_PROCESS);
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

      await waitForRequestCount(testEnvironment.model, PI_ATTEMPTS_PER_PROCESS);
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
    // No scripted turn: the fake answers 500 and records a protocol violation. The locked
    // contract is that the turn still terminates and processing drops. The orphaned retry
    // attempts then consume scripted faults so their appetite is observable and bounded.
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

      for (let attempt = 1; attempt < PI_ATTEMPTS_PER_PROCESS; attempt += 1) {
        testEnvironment.model.scriptFault({
          kind: 'http-error',
          status: 500,
          message: 'orphan drain fault',
        });
      }
      await waitForRequestCount(testEnvironment.model, PI_ATTEMPTS_PER_PROCESS);
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

// Waits until the CLI process has consumed the expected number of model requests (the visible
// run plus its orphaned auto-retries), so later scripted turns cannot be eaten by retries.
async function waitForRequestCount(
  model: FakeChatCompletionsModel,
  count: number,
  timeoutMs: number = LIVE_TURN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (model.requests().length >= count) return;
    await Bun.sleep(250);
  }
  throw new Error(
    `Pi never reached ${count} model requests (saw ${model.requests().length}).`,
  );
}
