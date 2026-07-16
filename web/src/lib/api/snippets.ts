import { apiDelete, apiGet, apiPost, apiPut, type ApiFetchOptions } from './client.js';
import {
	normalizeExpandSnippetResponse,
	normalizeSnippetsMutationResponse,
	normalizeSnippetsSnapshot,
	type CreateSnippetRequest,
	type ExpandSnippetRequest,
	type ExpandSnippetResponse,
	type ReorderSnippetsRequest,
	type RemoveSnippetRequest,
	type SnippetsMutationResponse,
	type SnippetsSnapshot,
	type UpdateSnippetRequest,
} from '$shared/snippets';

function snapshot(value: unknown): SnippetsSnapshot {
	const normalized = normalizeSnippetsSnapshot(value);
	if (!normalized) throw new Error('Invalid snippets response');
	return normalized;
}

function mutation(value: unknown): SnippetsMutationResponse {
	const normalized = normalizeSnippetsMutationResponse(value);
	if (!normalized) throw new Error('Invalid snippet mutation response');
	return normalized;
}

export async function getSnippets(): Promise<SnippetsSnapshot> {
	return snapshot(await apiGet<unknown>('/api/v1/snippets'));
}

export async function createSnippet(
	request: CreateSnippetRequest,
): Promise<SnippetsMutationResponse> {
	return mutation(await apiPost<unknown>('/api/v1/snippets', request));
}

export async function updateSnippet(
	request: UpdateSnippetRequest,
): Promise<SnippetsMutationResponse> {
	return mutation(await apiPut<unknown>('/api/v1/snippets', request));
}

export async function removeSnippet(
	request: RemoveSnippetRequest,
): Promise<SnippetsMutationResponse> {
	return mutation(await apiDelete<unknown>('/api/v1/snippets', request));
}

export async function reorderSnippets(
	request: ReorderSnippetsRequest,
): Promise<SnippetsMutationResponse> {
	return mutation(await apiPut<unknown>('/api/v1/snippets/reorder', request));
}

export async function expandSnippet(
	request: ExpandSnippetRequest,
	options?: ApiFetchOptions,
): Promise<ExpandSnippetResponse> {
	const response = normalizeExpandSnippetResponse(
		await apiPost<unknown>('/api/v1/snippets/expand', request, options),
	);
	if (!response) throw new Error('Invalid snippet expansion response');
	return response;
}
