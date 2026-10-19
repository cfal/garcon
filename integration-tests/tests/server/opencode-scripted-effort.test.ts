import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ThinkingMode } from '../../../common/chat-modes.js';
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
  OPENCODE_TEST_REASONING_MODEL_ID,
  OPENCODE_TEST_PROVIDER,
  openCodePaths,
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

  // Configured options replace generated variants before explicit variant overrides apply.
  // https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/provider/provider.ts#L1619-L1631
  const configuredReasoningCases: {
    name: string;
    modelConfig: Record<string, unknown>;
    thinkingMode: ThinkingMode;
    reasoningEffort: string | undefined;
  }[] = [
    {
      name: 'uses the configured effort ceiling instead of default variants',
      modelConfig: { reasoning_options: [{ type: 'effort', values: ['low'] }] },
      thinkingMode: 'max',
      reasoningEffort: 'low',
    },
    {
      name: 'preserves configured variant overrides over generated reasoning options',
      modelConfig: {
        reasoning_options: [{ type: 'effort', values: ['low', 'medium'] }],
        variants: { medium: { reasoningEffort: 'low' } },
      },
      thinkingMode: 'high',
      reasoningEffort: 'low',
    },
    {
      name: 'disables generated reasoning variants with empty options',
      modelConfig: { reasoning_options: [] },
      thinkingMode: 'high',
      reasoningEffort: undefined,
    },
    {
      name: 'selects the explicit none variant generated from a native null effort',
      // The native config accepts null even though the generated SDK declares string[].
      // https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/core/src/v1/config/provider.ts#L13-L15
      modelConfig: { reasoning_options: [{ type: 'effort', values: [null, 'low'] }] },
      thinkingMode: 'none',
      reasoningEffort: 'none',
    },
  ];

  for (const scenario of configuredReasoningCases) {
    test(scenario.name, async () => {
      const testEnvironment = requireEnvironment();
      const reply = marker('CONFIGURED_EFFORT_REPLY');
      testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

      await withIntegrationFixture('opencode-effort-configured', async (fixture) => {
        if (scenario.thinkingMode === 'none') {
          // Default effort avoids discovery to preserve native defaults; declared none needs a warm catalog.
          const catalog = await fixture.client.listAgentCatalog();
          expect(catalog.agents.find((agent) => agent.id === 'opencode')?.models
            .some((model) => model.value === OPENCODE_TEST_REASONING_MODEL)).toBe(true);
        }
        const requestCursor = testEnvironment.model.markRequests();
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: marker('CONFIGURED_EFFORT_PROMPT'),
          model: OPENCODE_TEST_REASONING_MODEL,
          thinkingMode: scenario.thinkingMode,
        }));
        await waitForVisibleResponse({
          fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor,
        });
        expectFinished((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
          afterIndex: cursor,
          timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type);

        const requests = testEnvironment.model.requestsSince(requestCursor);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.body.model).toBe(OPENCODE_TEST_REASONING_MODEL_ID);
        expect(requests[0]?.body.reasoning_effort).toBe(scenario.reasoningEffort);
        testEnvironment.model.assertSettled();
      }, withScriptedOpenCode(scenario.modelConfig));
    }, 120_000);
  }
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(modelConfig?: Record<string, unknown>): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    async prepareWorkspace(directories) {
      await testEnvironment.prepareWorkspace(directories);
      if (!modelConfig) return;
      const configPath = openCodePaths(directories).config;
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      Object.assign(config.provider[OPENCODE_TEST_PROVIDER].models[OPENCODE_TEST_REASONING_MODEL_ID], modelConfig);
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    },
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}
