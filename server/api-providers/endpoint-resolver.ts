// Resolves API-provider endpoint metadata for agents. Answers which
// model options are exposed to each agent and builds routing
// metadata for compatible endpoint execution.

import type {
  AgentId,
  AgentModelOption,
} from '../../common/agents.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentEndpointSelection } from '../../common/agent-execution.js';
import { effectiveNodeId } from '../../common/execution-nodes.js';
import { DomainError } from '../lib/domain-error.js';
import {
  endpointModelOptionValue,
  rawModelFromEndpointOptionValue,
} from '../../common/model-routing.js';
import type {
  StoredApiProvider,
  StoredApiProviderEndpoint,
} from "./store.js";

export interface ResolvedModelSelection {
  model: string;
  apiProviderId: string | null;
  endpointId: string | null;
  protocol: ApiProtocol | null;
  isLocal: boolean;
  nodeId?: string;
  endpoint?: AgentEndpointSelection;
}

export type ModelSelectionErrorCode =
  | 'SELECTION_INCOMPLETE'
  | 'API_PROVIDER_NOT_FOUND'
  | 'ENDPOINT_NOT_FOUND'
  | 'ENDPOINT_NOT_EXPOSED'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'MODEL_NOT_FOUND';

export class ModelSelectionError extends Error {
  constructor(message: string, readonly code: ModelSelectionErrorCode) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}

export class ApiProviderEndpointResolver {
  constructor(
    private readonly getApiProviders: (nodeId: string) => StoredApiProvider[],
    private readonly getSupportedProtocols: (agentId: AgentId, nodeId: string) => readonly string[] = () => [],
    private readonly getHistoricalProviders: () => StoredApiProvider[] = () => getApiProviders('local'),
  ) {}

  getModelOptions(agentId: AgentId, nodeId = 'local'): AgentModelOption[] {
    let providers: StoredApiProvider[];
    try {
      providers = this.getApiProviders(nodeId);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'API_PROVIDER_STORAGE_UNAVAILABLE') return [];
      throw error;
    }
    const options: AgentModelOption[] = [];
    for (const apiProvider of providers) {
      for (const endpoint of apiProvider.endpoints) {
        if (!this.#endpointSupportsAgent(agentId, endpoint, nodeId)) continue;
        for (const model of endpoint.models) {
          const rawModel = model.rawModel || model.value;
          options.push({
            ...model,
            value: endpointModelOptionValue(endpoint.id, rawModel),
            label: `${apiProvider.label}: ${model.label}`,
            rawModel,
            apiProviderId: apiProvider.id,
            endpointId: endpoint.id,
            protocol: endpoint.protocol,
            isLocal: model.isLocal === true || endpoint.modelDiscovery === 'ollama-tags' || apiProvider.templateId === 'ollama',
            supportsImages: model.supportsImages ?? endpoint.supportsImages,
          });
        }
      }
    }
    return options;
  }

  resolveSelection(input: {
    nodeId?: string | null;
    agentId?: AgentId;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): ResolvedModelSelection {
    const agentId = input.agentId;
    if (!agentId) {
      throw new ModelSelectionError('agentId is required for model selection', 'SELECTION_INCOMPLETE');
    }
    if (!input.apiProviderId && !input.modelEndpointId) {
      return {
        model: input.model,
        apiProviderId: null,
        endpointId: null,
        protocol: null,
        isLocal: false,
      };
    }
    if (!input.apiProviderId || !input.modelEndpointId) {
      throw new ModelSelectionError('API provider selections require apiProviderId and modelEndpointId.', 'SELECTION_INCOMPLETE');
    }

    const nodeId = effectiveNodeId(input.nodeId);
    const resolved = this.#requireEndpoint(input.apiProviderId, input.modelEndpointId, nodeId);
    this.#assertEndpointCompatible(agentId, resolved.endpoint, nodeId);

    const matchedModel = this.#resolveModel(resolved.apiProvider, resolved.endpoint, input.model);
    return {
      model: matchedModel.rawModel,
      apiProviderId: resolved.apiProvider.id,
      endpointId: resolved.endpoint.id,
      protocol: resolved.endpoint.protocol,
      isLocal: matchedModel.isLocal,
      nodeId,
      endpoint: buildEndpointSelection(resolved.apiProvider, resolved.endpoint, matchedModel),
    };
  }

  modelSupportsImages(input: {
    nodeId?: string | null;
    agentId?: AgentId;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): boolean {
    const agentId = input.agentId;
    if (!agentId || !input.apiProviderId || !input.modelEndpointId) return false;
    const nodeId = effectiveNodeId(input.nodeId);
    const resolved = this.#requireEndpoint(input.apiProviderId, input.modelEndpointId, nodeId);
    this.#assertEndpointCompatible(agentId, resolved.endpoint, nodeId);
    const selectedRawModel = rawModelFromEndpointOptionValue(resolved.endpoint.id, input.model);
    const matched = resolved.endpoint.models.find((m) => {
      const rawModel = m.rawModel || m.value;
      return m.value === input.model || rawModel === selectedRawModel;
    });
    return matched?.supportsImages ?? resolved.endpoint.supportsImages;
  }

  resolveEndpointReference(selection: ResolvedModelSelection): {
    apiProvider: StoredApiProvider;
    endpoint: StoredApiProviderEndpoint;
  } | null {
    if (!selection.apiProviderId || !selection.endpointId) return null;
    const reference = this.#requireEndpoint(selection.apiProviderId, selection.endpointId, effectiveNodeId(selection.nodeId));
    if (selection.endpoint && reference.apiProvider.revision !== selection.endpoint.credential?.revision) {
      throw new DomainError('API_PROVIDER_CONFIGURATION_CHANGED', 'Provider configuration changed. Refresh and try again.', 409);
    }
    return reference;
  }

  describePrevious(input: {
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): ResolvedModelSelection {
    if (!input.apiProviderId && !input.modelEndpointId) {
      return { model: input.model, apiProviderId: null, endpointId: null, protocol: null, isLocal: false };
    }
    const profile = this.getHistoricalProviders().find((entry) => entry.id === input.apiProviderId);
    const endpoint = profile?.endpoints.find((entry) => entry.id === input.modelEndpointId);
    if (!profile || !endpoint) {
      throw new DomainError('API_PROVIDER_UNAVAILABLE', 'The previous provider is missing. Start a new chat to change its execution configuration.', 409);
    }
    const rawModel = rawModelFromEndpointOptionValue(endpoint.id, input.model);
    const model = endpoint.models.find((entry) => (entry.rawModel || entry.value) === rawModel);
    if (!model && endpoint.modelDiscovery !== 'ollama-tags' && profile.templateId !== 'ollama') {
      throw new DomainError('API_PROVIDER_UNAVAILABLE', 'The previous model classification is unknown. Start a new chat to change its execution configuration.', 409);
    }
    const isLocal = model?.isLocal === true || endpoint.modelDiscovery === 'ollama-tags' || profile.templateId === 'ollama';
    return {
      model: input.model,
      apiProviderId: profile.id,
      endpointId: endpoint.id,
      protocol: endpoint.protocol,
      isLocal,
      endpoint: buildEndpointSelection(profile, endpoint, { rawModel, isLocal }),
    };
  }

  #requireEndpoint(apiProviderId: string, endpointId: string, nodeId: string): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } {
    const apiProvider = this.getApiProviders(nodeId).find((entry) => entry.id === apiProviderId);
    if (!apiProvider) {
      throw new DomainError('API_PROVIDER_UNAVAILABLE', 'This provider is unavailable on the selected execution node.', 409);
    }
    const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
    if (!endpoint) {
      throw new ModelSelectionError(`Unknown API provider endpoint: ${endpointId}`, 'ENDPOINT_NOT_FOUND');
    }
    return { apiProvider, endpoint };
  }

  #assertEndpointCompatible(agentId: AgentId, endpoint: StoredApiProviderEndpoint, nodeId: string): void {
    if (!this.#endpointSupportsAgent(agentId, endpoint, nodeId)) {
      throw new ModelSelectionError(
        `${endpoint.protocol} endpoint cannot be used with ${agentId}.`,
        'ENDPOINT_NOT_EXPOSED',
      );
    }
  }

  #endpointSupportsAgent(agentId: AgentId, endpoint: StoredApiProviderEndpoint, nodeId: string): boolean {
    return this.getSupportedProtocols(agentId, nodeId).includes(endpoint.protocol);
  }

  #resolveModel(apiProvider: StoredApiProvider, endpoint: StoredApiProviderEndpoint, selectedModel: string): {
    rawModel: string;
    isLocal: boolean;
  } {
    const selectedRawModel = rawModelFromEndpointOptionValue(endpoint.id, selectedModel);
    const matched = endpoint.models.find((model) => {
      const rawModel = model.rawModel || model.value;
      return model.value === selectedModel || rawModel === selectedRawModel;
    });
    if (!matched) {
      throw new ModelSelectionError(`Model is not exposed by endpoint ${endpoint.id}: ${selectedModel}`, 'MODEL_NOT_FOUND');
    }
    return {
      rawModel: matched.rawModel || matched.value,
      isLocal: matched.isLocal === true || endpoint.modelDiscovery === 'ollama-tags' || apiProvider.templateId === 'ollama',
    };
  }
}

function buildEndpointSelection(
  profile: StoredApiProvider,
  endpoint: StoredApiProviderEndpoint,
  model: { rawModel: string; isLocal: boolean },
): AgentEndpointSelection {
  return {
    apiProviderId: profile.id,
    endpointId: endpoint.id,
    providerLabel: profile.label,
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    model: model.rawModel,
    isLocal: model.isLocal,
    capabilities: endpoint.capabilities ?? null,
    headers: { ...endpoint.headers },
    credential: {
      kind: 'api-provider-endpoint',
      apiProviderId: profile.id,
      endpointId: endpoint.id,
      revision: profile.revision,
    },
  };
}

export function assertSameApiProviderBoundary(previous: ResolvedModelSelection, next: ResolvedModelSelection): void {
  if (previous.isLocal !== next.isLocal) {
    const direction = previous.isLocal ? 'local to cloud' : 'cloud to local';
    throw new Error(`Cannot switch from ${direction} model mid-session. Start a new chat to use this model.`);
  }
}
