import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

const SCRIPTED_MODEL_DEFAULTS = {
  'gpt-6-astra': 'low',
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
  'gpt-5.4': 'medium',
} as const;

describe('Codex scripted default effort model switching', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test.each([
    ['catalog', undefined],
    ['configured high', 'high'],
  ] as const)('preserves %s provider defaults', async (_label, configuredEffort) => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;

    await withIntegrationFixture('codex-scripted-default-switch', async (fixture) => {
      const chatId = fixture.newChatId();
      await runScriptedTurn({
        fixture,
        testEnvironment,
        chatId,
        model: 'gpt-6-astra',
        command: 'Start with the Astra default.',
        start: true,
        expectedEffort: configuredEffort ?? SCRIPTED_MODEL_DEFAULTS['gpt-6-astra'],
      });

      for (const model of [
        'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.4', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra',
      ] as const) {
        const response = await fetch(`${fixture.client.baseUrl}/api/v1/chats/model`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId, model }),
        });
        const body = await response.json();
        expect({ status: response.status, body }).toMatchObject({
          status: 200,
          body: { success: true, chatId, model },
        });

        await runScriptedTurn({
          fixture,
          testEnvironment,
          chatId,
          model,
          command: `Continue with the ${model} default.`,
          expectedEffort: configuredEffort ?? SCRIPTED_MODEL_DEFAULTS[model],
        });
      }

      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await overlayScriptedModelDefaults(directories);
        if (configuredEffort) {
          await configureReasoningEffort(directories, configuredEffort);
        }
      },
    });
  }, 120_000);

  test('restores configured Default after an explicit turn', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;

    await withIntegrationFixture('codex-scripted-explicit-default-switch', async (fixture) => {
      const chatId = fixture.newChatId();
      await runScriptedTurn({
        fixture,
        testEnvironment,
        chatId,
        model: 'gpt-6-astra',
        command: 'Use an explicit effort.',
        start: true,
        thinkingMode: 'high',
        expectedEffort: 'high',
      });
      await runScriptedTurn({
        fixture,
        testEnvironment,
        chatId,
        model: 'gpt-6-astra',
        command: 'Return to the configured default.',
        thinkingMode: 'none',
        expectedEffort: 'low',
      });

      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await overlayScriptedModelDefaults(directories);
        await configureReasoningEffort(directories, 'low');
      },
    });
  }, 120_000);
});

async function runScriptedTurn(options: {
  fixture: Parameters<Parameters<typeof withIntegrationFixture>[1]>[0];
  testEnvironment: ScriptedCodexTestEnvironment;
  chatId: string;
  model: keyof typeof SCRIPTED_MODEL_DEFAULTS;
  command: string;
  start?: boolean;
  thinkingMode?: 'none' | 'high';
  expectedEffort: string;
}): Promise<void> {
  const {
    fixture,
    testEnvironment,
    chatId,
    model,
    command,
    start = false,
    thinkingMode = 'none',
  } = options;
  const reply = `SCRIPTED_${model}_${crypto.randomUUID()}`;
  const requestIndex = testEnvironment.model.requests().length;
  testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);
  const cursor = fixture.client.markEvents();
  const turn = start
    ? await fixture.client.startChat({
      ...liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command,
      }),
      model,
      thinkingMode,
    })
    : await fixture.client.runChat({
      ...liveCodexRunRequest({ chatId, command }),
      model,
      thinkingMode,
    });
  await waitForVisibleResponse({
    fixture,
    chatId,
    turnId: turn.turnId,
    marker: reply,
    afterIndex: cursor,
  });

  expect(testEnvironment.model.requests()[requestIndex]?.body).toMatchObject({
    model,
    reasoning: { effort: options.expectedEffort },
  });
}

async function overlayScriptedModelDefaults(directories: IntegrationDirectories): Promise<void> {
  const catalogPath = join(directories.home, '.codex', 'live-models.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
    models: Array<Record<string, unknown>>;
  };
  const template = catalog.models[0];
  if (!template) throw new Error('Scripted Codex model catalog is empty.');
  catalog.models = Object.entries(SCRIPTED_MODEL_DEFAULTS).map(([slug, effort], priority) => ({
    ...template,
    slug,
    display_name: slug,
    description: `Scripted ${slug} model.`,
    default_reasoning_level: effort,
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map((supportedEffort) => ({
      effort: supportedEffort,
      description: `${supportedEffort} effort`,
    })),
    priority,
  }));
  await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
}

async function configureReasoningEffort(
  directories: IntegrationDirectories,
  effort: string,
): Promise<void> {
  const configPath = join(directories.home, '.codex', 'config.toml');
  const config = await readFile(configPath, 'utf8');
  await writeFile(configPath, `model_reasoning_effort = "${effort}"\n${config}`);
}
