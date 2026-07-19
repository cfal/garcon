import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { ApiProviderReader } from './api-providers.js';
import type { StoredApiProvider, StoredApiProviderEndpoint } from './types.js';

export class MutableApiProviderReader implements ApiProviderReader {
  readonly #providers = new Map<string, StoredApiProvider>();

  list(): StoredApiProvider[] {
    return [...this.#providers.values()];
  }

  getEndpoint(endpointId: string) {
    for (const apiProvider of this.#providers.values()) {
      const endpoint = apiProvider.endpoints.find((candidate) => candidate.id === endpointId);
      if (endpoint) return { apiProvider, endpoint };
    }
    return null;
  }

  register(selection: AgentEndpointSelection, credential: string): void {
    const endpoint: StoredApiProviderEndpoint = {
      id: selection.endpointId,
      protocol: selection.protocol,
      baseUrl: selection.baseUrl,
      apiKey: credential,
      defaultModel: selection.model,
      models: [{ value: selection.model, label: selection.model }],
      supportsImages: false,
      modelDiscovery: 'none',
    };
    const current = this.#providers.get(selection.apiProviderId);
    this.#providers.set(selection.apiProviderId, {
      id: selection.apiProviderId,
      label: current?.label ?? selection.apiProviderId,
      endpoints: [
        ...(current?.endpoints.filter((candidate) => candidate.id !== selection.endpointId) ?? []),
        endpoint,
      ],
      createdAt: current?.createdAt ?? '',
      updatedAt: '',
    });
  }
}
