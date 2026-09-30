// API provider HTTP client. API providers are persisted compatible endpoints.

import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import type {
	ApiProviderInput,
	ApiProviderUpdateResult,
	ApiProviderCreateResult,
	ApiProviderManagement,
	ApiProviderModelDiscoveryRequest,
	ApiProviderModelDiscoveryResponse,
} from '$shared/api-providers';

export async function createApiProvider(input: ApiProviderInput, executorId = 'local'): Promise<ApiProviderCreateResult> {
	return apiPost(`/api/v1/api-providers?executorId=${encodeURIComponent(executorId)}`, input);
}

export function getApiProviderManagement(): Promise<ApiProviderManagement> {
	return apiGet('/api/v1/api-providers');
}

export async function updateApiProvider(
	id: string,
	input: Partial<ApiProviderInput>,
): Promise<ApiProviderUpdateResult> {
	return apiPut<ApiProviderUpdateResult>(
		`/api/v1/api-providers?id=${encodeURIComponent(id)}`,
		input,
	);
}

export async function deleteApiProvider(id: string): Promise<{ success: boolean }> {
	return apiDelete<{ success: boolean }>(`/api/v1/api-providers?id=${encodeURIComponent(id)}&acknowledgeSharedImpact=true`);
}

export async function testApiProvider(
	input: ApiProviderInput,
	executorId = 'local',
): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost(`/api/v1/api-providers/test?executorId=${encodeURIComponent(executorId)}`, input);
}

export async function discoverApiProviderModels(
	input: ApiProviderModelDiscoveryRequest,
	executorId = 'local',
): Promise<ApiProviderModelDiscoveryResponse> {
	return apiPost(`/api/v1/api-providers/models?executorId=${encodeURIComponent(executorId)}`, input);
}
