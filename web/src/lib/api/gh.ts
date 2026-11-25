import type { GhStatusResponse } from '$shared/gh';
import { apiGet, type ApiFetchOptions } from './client.js';
import type { GitExecutorScope } from '$shared/git-execution';
import { assertGitResponseScope } from './git-client.js';

export type { GhStatusResponse };

export async function ghApiGet<T>(
	executorId: string,
	url: string,
	options?: ApiFetchOptions,
): Promise<T & GitExecutorScope> {
	const result = await apiGet<T>(url, options);
	assertGitResponseScope(result, executorId, 'GitHub');
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
