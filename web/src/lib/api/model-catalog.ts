import { apiFetch, parseApiResponse } from './client';

export async function fetchModelCatalogResponse(executorId: string, etag: string | null): Promise<Response> {
	const url = executorId === 'local' ? '/api/v1/models' : `/api/v1/models?executorId=${encodeURIComponent(executorId)}`;
	const response = await (etag
		? apiFetch(url, { headers: { 'If-None-Match': etag } })
		: apiFetch(url));
	if (response.status !== 304 && !response.ok) await parseApiResponse<never>(response);
	return response;
}
