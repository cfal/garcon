import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NodeProviderCapacity } from '../../../server/execution-node/provider-capacity.js';
import { NODE_WIRE_VERSION } from '../../../server-agents/interface/src/index.js';
import { NodeProviderCatalogHost } from '../../../server/execution-node/provider-catalog-host.js';
import { parseNodeWorkerServiceText, serializeNodeWorkerService } from '../../../server/execution-node/worker/service-protocol.js';
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

  test('projects real reasoning-model discovery through the private catalog wire contract', async () => {
    const provider = requireEnvironment();
    await withIntegrationFixture('opencode-catalog-wire', async (fixture) => {
      const catalog = (await fixture.client.listAgentCatalog()).agents.find(({ id }) => id === 'opencode');
      if (!catalog) throw new Error('OpenCode catalog was not discovered.');
      const reasoning = catalog.models.find(({ value }) => value === OPENCODE_TEST_REASONING_MODEL);
      expect(reasoning).toHaveProperty('thinkingModes', ['low', 'medium', 'high']);
      const host = new NodeProviderCatalogHost(new NodeProviderCapacity(), 'synthetic-instance', { snapshot: async () => ({ models: catalog.models,
        defaultModel: catalog.defaultModel, requiresStrictModelDiscovery: catalog.requiresStrictModelDiscovery, generation: catalog.generation }) });
      const result = await host.snapshot({ strict: true }, new AbortController().signal);
      if (result.kind !== 'provider-catalog') throw new Error(`Catalog wire capture failed: ${result.kind}`);
      expect(result.snapshot.models.find(({ value }) => value === OPENCODE_TEST_REASONING_MODEL))
        .toEqual({ value: OPENCODE_TEST_REASONING_MODEL, label: reasoning!.label, supportsImages: false });
      const frame = { type: 'node-worker-service-result', version: NODE_WIRE_VERSION, connectionId: 1, requestId: 1,
        session: { controllerBootId: 'controller-boot', nodeBootId: 'node-boot', logicalSessionId: 'synthetic-session' }, result } as const;
      expect(parseNodeWorkerServiceText(serializeNodeWorkerService(frame))).toEqual(frame);
      expect(provider.model.requests()).toEqual([]);
    }, { ...withScriptedOpenCode(), bindAddress: '0.0.0.0', authentication: 'account' });
  }, 120_000);

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
