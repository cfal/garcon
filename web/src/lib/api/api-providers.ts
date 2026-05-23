// API provider HTTP client. API providers are persisted compatible endpoints.

import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import type { AgentModelOption } from '$shared/agents';
import type {
	ApiProtocol,
	ApiProviderCatalogEntry,
	ApiProviderModelDiscoveryRequest,
	ApiProviderModelDiscoveryResponse,
	ApiProviderTemplateId,
	ModelDiscoveryKind,
	OpenAiEndpointCapabilities
} from '$shared/api-providers';

export interface ApiProviderEndpointInput {
	id?: string;
	protocol: ApiProtocol;
	baseUrl: string;
	apiKey?: string;
	clearApiKey?: boolean;
	capabilities?: OpenAiEndpointCapabilities;
	defaultModel: string;
	models: Array<Pick<AgentModelOption, 'value' | 'label' | 'supportsImages' | 'isLocal'>>;
	supportsImages: boolean;
	modelDiscovery?: ModelDiscoveryKind;
}

export interface ApiProviderInput {
	templateId: ApiProviderTemplateId;
	label: string;
	endpoint: ApiProviderEndpointInput;
}

export async function getApiProviders(): Promise<{ apiProviders: ApiProviderCatalogEntry[] }> {
	return apiGet<{ apiProviders: ApiProviderCatalogEntry[] }>('/api/v1/api-providers');
}

export async function createApiProvider(input: ApiProviderInput): Promise<ApiProviderCatalogEntry> {
	return apiPost<ApiProviderCatalogEntry>('/api/v1/api-providers', input);
}

export async function updateApiProvider(id: string, input: Partial<ApiProviderInput>): Promise<ApiProviderCatalogEntry> {
	return apiPut<ApiProviderCatalogEntry>(`/api/v1/api-providers?id=${encodeURIComponent(id)}`, input);
}

export async function deleteApiProvider(id: string): Promise<{ success: boolean }> {
	return apiDelete<{ success: boolean }>(`/api/v1/api-providers?id=${encodeURIComponent(id)}`);
}

export async function testApiProvider(input: ApiProviderInput): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost('/api/v1/api-providers/test', input);
}

export async function discoverApiProviderModels(
	input: ApiProviderModelDiscoveryRequest
): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost('/api/v1/api-providers/models', input);
}
