import { performance } from 'node:perf_hooks';
import type {
  GenerationModelTestResponse,
  GenerationTestTarget,
} from '../../common/generation-test-contracts.js';
import { getProjectBasePath } from '../config.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { UnsupportedSingleQueryEffortError } from '../agents/single-query-errors.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import type { SettingsStore } from './store.js';
import { resolveGenerationContext } from './generation-config-source.ts';
import { resolveEffectiveGenerationConfig } from './generation-effective.js';
import { GENERATION_PROVIDER_TIMEOUT_MS } from './generation-limits.js';

const GENERATION_TEST_PROMPT = 'Reply with exactly OK.';
const logger = createLogger('settings:generation-model-test');

type GenerationModelTestErrorCode =
  | 'GENERATION_TEST_UNAVAILABLE'
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
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return name === 'aborterror'
    || name === 'timeouterror'
    || message.includes('timed out')
    || message.includes('timeout');
}

export async function testGenerationModel(input: {
  target: GenerationTestTarget;
  settings: Pick<SettingsStore, 'getUiSettings'>;
  agents: AgentRegistryServiceContract;
}): Promise<GenerationModelTestResponse> {
  const ui = input.settings.getUiSettings() ?? {};
  const generationContext = await resolveGenerationContext(input.agents);
  const config = resolveEffectiveGenerationConfig({
    persisted: ui[input.target],
    ...generationContext,
  });

  if (!config.agentId || !config.model || (config.source === 'auto' && !config.enabled)) {
    throw new GenerationModelTestError(
      'GENERATION_TEST_UNAVAILABLE',
      'No generation model is configured or ready.',
      409,
    );
  }

  const startedAt = performance.now();
  try {
    const projectPath = getProjectBasePath();
    const output = await input.agents.runSingleQuery(GENERATION_TEST_PROMPT, {
      agentId: config.agentId,
      model: config.model,
      cwd: projectPath,
      projectPath,
      permissionMode: 'default',
      thinkingMode: config.thinkingMode,
      apiProviderId: config.apiProviderId,
      modelEndpointId: config.modelEndpointId,
      modelProtocol: config.modelProtocol,
      timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
    });

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
    if (error instanceof GenerationModelTestError) throw error;

    const durationMs = Math.round(performance.now() - startedAt);
    const outcome = error instanceof UnsupportedSingleQueryEffortError
      ? 'unsupported-effort'
      : isTimeoutError(error)
        ? 'timeout'
        : 'failed';
    logger.warn('generation model test failed', {
      target: input.target,
      agentId: config.agentId,
      model: config.model,
      thinkingMode: config.thinkingMode,
      durationMs,
      outcome,
    });

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
