import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  OPENCODE_TEST_REASONING_MODEL,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

// Thinking effort rides as a per-model OpenCode variant: the server derives
// low/medium/high variants for a reasoning-capable model, Garcon resolves the
// requested mode against the declared set, and the provider SDK lowers the
// selected variant onto the Chat Completions body as reasoning_effort.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode thinking effort', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ reasoningModel: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('carries a declared effort mode onto the provider request', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('EFFORT_HIGH_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-effort-declared', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('EFFORT_HIGH_PROMPT'),
        model: OPENCODE_TEST_REASONING_MODEL,
        thinkingMode: 'high',
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

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.model).toBe('fake-reasoning');
      expect(requests[0]?.body.reasoning_effort).toBe('high');
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('steps an above-ceiling effort down to the highest declared variant', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('EFFORT_MAX_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-effort-downgrade', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('EFFORT_MAX_PROMPT'),
        model: OPENCODE_TEST_REASONING_MODEL,
        thinkingMode: 'max',
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

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body.reasoning_effort).toBe('high');
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('omits the reasoning control for the default none mode', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('EFFORT_NONE_REPLY');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-effort-none', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('EFFORT_NONE_PROMPT'),
        model: OPENCODE_TEST_REASONING_MODEL,
        thinkingMode: 'none',
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

      const requests = testEnvironment.model.requestsSince(requestCursor);
      expect(requests).toHaveLength(1);
      expect('reasoning_effort' in (requests[0]?.body ?? {})).toBe(false);
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
