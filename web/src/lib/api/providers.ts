// Harness and API provider HTTP client. Harnesses own runtime auth;
// API providers own persisted compatible endpoint configuration.

import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import type {
	ApiProtocol,
	ApiProviderCatalogEntry,
	ApiProviderModelDiscoveryRequest,
	ApiProviderModelDiscoveryResponse,
	ApiProviderTemplateId,
	HarnessCatalog,
	HarnessId,
	HarnessModelOption,
	ModelDiscoveryKind
} from '$shared/providers';

export type HarnessName = HarnessId;
export type BrowserLoginHarnessName = 'claude' | 'codex';

export interface HarnessAuthStatus {
	authenticated: boolean;
	canReauth: boolean;
	label: string;
	source?: 'oauth' | 'api-key' | 'environment' | 'cli' | 'none' | 'unknown';
	detail?: string;
}

export interface HarnessReadiness {
	ready: boolean;
	nativeReady: boolean;
	endpointReady: boolean;
	reason: string;
}

export interface DeviceAuthInfo {
	url: string;
	code: string;
}

export interface HarnessAuthLoginResult {
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
	exposeTo: string[];
	defaultModel: string;
	models: Array<Pick<HarnessModelOption, 'value' | 'label' | 'supportsImages' | 'isLocal'>>;
	supportsImages: boolean;
	modelDiscovery?: ModelDiscoveryKind;
}

export interface ApiProviderInput {
	templateId: ApiProviderTemplateId;
	label: string;
	endpoint: ApiProviderEndpointInput;
}

export async function getHarnessAuthStatus(harness: HarnessName): Promise<HarnessAuthStatus> {
	const result = await apiGet<Record<string, HarnessAuthStatus>>(
		`/api/v1/harnesses/auth?harness=${encodeURIComponent(harness)}`
	);
	return result[harness];
}

export async function getHarnessReadiness(): Promise<Record<string, HarnessReadiness>> {
	return apiGet<Record<string, HarnessReadiness>>('/api/v1/harnesses/readiness');
}

export async function getHarnessCatalog(): Promise<HarnessCatalog> {
	return apiGet<HarnessCatalog>('/api/v1/harnesses');
}

export async function launchHarnessAuthLogin(harness: BrowserLoginHarnessName): Promise<HarnessAuthLoginResult> {
	return apiPost<HarnessAuthLoginResult>(`/api/v1/harnesses/${harness}/auth/login`);
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
