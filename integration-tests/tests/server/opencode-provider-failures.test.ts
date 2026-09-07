import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerWsMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  expectFinished,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  killScriptedOpenCodeProvider,
  openCodeNativeSession,
  OPENCODE_RETRY_EXHAUSTION_REQUEST_COUNT,
  readOpenCodeSessionRows,
  readSupervisorStates,
  scriptOpenCodeRetryExhaustion,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Locks the provider-failure contract against the real binary: OpenCode retries normalized
// provider failures at most five times, then Garcon turns session.error into one visible error
// and agent-run-failed, never a false success.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode provider failures', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('exhausts HTTP 401 retries, reports one visible failure, and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const recoveryReply = marker('HTTP401_RECOVERY_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    scriptOpenCodeRetryExhaustion(testEnvironment.model, {
      kind: 'http-error',
      status: 401,
      message: marker('HTTP401_FAULT'),
    });

    await withIntegrationFixture('opencode-http-401', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('HTTP401_PROMPT'),
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const transcript = await fixture.client.getMessages(chatId);
      expect(messagesOfType(transcript.messages, 'error')).toHaveLength(1);
      expect(assistantContents(transcript.messages)).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor))
        .toHaveLength(OPENCODE_RETRY_EXHAUSTION_REQUEST_COUNT);
      expectSingleFailedTerminal(
        fixture.client.eventsSince(cursor),
        chatId,
        turn.turnId,
      );

      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      expect(previousSupervisors).toHaveLength(1);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });
      const restored = await fixture.client.getMessages(chatId);
      expect(messagesOfType(restored.messages, 'error')).toHaveLength(1);
      expect(assistantContents(restored.messages)).toEqual([]);

      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('HTTP401_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      expect(messagesOfType(
        (await fixture.client.getMessages(chatId)).messages,
        'error',
      )).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  // Locks the process-death contract against the real binary: killing the pinned server
  // fails the active turn exactly once and the next chat respawns a fresh server at once,
  // never waiting out the unavailability cooldown.
  test('restarts a killed server process and starts a new chat immediately', async () => {
    const testEnvironment = requireEnvironment();
    const recoveryReply = marker('KILL_RECOVERY_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([
      chatCompletionsText(marker('KILL_HELD_REPLY')),
    ]);

    await withIntegrationFixture('opencode-server-killed', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('KILL_PROMPT'),
      }));
      await held.requested;

      const supervisors = await readSupervisorStates(fixture.dirs);
      expect(supervisors).toHaveLength(1);
      const killedAt = Date.now();
      await killScriptedOpenCodeProvider(supervisors[0]!);

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectSingleFailedTerminal(fixture.client.eventsSince(cursor), chatId, turn.turnId);
      held.release();

      // The wrapper is Garcon's direct child: once every supervised identity is gone,
      // Garcon has been notified of the death. A start that still lands inside the
      // death-handling window may fail once against the stale endpoint; the termination
      // handler disarms the cooldown, so a bounded retry must succeed well before the
      // 60-second unavailability cooldown could expire.
      await waitForSupervisorExit(supervisors);

      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryDeadline = killedAt + 30_000;
      let recoveryChatId = '';
      let recoveryTurnId = '';
      let recoveryCursor = 0;
      let staleWindowFailures = 0;
      for (;;) {
        recoveryChatId = fixture.newChatId();
        recoveryCursor = fixture.client.markEvents();
        try {
          const recovery = await fixture.client.startChat(scriptedOpenCodeStartRequest({
            chatId: recoveryChatId,
            projectPath: fixture.dirs.project,
            command: marker('KILL_RECOVERY_PROMPT'),
          }));
          recoveryTurnId = recovery.turnId;
          break;
        } catch {
          staleWindowFailures += 1;
          if (Date.now() > recoveryDeadline || staleWindowFailures > 1) {
            throw new Error(`Recovery needed ${staleWindowFailures} stale-window failures`);
          }
          await Bun.sleep(250);
        }
      }
      await waitForVisibleResponse({
        fixture,
        chatId: recoveryChatId,
        turnId: recoveryTurnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      expect(Date.now() - killedAt).toBeLessThan(30_000);

      // Hermetic fixture: exactly the killed supervisor plus its single
      // replacement, with the killed turn still owning exactly one terminal.
      const supervisorsAfter = await readSupervisorStates(fixture.dirs);
      expect(supervisorsAfter).toHaveLength(2);
      expect(supervisorsAfter.filter((state) => state.reason === 'provider-exited')).toHaveLength(1);
      expect(supervisorsAfter.filter((state) =>
        state.status === 'running' && state.wrapperPid !== supervisors[0]!.wrapperPid
      )).toHaveLength(1);
      expectSingleFailedTerminal(fixture.client.eventsSince(cursor), chatId, turn.turnId);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('retries an errored model stream and finishes without a visible failure', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('STREAM_ERROR_PROMPT');
    const reply = marker('STREAM_ERROR_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'stream-error-frame',
      message: marker('STREAM_ERROR_FAULT'),
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-errored-stream', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(assistantContents(transcript.messages)).toEqual([reply]);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  // OpenCode 1.18.29 continues the prompt loop after an unknown stream finish, so a
  // clean-close truncated Chat Completions stream is recovered by the next response
  // instead of ending the turn as an empty success.
  // https://github.com/anomalyco/opencode/commit/57fa34f23599f65dd1027f9caac31e6c576ce644
  test('continues after a clean-close truncation and completes from the next response', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('TRUNCATION_PROMPT');
    const continuationReply = marker('TRUNCATION_CONTINUATION_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'stream-error',
      message: marker('TRUNCATION_FAULT'),
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(continuationReply)]);

    await withIntegrationFixture('opencode-clean-close-truncation', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: continuationReply,
        afterIndex: cursor,
      });
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectFinished(terminal.type);
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(assistantContents(transcript.messages)).toEqual([continuationReply]);
      expect(messagesOfType(transcript.messages, 'error')).toEqual([]);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);
      const terminals = fixture.client.eventsSince(cursor).filter((event) =>
        (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
        && event.chatId === chatId
        && event.turnId === turn.turnId);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.type).toBe('agent-run-finished');
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('[TLV5-L06.07-OPENCODE-SCRIPTED-01] retries one HTTP 500 with one durable advisory and no duplicate user rows', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('HTTP500_PROMPT');
    const reply = marker('HTTP500_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 500,
      message: marker('HTTP500_FAULT'),
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-http-500-retry', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      // Real OpenCode retried the retryable 500 exactly once before succeeding.
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(2);

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      // The upstream retry wait surfaced as one durable titled notice instead
      // of dead air, and the turn still recovered.
      const retryNotices = messagesOfType(transcript.messages, 'transcript-notice');
      expect(retryNotices).toHaveLength(1);
      expect(retryNotices[0]).toMatchObject({ title: 'Provider retry' });
      expect((retryNotices[0] as { content: string }).content)
        .toContain('Model provider retrying');
      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      expect(rows.messages.filter((row) => row.data.role === 'user')).toHaveLength(1);
      expect(rows.messages.filter((row) => row.data.role === 'assistant')).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('does not let a failed chat disturb a concurrent healthy chat', async () => {
    const testEnvironment = requireEnvironment();
    const healthyReply = marker('HEALTHY_REPLY');
    // The held first request belongs to the healthy chat; the second request consumes the
    // 401, so arrival order is deterministic.
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(healthyReply)]);
    scriptOpenCodeRetryExhaustion(testEnvironment.model, {
      kind: 'http-error',
      status: 401,
      message: marker('CONCURRENT_FAULT'),
    });

    await withIntegrationFixture('opencode-concurrent-failure', async (fixture) => {
      const healthyChatId = fixture.newChatId();
      const failedChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const healthy = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: healthyChatId,
        projectPath: fixture.dirs.project,
        command: marker('HEALTHY_PROMPT'),
      }));
      await held.requested;

      const failed = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: failedChatId,
        projectPath: fixture.dirs.project,
        command: marker('FAILED_PROMPT'),
      }));
      const failedTerminal = await fixture.client.waitForTurnTerminal(
        failedChatId,
        failed.turnId,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect(failedTerminal.type).toBe('agent-run-failed');
      await fixture.client.waitForProcessing(failedChatId, false, {
        afterIndex: cursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });

      held.release();
      await waitForVisibleResponse({
        fixture,
        chatId: healthyChatId,
        turnId: healthy.turnId,
        marker: healthyReply,
        afterIndex: cursor,
      });

      const healthyTranscript = await fixture.client.getMessages(healthyChatId);
      expect(messagesOfType(healthyTranscript.messages, 'error')).toEqual([]);
      expect(assistantContents(healthyTranscript.messages)).toEqual([healthyReply]);
      const failedTranscript = await fixture.client.getMessages(failedChatId);
      expect(messagesOfType(failedTranscript.messages, 'error')).toHaveLength(1);
      expectSingleFailedTerminal(
        fixture.client.eventsSince(cursor),
        failedChatId,
        failed.turnId,
      );
      expectFinished((await fixture.client.waitForTurnTerminal(
        healthyChatId,
        healthy.turnId,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      )).type);
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
  return `SCRIPTED_OPENCODE_FAILURE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function expectSingleFailedTerminal(
  events: readonly ServerWsMessage[],
  chatId: string,
  turnId: string,
): void {
  const terminals = events.filter((event) =>
    (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
    && event.chatId === chatId
    && event.turnId === turnId);
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({ type: 'agent-run-failed', chatId, turnId });
}
