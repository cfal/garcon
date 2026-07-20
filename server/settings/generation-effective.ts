import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentModelOption } from '../../common/agents.js';
import { normalizeThinkingMode, type ThinkingMode } from '../../common/chat-modes.js';
import { isRecord } from '../../common/json.js';

type GenerationModelMap = Record<string, AgentModelOption[]>;
type GenerationAuthMap = Record<string, { authenticated?: boolean }>;
type GenerationReadinessMap = Record<string, { ready?: boolean }>;
type GenerationMetadataMap = Record<string, { priority: number; model: string }>;

interface EffectiveGenerationInput {
  persisted: unknown;
  authByAgent: GenerationAuthMap;
  modelsByAgent: GenerationModelMap;
  generationByAgent: GenerationMetadataMap;
  readinessByAgent?: GenerationReadinessMap;
}

export interface EffectiveGenerationConfig {
  enabled: boolean;
  agentId: string;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  thinkingMode: ThinkingMode;
  source: 'auto' | 'manual';
}

type EffectiveGenerationUiConfig = Record<string, unknown> & EffectiveGenerationConfig;

function isAgent(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value);
}

function pickAutoAgent(
  authByAgent: GenerationAuthMap,
  readinessByAgent: GenerationReadinessMap,
  generationByAgent: GenerationMetadataMap,
): string | null {
  return Object.entries(generationByAgent)
    .filter(([agentId, generation]) => (
      Number.isFinite(generation.priority)
      && Boolean(generation.model)
      && (authByAgent[agentId]?.authenticated || readinessByAgent[agentId]?.ready)
    ))
    .sort((left, right) => left[1].priority - right[1].priority || left[0].localeCompare(right[0]))
    [0]?.[0] ?? null;
}

function pickDefaultModel(
  agentId: string,
  modelsByAgent: GenerationModelMap,
  generationByAgent: GenerationMetadataMap,
): string {
  return generationByAgent[agentId]?.model || modelsByAgent[agentId]?.[0]?.value || '';
}

function modelBelongsToAgent(
  agentId: string,
  model: string,
  modelsByAgent: GenerationModelMap,
  generationByAgent: GenerationMetadataMap,
): boolean {
  if (generationByAgent[agentId]?.model === model) return true;
  const models = modelsByAgent[agentId];
  if (!Array.isArray(models) || models.length === 0) return true;
  return models.some((option) => option.value === model || option.rawModel === model);
}

export function resolveEffectiveGenerationConfig({
  persisted,
  authByAgent,
  modelsByAgent,
  generationByAgent,
  readinessByAgent,
}: EffectiveGenerationInput): EffectiveGenerationConfig {
  const cfg = isRecord(persisted) ? persisted : {};
  const persistedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : null;
  const persistedAgent = isAgent(cfg.agentId) ? cfg.agentId : null;
  const persistedModel = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : '';
  const autoAgent = pickAutoAgent(authByAgent, readinessByAgent ?? {}, generationByAgent);
  const selectedAgent = persistedAgent
    ?? autoAgent
    ?? Object.keys(generationByAgent).sort()[0]
    ?? Object.keys(modelsByAgent).sort()[0]
    ?? '';
  const persistedModelValid = persistedModel !== ''
    && modelBelongsToAgent(selectedAgent, persistedModel, modelsByAgent, generationByAgent);

  return {
    enabled: persistedEnabled ?? Boolean(autoAgent),
    agentId: selectedAgent,
    model: persistedModelValid
      ? persistedModel
      : pickDefaultModel(selectedAgent, modelsByAgent, generationByAgent),
    apiProviderId: persistedModelValid && typeof cfg.apiProviderId === 'string' ? cfg.apiProviderId : null,
    modelEndpointId: persistedModelValid && typeof cfg.modelEndpointId === 'string' ? cfg.modelEndpointId : null,
    modelProtocol: persistedModelValid
      && (cfg.modelProtocol === 'openai-compatible' || cfg.modelProtocol === 'anthropic-messages')
      ? cfg.modelProtocol
      : null,
    thinkingMode: normalizeThinkingMode(cfg.thinkingMode),
    source: persistedEnabled === null && !persistedAgent && !persistedModel ? 'auto' : 'manual',
  };
}

export function resolveEffectiveGenerationUiConfig(
  input: EffectiveGenerationInput,
): EffectiveGenerationUiConfig {
  const config = isRecord(input.persisted) ? input.persisted : {};
  return { ...config, ...resolveEffectiveGenerationConfig({ ...input, persisted: config }) };
}
