import {
  isEndpointOnlyAgentId,
  isVisibleAgentId,
  type AgentId,
  type AgentCatalogEntry,
  type AgentModelOption,
} from '../../common/agents.js';
import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS, PI_MODELS } from '../../common/models.js';
import type { ApiProviderEndpointResolver } from '../api-providers/endpoint-resolver.js';
import type { Agent, AgentModelQuery } from './types.js';
import type { AgentDirectory } from './directory.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agents:catalog-service');

const STATIC_AGENT_MODELS: Record<string, { defaultModel: string; models: AgentModelOption[] }> = {
  claude: { defaultModel: CLAUDE_MODELS.DEFAULT, models: CLAUDE_MODELS.OPTIONS },
  codex: { defaultModel: CODEX_MODELS.DEFAULT, models: CODEX_MODELS.OPTIONS },
  amp: { defaultModel: AMP_MODELS.DEFAULT, models: AMP_MODELS.OPTIONS },
  factory: { defaultModel: FACTORY_MODELS.DEFAULT, models: FACTORY_MODELS.OPTIONS },
  pi: { defaultModel: PI_MODELS.DEFAULT, models: PI_MODELS.OPTIONS },
};

function dedupeModels(models: AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  const result: AgentModelOption[] = [];
  for (const model of models) {
    if (!model.value || seen.has(model.value)) continue;
    seen.add(model.value);
    result.push(model);
  }
  return result;
}

async function nativeModelsForAgent(id: string, agent: Agent, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
  let fetched: AgentModelOption[] = [];
  const getModels = agent.capabilities.getModels;
  if (!isEndpointOnlyAgentId(id) && getModels) {
    try {
      fetched = await getModels(query);
    } catch (error) {
      if (query.strict) throw error;
      logger.warn(`agents: failed to fetch ${id} models:`, error instanceof Error ? error.message : String(error));
    }
  }
  const fallback = STATIC_AGENT_MODELS[id]?.models ?? [];
  return dedupeModels([...fetched, ...fallback]);
}

function defaultModelForAgent(id: string, nativeModels: AgentModelOption[], endpointModels: AgentModelOption[]): string {
  const fallbackDefault = STATIC_AGENT_MODELS[id]?.defaultModel;
  if (fallbackDefault && nativeModels.some((model) => model.value === fallbackDefault)) {
    return fallbackDefault;
  }
  return nativeModels[0]?.value ?? endpointModels[0]?.value ?? fallbackDefault ?? '';
}

export class AgentCatalogService {
  constructor(private readonly deps: {
    directory: AgentDirectory;
    endpointResolver: ApiProviderEndpointResolver;
  }) {}

  async getModels(agentId: string, query: AgentModelQuery = {}): Promise<AgentModelOption[]> {
    const getModels = this.deps.directory.get(agentId)?.capabilities.getModels;
    if (getModels) return getModels(query);
    return [];
  }

  modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): boolean {
    return this.deps.endpointResolver.modelSupportsImages({
      agentId: input.agentId as AgentId,
      model: input.model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
    });
  }

  hasEndpointModels(agentId: string): boolean {
    return this.deps.endpointResolver.getModelOptions(agentId as AgentId).length > 0;
  }

  async getAgentCatalogEntry(agentId: string, query: AgentModelQuery = {}): Promise<AgentCatalogEntry | null> {
    const agent = this.deps.directory.get(agentId);
    if (!agent || !isVisibleAgentId(agentId)) return null;
    const endpointModels = this.deps.endpointResolver.getModelOptions(agentId as AgentId);
    const nativeModels = await nativeModelsForAgent(agentId, agent, query);
    const models = isEndpointOnlyAgentId(agentId)
      ? dedupeModels(endpointModels)
      : dedupeModels([...nativeModels, ...endpointModels]);
    return {
      id: agentId as AgentId,
      label: agent.label,
      kind: 'agent',
      supportsFork: agent.capabilities.supportsFork,
      supportsForkAtMessage: agent.capabilities.supportsForkAtMessage,
      supportsForkWhileRunning: agent.capabilities.supportsForkWhileRunning,
      supportsUpdateProjectPath: agent.capabilities.supportsUpdateProjectPath,
      supportsImages: agent.capabilities.supportsImages,
      acceptsApiProviderEndpoints: agent.capabilities.acceptsApiProviderEndpoints,
      supportedProtocols: agent.capabilities.supportedProtocols,
      authLoginSupported: agent.capabilities.authLoginSupported,
      defaultModel: defaultModelForAgent(agentId, nativeModels, endpointModels),
      models,
    };
  }

  async getAgentCatalogEntries(): Promise<AgentCatalogEntry[]> {
    return (await Promise.all(this.deps.directory.list().map((agent) => this.getAgentCatalogEntry(agent.id))))
      .filter((entry): entry is AgentCatalogEntry => Boolean(entry));
  }
}
