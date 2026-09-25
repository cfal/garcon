import type { GhStatusResponse } from '$shared/gh';
import { apiGet, ApiError, type ApiFetchOptions } from './client.js';
import { isRecord } from '$shared/json';
import type { GitExecutorScope } from '$shared/git-execution';

export type { GhStatusResponse };

export async function ghApiGet<T>(
	executorId: string,
	url: string,
	options?: ApiFetchOptions,
): Promise<T & GitExecutorScope> {
	const result = await apiGet<T & GitExecutorScope>(url, options);
	if (
		!isRecord(result) ||
		result.executorId !== executorId ||
		typeof result.instanceId !== 'string' ||
		!result.instanceId
	)
		throw new ApiError(
			502,
			'GitHub returned a different executor or invalid serving instance.',
			'GIT_INVALID_RESULT',
		);
	return result;
}

export async function getGhStatus(
	executorId: string,
	options?: ApiFetchOptions,
): Promise<GhStatusResponse> {
	return ghApiGet<GhStatusResponse>(
		executorId,
		`/api/v1/gh/status?${new URLSearchParams({ executorId })}`,
		options,
	);
}
