import {
  GENERATION_AGENT_PRIORITY,
  GENERATION_MODEL_DEFAULTS,
  OPENCODE_PREFERRED_MODEL_PATTERNS,
} from '../../common/generation-defaults.ts';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentModelOption } from '../../common/agents.js';

type GenerationModelMap = Record<string, AgentModelOption[]>;
type GenerationAuthMap = Record<string, { authenticated?: boolean }>;
type GenerationReadinessMap = Record<string, { ready?: boolean }>;

interface EffectiveGenerationInput {
  persisted: unknown;
  authByAgent: GenerationAuthMap;
  modelsByAgent: GenerationModelMap;
  readinessByAgent?: GenerationReadinessMap;
}

export interface EffectiveGenerationConfig {
  enabled: boolean;
  agentId: string;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  source: 'auto' | 'manual';
}

type EffectiveGenerationUiConfig = Record<string, unknown> & EffectiveGenerationConfig;

const generationModelDefaults: Partial<Record<string, string>> = GENERATION_MODEL_DEFAULTS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAgent(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value);
}

function hasAutoModel(agentId: string, modelsByAgent: GenerationModelMap): boolean {
  if (generationModelDefaults[agentId]) return true;
  return Array.isArray(modelsByAgent?.[agentId])
    && modelsByAgent[agentId].some((model) => typeof model?.value === 'string' && model.value.trim());
}

function pickAutoAgent(
  authByAgent: GenerationAuthMap,
  readinessByAgent: GenerationReadinessMap,
  modelsByAgent: GenerationModelMap,
): string | null {
  return GENERATION_AGENT_PRIORITY.find((agentId) =>
    (authByAgent?.[agentId]?.authenticated || readinessByAgent?.[agentId]?.ready)
      && hasAutoModel(agentId, modelsByAgent)
  ) ?? null;
}

function pickPreferredOpenCodeModel(models: AgentModelOption[]): string {
  if (!Array.isArray(models) || models.length === 0) return '';
  const preferred = models.find((model) => {
    const label = typeof model?.label === 'string' ? model.label : '';
    const value = typeof model?.value === 'string' ? model.value : '';
    const text = `${label} ${value}`;
    return OPENCODE_PREFERRED_MODEL_PATTERNS.some((pattern) => pattern.test(text));
  });
  return preferred?.value || models[0]?.value || '';
}

function pickDefaultModel(agentId: string, modelsByAgent: GenerationModelMap): string {
  if (agentId === 'opencode') return pickPreferredOpenCodeModel(modelsByAgent?.opencode || []);
  return generationModelDefaults[agentId] || modelsByAgent?.[agentId]?.[0]?.value || '';
}

export function resolveEffectiveGenerationConfig({
  persisted,
  authByAgent,
  modelsByAgent,
  readinessByAgent,
}: EffectiveGenerationInput): EffectiveGenerationConfig {
  const cfg = isRecord(persisted) ? persisted : {};
  const persistedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : null;
  const persistedAgent = isAgent(cfg.agentId) ? cfg.agentId : null;
  const persistedModel = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : '';
  const persistedApiProviderId = typeof cfg.apiProviderId === 'string' ? cfg.apiProviderId : null;
  const persistedEndpointId = typeof cfg.modelEndpointId === 'string' ? cfg.modelEndpointId : null;
  const persistedProtocol = (cfg.modelProtocol === 'openai-compatible' || cfg.modelProtocol === 'anthropic-messages')
    ? cfg.modelProtocol
    : null;

  const autoAgent = pickAutoAgent(authByAgent, readinessByAgent ?? {}, modelsByAgent);
  const selectedAgent = persistedAgent || autoAgent || 'claude';
  const selectedModel = persistedModel || pickDefaultModel(selectedAgent, modelsByAgent);
  const selectedEnabled = persistedEnabled ?? Boolean(autoAgent);

  return {
    enabled: selectedEnabled,
    agentId: selectedAgent,
    model: selectedModel,
    apiProviderId: persistedApiProviderId,
    modelEndpointId: persistedEndpointId,
    modelProtocol: persistedProtocol,
    source: persistedEnabled === null && !persistedAgent && !persistedModel ? 'auto' : 'manual',
  };
}

export function resolveEffectiveGenerationUiConfig({
  persisted,
  authByAgent,
  modelsByAgent,
  readinessByAgent,
}: EffectiveGenerationInput): EffectiveGenerationUiConfig {
  const config = isRecord(persisted) ? persisted : {};
  return {
    ...config,
    ...resolveEffectiveGenerationConfig({ persisted: config, authByAgent, modelsByAgent, readinessByAgent }),
  };
}
