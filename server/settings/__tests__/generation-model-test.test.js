import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('../../config.js', () => ({
  getProjectBasePath: mock(() => '/workspace'),
}));

import {
  GenerationModelTestError,
  testGenerationModel,
} from '../generation-model-test.js';
import { UnsupportedSingleQueryEffortError } from '../../agents/single-query-errors.js';
import { generationModelTestConfigurationKey } from '../../../common/generation-test-contracts.js';

const titleConfigurationKey = generationModelTestConfigurationKey({
  agentId: 'direct-openai-compatible',
  model: 'glm-5.2',
  apiProviderId: 'alibaba',
  modelEndpointId: 'alibaba-openai',
  modelProtocol: 'openai-compatible',
  thinkingMode: 'max',
});

const commitConfigurationKey = generationModelTestConfigurationKey({
  agentId: 'codex',
  model: 'gpt-5.5',
  thinkingMode: 'low',
});

function createHarness() {
  const runSingleQuery = mock(() => Promise.resolve('OK'));
  return {
    settings: {
      getUiSettings: mock(() => ({
        chatTitle: {
          agentId: 'direct-openai-compatible',
          model: 'glm-5.2',
          apiProviderId: 'alibaba',
          modelEndpointId: 'alibaba-openai',
          modelProtocol: 'openai-compatible',
          thinkingMode: 'max',
        },
        commitMessage: {
          agentId: 'codex',
          model: 'gpt-5.5',
          thinkingMode: 'low',
        },
      })),
    },
    agents: {
      getAgentAuthStatusMap: mock(() => Promise.resolve({})),
      getAgentReadinessMap: mock(() => Promise.resolve({})),
      getAgentCatalogEntries: mock(() => Promise.resolve([
        {
          id: 'direct-openai-compatible',
          models: [{ value: 'glm-5.2', label: 'GLM 5.2' }],
        },
        {
          id: 'codex',
          models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
        },
      ])),
      runSingleQuery,
    },
    runSingleQuery,
  };
}

describe('testGenerationModel', () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('tests title settings with exact routing, effort, prompt, and timeout', async () => {
    const result = await testGenerationModel({
      target: 'chatTitle',
      configurationKey: titleConfigurationKey,
      settings: harness.settings,
      agents: harness.agents,
    });

    expect(result).toMatchObject({ success: true, target: 'chatTitle' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(harness.runSingleQuery).toHaveBeenCalledWith('Reply with exactly OK.', {
      agentId: 'direct-openai-compatible',
      model: 'glm-5.2',
      cwd: '/workspace',
      projectPath: '/workspace',
      permissionMode: 'default',
      thinkingMode: 'max',
      apiProviderId: 'alibaba',
      modelEndpointId: 'alibaba-openai',
      modelProtocol: 'openai-compatible',
      timeoutMs: 110_000,
      signal: expect.any(AbortSignal),
    });
    expect(harness.agents.getAgentAuthStatusMap).not.toHaveBeenCalled();
    expect(harness.agents.getAgentReadinessMap).not.toHaveBeenCalled();
    expect(harness.agents.getAgentCatalogEntries).not.toHaveBeenCalled();
  });

  it('resolves commit settings independently', async () => {
    await testGenerationModel({
      target: 'commitMessage',
      configurationKey: commitConfigurationKey,
      settings: harness.settings,
      agents: harness.agents,
    });

    expect(harness.runSingleQuery).toHaveBeenCalledWith(
      'Reply with exactly OK.',
      expect.objectContaining({
        agentId: 'codex',
        model: 'gpt-5.5',
        thinkingMode: 'low',
      }),
    );
  });

  it('reports unavailable when automatic resolution finds no ready agent', async () => {
    harness.settings.getUiSettings.mockImplementation(() => ({}));

    await expect(testGenerationModel({
      target: 'chatTitle',
      configurationKey: '',
      settings: harness.settings,
      agents: harness.agents,
    })).rejects.toMatchObject({
      code: 'GENERATION_TEST_UNAVAILABLE',
      status: 409,
      retryable: false,
    });
    expect(harness.runSingleQuery).not.toHaveBeenCalled();
  });

  it('maps empty, unsupported-effort, timeout, and provider failures safely', async () => {
    const cases = [
      {
        failure: '',
        code: 'GENERATION_TEST_EMPTY_RESPONSE',
        status: 502,
      },
      {
        failure: new UnsupportedSingleQueryEffortError('amp', 'high'),
        code: 'GENERATION_TEST_UNSUPPORTED_EFFORT',
        status: 422,
      },
      {
        failure: new DOMException('aborted with provider details', 'AbortError'),
        code: 'GENERATION_TEST_TIMEOUT',
        status: 504,
      },
      {
        failure: new Error('secret provider response'),
        code: 'GENERATION_TEST_FAILED',
        status: 502,
      },
    ];

    for (const testCase of cases) {
      harness.runSingleQuery.mockImplementationOnce(() => {
        if (typeof testCase.failure === 'string') return Promise.resolve(testCase.failure);
        return Promise.reject(testCase.failure);
      });

      try {
        await testGenerationModel({
          target: 'chatTitle',
          configurationKey: titleConfigurationKey,
          settings: harness.settings,
          agents: harness.agents,
        });
        throw new Error('Expected generation model test to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(GenerationModelTestError);
        expect(error.code).toBe(testCase.code);
        expect(error.status).toBe(testCase.status);
        expect(error.message).not.toContain('secret');
        expect(error.message).not.toContain('provider details');
      }
    }
  });

  it('does not classify provider messages containing timeout as transport timeouts', async () => {
    harness.runSingleQuery.mockImplementationOnce(() =>
      Promise.reject(new Error('Provider rejected the timeout option')),
    );

    await expect(testGenerationModel({
      target: 'chatTitle',
      configurationKey: titleConfigurationKey,
      settings: harness.settings,
      agents: harness.agents,
    })).rejects.toMatchObject({
      code: 'GENERATION_TEST_FAILED',
      status: 502,
    });
  });

  it('rejects a stale displayed configuration before sending a provider request', async () => {
    await expect(testGenerationModel({
      target: 'chatTitle',
      configurationKey: 'stale-configuration',
      settings: harness.settings,
      agents: harness.agents,
    })).rejects.toMatchObject({
      code: 'GENERATION_TEST_CONFIGURATION_CHANGED',
      status: 409,
    });
    expect(harness.runSingleQuery).not.toHaveBeenCalled();
  });
});
