import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
  openCodeNativeSession,
  readOpenCodeSessionRows,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Locks the provider-failure contract against the real binary: OpenCode publishes
// session.error for non-retryable failures, and Garcon turns that into one visible error and
// agent-run-failed, never a false success. Retryable 5xx failures are retried by real
// OpenCode without a finite attempt cap, so this suite uses one 500 followed by success.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode provider failures', () => {
  beforeAll(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('reports HTTP 401 as agent-run-failed with one visible error and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const recoveryReply = marker('HTTP401_RECOVERY_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
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
      expect(messagesOfType(transcript.messages, 'error').length).toBeGreaterThanOrEqual(1);
      expect(assistantContents(transcript.messages)).toEqual([]);
      // A non-retryable 401 produced exactly one provider request.
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);

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
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  // OpenCode 1.18.4 accepts a clean-close truncated Chat Completions stream as a complete
  // (empty) response and retries genuine socket resets without a finite cap, so neither shape
  // publishes session.error. The deterministic non-retryable stream failure is a provider
  // error frame mid-stream, verified against the pinned binary.
  test('reports an errored model stream as agent-run-failed and recovers', async () => {
    const testEnvironment = requireEnvironment();
    const recoveryReply = marker('STREAM_ERROR_RECOVERY_REPLY');
    testEnvironment.model.scriptFault({
      kind: 'stream-error-frame',
      message: marker('STREAM_ERROR_FAULT'),
    });

    await withIntegrationFixture('opencode-errored-stream', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('STREAM_ERROR_PROMPT'),
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
      expect(messagesOfType(transcript.messages, 'error').length).toBeGreaterThanOrEqual(1);
      expect(assistantContents(transcript.messages)).toEqual([]);

      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('STREAM_ERROR_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('retries one HTTP 500 through OpenCode and then succeeds without duplicate user rows', async () => {
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
    testEnvironment.model.scriptFault({
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
      expect(messagesOfType(failedTranscript.messages, 'error').length)
        .toBeGreaterThanOrEqual(1);
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
