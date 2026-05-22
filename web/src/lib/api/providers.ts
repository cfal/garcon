// Agent and API provider HTTP client. Agents own runtime auth;
// API providers own persisted compatible endpoint configuration.

import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import type {
	ApiProtocol,
	ApiProviderCatalogEntry,
	ApiProviderModelDiscoveryRequest,
	ApiProviderModelDiscoveryResponse,
	ApiProviderTemplateId,
	AgentCatalog,
	AgentId,
	AgentModelOption,
	ModelDiscoveryKind,
	OpenAiEndpointCapabilities
} from '$shared/providers';

export type AgentName = AgentId;

export interface AgentAuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	source?: 'oauth' | 'api-key' | 'environment' | 'cli' | 'none' | 'unknown';
	detail?: string;
}

export interface AgentReadiness {
	ready: boolean;
	nativeReady: boolean;
	endpointReady: boolean;
	reason: string;
}

export interface DeviceAuthInfo {
	url: string;
	code: string;
}

export interface AgentAuthLoginResult {
	launched: boolean;
	alreadyRunning: boolean;
	deviceAuth?: DeviceAuthInfo;
}

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

export async function getAgentAuthStatus(agent: AgentName): Promise<AgentAuthStatus> {
	const result = await apiGet<Record<string, AgentAuthStatus>>(
		`/api/v1/agents/auth?agent=${encodeURIComponent(agent)}`
	);
	return result[agent];
}

export async function getAgentReadiness(): Promise<Record<string, AgentReadiness>> {
	return apiGet<Record<string, AgentReadiness>>('/api/v1/agents/readiness');
}

export async function getAgentCatalog(): Promise<AgentCatalog> {
	return apiGet<AgentCatalog>('/api/v1/agents');
}

export async function launchAgentAuthLogin(agent: AgentName): Promise<AgentAuthLoginResult> {
	return apiPost<AgentAuthLoginResult>('/api/v1/agents/auth/login', { agentId: agent });
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
