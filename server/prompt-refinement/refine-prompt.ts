import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isUnsupportedSingleQueryThinkingMode } from '@garcon/server-agent-interface';
import {
  DEFAULT_PROMPT_REFINEMENT_PROMPT,
  GENERATION_PROMPT_TEMPLATE_MAX_LENGTH,
  PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
} from '../../common/generation-prompts.js';
import {
  normalizeRefinePromptRequest,
  normalizeRefinePromptResponse,
  type RefinePromptRequest,
  type RefinePromptResponse,
} from '../../common/prompt-refinement.js';
import { isRecord } from '../../common/json.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.js';
import { resolveEffectiveGenerationConfig } from '../settings/generation-effective.js';
import {
  createGenerationRequestSignal,
  GENERATION_PROVIDER_TIMEOUT_MS,
  isGenerationTimeoutError,
} from '../settings/generation-limits.js';
import type { SettingsStore } from '../settings/store.js';

const logger = createLogger('prompt-refinement');
const RENDERED_PROMPT_MAX_LENGTH = 512_000;

type PromptRefinementErrorCode =
  | 'PROMPT_REFINEMENT_INVALID_REQUEST'
  | 'PROMPT_REFINEMENT_UNAVAILABLE'
  | 'PROMPT_REFINEMENT_UNSAFE_AGENT'
  | 'PROMPT_REFINEMENT_INVALID_TEMPLATE'
  | 'PROMPT_REFINEMENT_UNSUPPORTED_EFFORT'
  | 'PROMPT_REFINEMENT_EMPTY_RESPONSE'
  | 'PROMPT_REFINEMENT_OUTPUT_TOO_LARGE'
  | 'PROMPT_REFINEMENT_TIMEOUT'
  | 'PROMPT_REFINEMENT_FAILED';

export class PromptRefinementError extends DomainError {
  constructor(
    code: PromptRefinementErrorCode,
    message: string,
    status: number,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(code, message, status, retryable, options);
    this.name = 'PromptRefinementError';
  }
}

interface PromptRefinementLogger {
  info(message: string, metadata: Record<string, unknown>): void;
  warn(message: string, metadata: Record<string, unknown>): void;
}

interface PromptRefinementDependencies {
  settings: Pick<SettingsStore, 'getUiSettings'>;
  agents: AgentRegistryServiceContract;
  log?: PromptRefinementLogger;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function configuredTemplate(persisted: unknown): string {
  if (!isRecord(persisted) || !Object.hasOwn(persisted, 'customPrompt')) {
    return DEFAULT_PROMPT_REFINEMENT_PROMPT;
  }
  if (typeof persisted.customPrompt !== 'string') {
    throw new PromptRefinementError(
      'PROMPT_REFINEMENT_INVALID_TEMPLATE',
      'The saved prompt refinement template is invalid.',
      409,
    );
  }
  if (!persisted.customPrompt.trim()) return DEFAULT_PROMPT_REFINEMENT_PROMPT;
  if (
    persisted.customPrompt.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH
    || !persisted.customPrompt.includes(PROMPT_REFINEMENT_USER_PROMPT_TOKEN)
  ) {
    throw new PromptRefinementError(
      'PROMPT_REFINEMENT_INVALID_TEMPLATE',
      `The saved prompt refinement template must include ${PROMPT_REFINEMENT_USER_PROMPT_TOKEN}.`,
      409,
    );
  }
  return persisted.customPrompt;
}

function renderTemplate(template: string, draft: string): string {
  const rendered = template.replaceAll(
    PROMPT_REFINEMENT_USER_PROMPT_TOKEN,
    () => draft,
  );
  if (rendered.length > RENDERED_PROMPT_MAX_LENGTH) {
    throw new PromptRefinementError(
      'PROMPT_REFINEMENT_INVALID_TEMPLATE',
      'The saved prompt refinement template expands beyond the supported input size.',
      409,
    );
  }
  return rendered;
}

export async function refinePrompt(
  request: RefinePromptRequest,
  dependencies: PromptRefinementDependencies,
  signal?: AbortSignal,
): Promise<RefinePromptResponse> {
  const input = normalizeRefinePromptRequest(request);
  if (!input) {
    throw new PromptRefinementError(
      'PROMPT_REFINEMENT_INVALID_REQUEST',
      'A non-empty draft within the supported size limit is required.',
      400,
    );
  }

  const startedAt = performance.now();
  const generationSignal = createGenerationRequestSignal(signal);
  const log = dependencies.log ?? logger;
  let selection: ReturnType<typeof resolveEffectiveGenerationConfig> | null = null;

  try {
    const ui = dependencies.settings.getUiSettings() ?? {};
    const persisted = ui.promptRefinement;
    const context = await resolveGenerationContextForSelection(
      dependencies.agents,
      persisted,
      generationSignal,
    );
    selection = resolveEffectiveGenerationConfig({ persisted, ...context });
    if (!selection.agentId || !selection.model || (selection.source === 'auto' && !selection.enabled)) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_UNAVAILABLE',
        'No prompt refinement model is configured or ready.',
        409,
      );
    }
    if (dependencies.agents.singleQueryRunsToolsWithoutPermission(selection.agentId)) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_UNSAFE_AGENT',
        'The selected agent cannot safely refine untrusted prompt text.',
        422,
      );
    }

    generationSignal.throwIfAborted();
    const prompt = renderTemplate(configuredTemplate(persisted), input.draft);
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'garcon-prompt-refinement-'),
    );
    let output: string;
    try {
      output = await dependencies.agents.runSingleQuery(prompt, {
        agentId: selection.agentId,
        model: selection.model,
        cwd: temporaryDirectory,
        projectPath: temporaryDirectory,
        permissionMode: 'plan',
        thinkingMode: selection.thinkingMode,
        apiProviderId: selection.apiProviderId,
        modelEndpointId: selection.modelEndpointId,
        modelProtocol: selection.modelProtocol,
        timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS,
        signal: generationSignal,
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }

    const response = normalizeRefinePromptResponse({
      success: true,
      refinedPrompt: output,
    });
    if (!output.trim()) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_EMPTY_RESPONSE',
        'The prompt refinement model returned an empty response.',
        502,
        true,
      );
    }
    if (!response) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_OUTPUT_TOO_LARGE',
        'The prompt refinement model returned more text than the composer supports.',
        502,
        true,
      );
    }

    log.info('prompt refinement completed', {
      agentId: selection.agentId,
      model: selection.model,
      thinkingMode: selection.thinkingMode,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: 'success',
    });
    return response;
  } catch (error) {
    const cancelled = signal?.aborted === true;
    const outcome = cancelled
      ? 'cancelled'
      : error instanceof PromptRefinementError
        ? error.code.toLowerCase().replace('prompt_refinement_', '').replaceAll('_', '-')
        : isUnsupportedSingleQueryThinkingMode(error)
          ? 'unsupported-effort'
          : isGenerationTimeoutError(error)
            ? 'timeout'
            : 'failed';
    log.warn('prompt refinement did not complete', {
      agentId: selection?.agentId ?? 'unresolved',
      model: selection?.model ?? 'unresolved',
      thinkingMode: selection?.thinkingMode ?? 'none',
      durationMs: Math.round(performance.now() - startedAt),
      outcome,
    });

    if (cancelled && signal) throw abortReason(signal);
    if (error instanceof PromptRefinementError) throw error;
    if (isUnsupportedSingleQueryThinkingMode(error)) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_UNSUPPORTED_EFFORT',
        'The selected agent cannot use this effort for one-shot generation.',
        422,
        false,
        { cause: error },
      );
    }
    if (isGenerationTimeoutError(error)) {
      throw new PromptRefinementError(
        'PROMPT_REFINEMENT_TIMEOUT',
        'Prompt refinement timed out.',
        504,
        true,
        { cause: error },
      );
    }
    throw new PromptRefinementError(
      'PROMPT_REFINEMENT_FAILED',
      'Prompt refinement failed. Check the configured provider and model.',
      502,
      true,
      { cause: error },
    );
  }
}
