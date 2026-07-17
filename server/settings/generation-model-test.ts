import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generationModelTestConfigurationKey,
  type GenerationModelTestResponse,
  type GenerationTestTarget,
} from '../../common/generation-test-contracts.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { UnsupportedSingleQueryEffortError } from '../agents/single-query-errors.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { SettingsStore } from './store.js';
import { resolveGenerationContextForSelection } from './generation-config-source.ts';
import { resolveEffectiveGenerationConfig } from './generation-effective.js';
import {
  createGenerationRequestSignal,
  GENERATION_PROVIDER_TIMEOUT_MS,
} from './generation-limits.js';

const GENERATION_TEST_PROMPT = 'Reply with exactly OK. Do not use tools.';
const logger = createLogger('settings:generation-model-test');

type GenerationModelTestErrorCode =
  | 'GENERATION_TEST_UNAVAILABLE'
  | 'GENERATION_TEST_CONFIGURATION_CHANGED'
  | 'GENERATION_TEST_UNSUPPORTED_EFFORT'
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

function isTimeoutError(error: unknown): boolean {
  const timeoutCodes = new Set([
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]);
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      const name = current.name.toLowerCase();
      if (name === 'aborterror' || name === 'timeouterror') return true;
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string' && timeoutCodes.has(code.toUpperCase())) return true;
      current = current.cause;
      continue;
    }
    return false;
  }
  return false;
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
    const outcome = error instanceof GenerationModelTestError
      ? error.code.toLowerCase().replace('generation_test_', '').replaceAll('_', '-')
      : error instanceof UnsupportedSingleQueryEffortError
        ? 'unsupported-effort'
        : isTimeoutError(error)
          ? 'timeout'
          : 'failed';
    logger.warn('generation model test failed', {
      target: input.target,
      agentId: config?.agentId ?? 'unresolved',
      model: config?.model ?? 'unresolved',
      thinkingMode: config?.thinkingMode ?? 'none',
      durationMs,
      outcome,
    });

    if (error instanceof GenerationModelTestError) throw error;

    if (error instanceof UnsupportedSingleQueryEffortError) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_UNSUPPORTED_EFFORT',
        'This agent cannot use the selected effort for one-shot generation.',
        422,
        false,
        { cause: error },
      );
    }
    if (isTimeoutError(error)) {
      throw new GenerationModelTestError(
        'GENERATION_TEST_TIMEOUT',
        'The model test timed out.',
        504,
        true,
        { cause: error },
      );
    }
    throw new GenerationModelTestError(
      'GENERATION_TEST_FAILED',
      'Model test failed. Check the provider, model, protocol, and effort.',
      502,
      true,
      { cause: error },
    );
  }
}
