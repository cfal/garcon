import type { GhStatusResponse } from '$shared/gh';
import { apiGet, ApiError, type ApiFetchOptions } from './client.js';
import { isRecord } from '$shared/json';
import type { GitNodeScope } from '$shared/git-execution';

export type { GhStatusResponse };

export async function ghApiGet<T>(
	nodeId: string,
	url: string,
	options?: ApiFetchOptions,
): Promise<T & GitNodeScope> {
	const result = await apiGet<T & GitNodeScope>(url, options);
	if (
		!isRecord(result) ||
		result.nodeId !== nodeId ||
		typeof result.instanceId !== 'string' ||
		!result.instanceId
	)
		throw new ApiError(
			502,
			'GitHub returned a different execution node or invalid serving instance.',
			'GIT_INVALID_RESULT',
		);
	return result;
}

export async function getGhStatus(
	nodeId: string,
	options?: ApiFetchOptions,
): Promise<GhStatusResponse> {
	return ghApiGet<GhStatusResponse>(
		nodeId,
		`/api/v1/gh/status?${new URLSearchParams({ nodeId })}`,
		options,
	);
}
