import { apiFetch, ApiError, parseApiResponse } from './client';
import { LOGIN_INSTANCE_QUERY } from '$shared/agent-auth';
import { LOGIN_AGENT_QUERY } from '$shared/model-catalog';

export async function fetchModelCatalogResponse(executorId: string, etag: string | null, loginInstance?: string, loginAgents: readonly string[] = []): Promise<Response> {
	const query = new URLSearchParams();
	if (executorId !== 'local') query.set('executorId', executorId);
	if (loginInstance !== undefined) query.set(LOGIN_INSTANCE_QUERY, loginInstance);
	for (const agent of loginAgents) query.append(LOGIN_AGENT_QUERY, agent);
	const url = query.size ? `/api/v1/models?${query}` : '/api/v1/models';
	const response = await apiFetch(url, {
		cache: 'no-store',
		headers: etag ? { 'If-None-Match': etag } : undefined,
	});
	if (response.status !== 304 && !response.ok) {
		try {
			await parseApiResponse<never>(response);
		} catch (error) {
			if (error instanceof ApiError && !error.message) error.message = `Failed to fetch model catalog: ${response.status}`;
			throw error;
		}
	}
	return response;
}
