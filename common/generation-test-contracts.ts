import { normalizeThinkingMode } from './chat-modes.js';

export const GENERATION_TEST_TARGETS = ['chatTitle', 'commitMessage'] as const;

export type GenerationTestTarget = typeof GENERATION_TEST_TARGETS[number];

export function isGenerationTestTarget(value: unknown): value is GenerationTestTarget {
  return typeof value === 'string'
    && GENERATION_TEST_TARGETS.some((target) => target === value);
}

export interface GenerationModelTestRequest {
  target: GenerationTestTarget;
  configurationKey: string;
}

export interface GenerationModelTestResponse {
  success: true;
  target: GenerationTestTarget;
  durationMs: number;
}

export function generationModelTestConfigurationKey(config: {
  agentId?: unknown;
  model?: unknown;
  apiProviderId?: unknown;
  modelEndpointId?: unknown;
  modelProtocol?: unknown;
  thinkingMode?: unknown;
}): string {
  return JSON.stringify({
    agentId: typeof config.agentId === 'string' ? config.agentId : '',
    model: typeof config.model === 'string' ? config.model : '',
    apiProviderId: typeof config.apiProviderId === 'string' ? config.apiProviderId : null,
    modelEndpointId: typeof config.modelEndpointId === 'string' ? config.modelEndpointId : null,
    modelProtocol: typeof config.modelProtocol === 'string' ? config.modelProtocol : null,
    thinkingMode: normalizeThinkingMode(config.thinkingMode),
  });
}
