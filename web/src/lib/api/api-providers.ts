// API provider HTTP client. API providers are persisted compatible endpoints.

import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import type { AgentModelOption } from '$shared/agents';
import type {
	ApiProtocol,
	ApiProviderCatalogEntry,
	ApiProviderCreateResult,
	ApiProviderManagement,
	ApiProviderModelDiscoveryRequest,
	ApiProviderModelDiscoveryResponse,
	ApiProviderTemplateId,
	ModelDiscoveryKind,
	OpenAiEndpointCapabilities,
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
	revision?: number;
	apiProviderId?: string;
	endpointId?: string;
	templateId: ApiProviderTemplateId;
	label: string;
	endpoint: ApiProviderEndpointInput;
}

export async function createApiProvider(input: ApiProviderInput, nodeId = 'local'): Promise<ApiProviderCreateResult> {
	return apiPost(`/api/v1/api-providers?nodeId=${encodeURIComponent(nodeId)}`, input);
}

export function getApiProviderManagement(): Promise<ApiProviderManagement> {
	return apiGet('/api/v1/api-providers');
}

export function assignApiProvider(nodeId: string, apiProviderId: string): Promise<ApiProviderManagement> {
	return apiPut(`/api/v1/api-provider-assignments?nodeId=${encodeURIComponent(nodeId)}&apiProviderId=${encodeURIComponent(apiProviderId)}`, {});
}

export function unassignApiProvider(nodeId: string, apiProviderId: string): Promise<ApiProviderManagement> {
	return apiDelete(`/api/v1/api-provider-assignments?nodeId=${encodeURIComponent(nodeId)}&apiProviderId=${encodeURIComponent(apiProviderId)}`);
}

export async function updateApiProvider(
	id: string,
	input: Partial<ApiProviderInput>,
): Promise<ApiProviderCatalogEntry> {
	return apiPut<ApiProviderCatalogEntry>(
		`/api/v1/api-providers?id=${encodeURIComponent(id)}`,
		input,
	);
}

export async function deleteApiProvider(id: string): Promise<{ success: boolean }> {
	return apiDelete<{ success: boolean }>(`/api/v1/api-providers?id=${encodeURIComponent(id)}&acknowledgeSharedImpact=true`);
}

export async function testApiProvider(
	input: ApiProviderInput,
	nodeId = 'local',
): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost(`/api/v1/api-providers/test?nodeId=${encodeURIComponent(nodeId)}`, input);
}

export async function discoverApiProviderModels(
	input: ApiProviderModelDiscoveryRequest,
	nodeId = 'local',
): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost(`/api/v1/api-providers/models?nodeId=${encodeURIComponent(nodeId)}`, input);
}
