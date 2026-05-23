// Resolves API-provider endpoint metadata for agents. Answers which
// model options are exposed to each agent and builds routing
// metadata for compatible endpoint execution.

import type {
  AgentId,
  AgentModelOption,
} from '../../common/agents.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import {
  endpointModelOptionValue,
  endpointSupportsAgent,
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
  constructor(private readonly getApiProviders: () => StoredApiProvider[]) {}

  getModelOptions(agentId: AgentId): AgentModelOption[] {
    const options: AgentModelOption[] = [];
    for (const apiProvider of this.getApiProviders()) {
      for (const endpoint of apiProvider.endpoints) {
        if (!endpointSupportsAgent(agentId, endpoint)) continue;
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

    const resolved = this.#requireEndpoint(input.apiProviderId, input.modelEndpointId);
    this.#assertEndpointCompatible(agentId, resolved.endpoint);

    const matchedModel = this.#resolveModel(resolved.apiProvider, resolved.endpoint, input.model);
    return {
      model: matchedModel.rawModel,
      apiProviderId: resolved.apiProvider.id,
      endpointId: resolved.endpoint.id,
      protocol: resolved.endpoint.protocol,
      isLocal: matchedModel.isLocal,
    };
  }

  modelSupportsImages(input: {
    agentId?: AgentId;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): boolean {
    const agentId = input.agentId;
    if (!agentId || !input.apiProviderId || !input.modelEndpointId) return false;
    const resolved = this.#requireEndpoint(input.apiProviderId, input.modelEndpointId);
    this.#assertEndpointCompatible(agentId, resolved.endpoint);
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
    return this.#requireEndpoint(selection.apiProviderId, selection.endpointId);
  }

  #requireEndpoint(apiProviderId: string, endpointId: string): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } {
    const apiProvider = this.getApiProviders().find((entry) => entry.id === apiProviderId);
    if (!apiProvider) {
      throw new ModelSelectionError(`Unknown API provider: ${apiProviderId}`, 'API_PROVIDER_NOT_FOUND');
    }
    const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
    if (!endpoint) {
      throw new ModelSelectionError(`Unknown API provider endpoint: ${endpointId}`, 'ENDPOINT_NOT_FOUND');
    }
    return { apiProvider, endpoint };
  }

  #assertEndpointCompatible(agentId: AgentId, endpoint: StoredApiProviderEndpoint): void {
    if (!endpointSupportsAgent(agentId, endpoint)) {
      throw new ModelSelectionError(
        `${endpoint.protocol} endpoint cannot be used with ${agentId}.`,
        'ENDPOINT_NOT_EXPOSED',
      );
    }
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

export function assertSameApiProviderBoundary(previous: ResolvedModelSelection, next: ResolvedModelSelection): void {
  if (previous.isLocal !== next.isLocal) {
    const direction = previous.isLocal ? 'local to cloud' : 'cloud to local';
    throw new Error(`Cannot switch from ${direction} model mid-session. Start a new chat to use this model.`);
  }
}
