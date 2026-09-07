import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generationModelTestConfigurationKey,
  type GenerationModelTestResponse,
  type GenerationTestTarget,
} from '../../common/generation-test-contracts.js';
import { isUnsupportedSingleQueryThinkingMode } from '@garcon/server-agent-interface';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { SettingsStore } from './store.js';
import { resolveGenerationContextForSelection } from './generation-config-source.ts';
import { resolveEffectiveGenerationConfig } from './generation-effective.js';
import {
  createGenerationRequestSignal,
  GENERATION_PROVIDER_TIMEOUT_MS,
  isGenerationTimeoutError,
} from './generation-limits.js';

const GENERATION_TEST_PROMPT = 'Reply with exactly OK. Do not use tools.';
const logger = createLogger('settings:generation-model-test');

type GenerationModelTestErrorCode =
  | 'GENERATION_TEST_UNAVAILABLE'
  | 'GENERATION_TEST_CONFIGURATION_CHANGED'
  | 'GENERATION_TEST_UNSUPPORTED_EFFORT'
  | 'GENERATION_TEST_UNSAFE_AGENT'
  | 'GENERATION_TEST_EMPTY_RESPONSE'
  | 'GENERATION_TEST_TIMEOUT'
  | 'GENERATION_TEST_FAILED';

export class GenerationModelTestError extends DomainError {
  constructor(
    code: GenerationModelTestErrorCode,
    message: string,
    status: number,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(code, message, status, retryable, options);
    this.name = 'GenerationModelTestError';
  }
}

function classifyGenerationModelTestError(error: unknown): GenerationModelTestError {
  if (error instanceof GenerationModelTestError) return error;
  if (isUnsupportedSingleQueryThinkingMode(error)) {
    return new GenerationModelTestError(
      'GENERATION_TEST_UNSUPPORTED_EFFORT',
      'This agent cannot use the selected effort for one-shot generation.',
      422,
      false,
      { cause: error },
    );
  }
  if (isGenerationTimeoutError(error)) {
    return new GenerationModelTestError(
      'GENERATION_TEST_TIMEOUT',
      'The model test timed out.',
      504,
      true,
      { cause: error },
    );
  }
  return new GenerationModelTestError(
    'GENERATION_TEST_FAILED',
    'Model test failed. Check the provider, model, protocol, and effort.',
    502,
    true,
    { cause: error },
  );
}

export async function testGenerationModel(input: {
  target: GenerationTestTarget;
  configurationKey: string;
  settings: Pick<SettingsStore, 'getUiSettings'>;
  agents: AgentRegistryServiceContract;
  signal?: AbortSignal;
}): Promise<GenerationModelTestResponse> {
  const startedAt = performance.now();
  const generationSignal = createGenerationRequestSignal(input.signal);
  let config: ReturnType<typeof resolveEffectiveGenerationConfig> | null = null;
  try {
    const ui = input.settings.getUiSettings() ?? {};
    const persisted = ui[input.target];
    const persistedConfigurationKey = generationModelTestConfigurationKey(
      persisted && typeof persisted === 'object' ? persisted : {},
    );
    const generationContext = await resolveGenerationContextForSelection(
      input.agents,
      persisted,
      generationSignal,
    );
    config = resolveEffectiveGenerationConfig({ persisted, ...generationContext });

    const currentUi = input.settings.getUiSettings() ?? {};
    const currentPersisted = currentUi[input.target];
    if (generationModelTestConfigurationKey(
      currentPersisted && typeof currentPersisted === 'object' ? currentPersisted : {},
    ) !== persistedConfigurationKey) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_CONFIGURATION_CHANGED',
        'Generation settings changed before the test started.',
        409,
      );
    }

    if (!config.agentId || !config.model || (config.source === 'auto' && !config.enabled)) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_UNAVAILABLE',
        'No generation model is configured or ready.',
        409,
      );
    }
    if (generationModelTestConfigurationKey(config) !== input.configurationKey) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_CONFIGURATION_CHANGED',
        'Generation settings changed before the test started.',
        409,
      );
    }
    if (
      input.target === 'promptRefinement'
      && input.agents.singleQueryRunsToolsWithoutPermission(config.agentId)
    ) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_UNSAFE_AGENT',
        'This agent cannot safely refine untrusted prompt text.',
        422,
      );
    }

    generationSignal.throwIfAborted();
    const testDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-generation-model-test-'));
    let output: string;
    try {
      output = await input.agents.runSingleQuery(GENERATION_TEST_PROMPT, {
        agentId: config.agentId,
        model: config.model,
        cwd: testDirectory,
        projectPath: testDirectory,
        permissionMode: 'plan',
        thinkingMode: config.thinkingMode,
        apiProviderId: config.apiProviderId,
        modelEndpointId: config.modelEndpointId,
        modelProtocol: config.modelProtocol,
        timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
        signal: generationSignal,
      });
    } finally {
      await fs.rm(testDirectory, { recursive: true, force: true });
    }

    if (!output.trim()) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_EMPTY_RESPONSE',
        'The model returned an empty response.',
        502,
        true,
      );
    }

    const durationMs = Math.round(performance.now() - startedAt);
    logger.info('generation model test completed', {
      target: input.target,
      agentId: config.agentId,
      model: config.model,
      thinkingMode: config.thinkingMode,
      durationMs,
      outcome: 'success',
    });
    return { success: true, target: input.target, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const failure = classifyGenerationModelTestError(error);
    const outcome = failure.code
      .toLowerCase()
      .replace('generation_test_', '')
      .replaceAll('_', '-');
    logger.warn('generation model test failed', {
      target: input.target,
      agentId: config?.agentId ?? 'unresolved',
      model: config?.model ?? 'unresolved',
      thinkingMode: config?.thinkingMode ?? 'none',
      durationMs,
      outcome,
    });
    throw failure;
  }
}
