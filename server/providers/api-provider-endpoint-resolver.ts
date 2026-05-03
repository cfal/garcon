// Resolves API-provider endpoint metadata for harnesses. Answers which
// model options are exposed to each harness and builds env
// overrides for compatible endpoint routing.

import type {
  HarnessId,
  ApiProtocol,
  HarnessModelOption,
} from '../../common/providers.js';
import {
  endpointModelOptionValue,
  isHarnessCompatibleWithProtocol,
  rawModelFromEndpointOptionValue,
} from '../../common/providers.js';
import type {
  StoredApiProvider,
  StoredApiProviderEndpoint,
} from './api-provider-store.js';

export interface ResolvedModelSelection {
  model: string;
  apiProviderId: string | null;
  endpointId: string | null;
  protocol: ApiProtocol | null;
  isLocal: boolean;
  envOverrides?: Record<string, string>;
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

  getModelOptions(harnessId: HarnessId): HarnessModelOption[] {
    const options: HarnessModelOption[] = [];
    for (const apiProvider of this.getApiProviders()) {
      for (const endpoint of apiProvider.endpoints) {
        if (!endpoint.exposeTo.includes(harnessId)) continue;
        if (!isHarnessCompatibleWithProtocol(harnessId, endpoint.protocol)) continue;
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
    harnessId?: HarnessId;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): ResolvedModelSelection {
    const harnessId = input.harnessId;
    if (!harnessId) {
      throw new ModelSelectionError('harnessId is required for model selection', 'SELECTION_INCOMPLETE');
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
    this.#assertEndpointCompatible(harnessId, resolved.endpoint);

    const matchedModel = this.#resolveModel(resolved.apiProvider, resolved.endpoint, input.model);
    const envOverrides = buildEnvOverrides(harnessId, resolved.endpoint);
    return {
      model: matchedModel.rawModel,
      apiProviderId: resolved.apiProvider.id,
      endpointId: resolved.endpoint.id,
      protocol: resolved.endpoint.protocol,
      isLocal: matchedModel.isLocal,
      envOverrides,
    };
  }

  modelSupportsImages(input: {
    harnessId?: HarnessId;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): boolean {
    const harnessId = input.harnessId;
    if (!harnessId || !input.apiProviderId || !input.modelEndpointId) return false;
    const resolved = this.#requireEndpoint(input.apiProviderId, input.modelEndpointId);
    this.#assertEndpointCompatible(harnessId, resolved.endpoint);
    const selectedRawModel = rawModelFromEndpointOptionValue(resolved.endpoint.id, input.model);
    const matched = resolved.endpoint.models.find((m) => {
      const rawModel = m.rawModel || m.value;
      return m.value === input.model || rawModel === selectedRawModel;
    });
    return matched?.supportsImages ?? resolved.endpoint.supportsImages;
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

  #assertEndpointCompatible(harnessId: HarnessId, endpoint: StoredApiProviderEndpoint): void {
    if (!endpoint.exposeTo.includes(harnessId)) {
      throw new ModelSelectionError(
        `${endpoint.protocol} endpoint is not exposed to ${harnessId}.`,
        'ENDPOINT_NOT_EXPOSED',
      );
    }
    if (!isHarnessCompatibleWithProtocol(harnessId, endpoint.protocol)) {
      throw new ModelSelectionError(
        `${endpoint.protocol} endpoint cannot be used with ${harnessId}.`,
        'PROTOCOL_INCOMPATIBLE',
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

function buildEnvOverrides(
  harnessId: HarnessId,
  endpoint: StoredApiProviderEndpoint,
): Record<string, string> | undefined {
  if (harnessId === 'claude' && endpoint.protocol === 'anthropic-messages') {
    return {
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      ...(endpoint.apiKey ? { ANTHROPIC_AUTH_TOKEN: endpoint.apiKey } : {}),
      ANTHROPIC_API_KEY: '',
    };
  }

  if (harnessId === 'codex' && endpoint.protocol === 'openai-chat-completions') {
    return {
      OPENAI_BASE_URL: endpoint.baseUrl,
      ...(endpoint.apiKey ? { OPENAI_API_KEY: endpoint.apiKey } : {}),
    };
  }

  return undefined;
}

export function assertSameApiProviderBoundary(previous: ResolvedModelSelection, next: ResolvedModelSelection): void {
  if (previous.isLocal !== next.isLocal) {
    const direction = previous.isLocal ? 'local to cloud' : 'cloud to local';
    throw new Error(`Cannot switch from ${direction} model mid-session. Start a new chat to use this model.`);
  }
}
