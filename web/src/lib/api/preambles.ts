import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	normalizePreamblesMutationResponse,
	normalizePreamblesSnapshot,
	type CreatePreambleRequest,
	type PreamblesMutationResponse,
	type PreamblesSnapshot,
	type RemovePreambleRequest,
	type ReorderPreamblesRequest,
	type UpdatePreambleRequest,
} from '$shared/preambles';

function snapshot(value: unknown): PreamblesSnapshot {
	const parsed = normalizePreamblesSnapshot(value);
	if (!parsed) throw new Error('Invalid preambles response');
	return parsed;
}

function mutation(value: unknown): PreamblesMutationResponse {
	const parsed = normalizePreamblesMutationResponse(value);
	if (!parsed) throw new Error('Invalid preamble mutation response');
	return parsed;
}

export async function getPreambles(): Promise<PreamblesSnapshot> {
	return snapshot(await apiGet<unknown>('/api/v1/preambles'));
}

export async function createPreamble(
	request: CreatePreambleRequest,
): Promise<PreamblesMutationResponse> {
	return mutation(await apiPost('/api/v1/preambles', request));
}

export async function updatePreamble(
	request: UpdatePreambleRequest,
): Promise<PreamblesMutationResponse> {
	return mutation(await apiPut('/api/v1/preambles', request));
}

export async function removePreamble(
	request: RemovePreambleRequest,
): Promise<PreamblesMutationResponse> {
	return mutation(await apiDelete('/api/v1/preambles', request));
}

export async function reorderPreambles(
	request: ReorderPreamblesRequest,
): Promise<PreamblesMutationResponse> {
	return mutation(await apiPut('/api/v1/preambles/reorder', request));
}
