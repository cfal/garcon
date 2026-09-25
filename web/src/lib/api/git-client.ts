import type { GitExecutorScope, GitProjectTarget, GitReviewDocumentRef } from '$shared/git-execution';
import { isRecord } from '$shared/json';
import { apiGet, apiPost, ApiError, type ApiFetchOptions } from './client.js';

export type {
	GitProjectTarget,
	GitReviewDocumentRef,
	GitSelectionProof,
} from '$shared/git-execution';

export function gitProjectFields(target: GitProjectTarget): { executorId: string; project: string } {
	return { executorId: target.executorId, project: target.projectPath };
}

export function gitProjectQuery(target: GitProjectTarget): string {
	return new URLSearchParams(gitProjectFields(target)).toString();
}

export function gitDocumentRef(scope: GitExecutorScope, documentId: string): GitReviewDocumentRef {
	return { executorId: scope.executorId, instanceId: scope.instanceId, documentId };
}

export function gitDocumentKey(document: GitReviewDocumentRef): string {
	return JSON.stringify([document.executorId, document.instanceId, document.documentId]);
}

export function assertGitResponseScope(
	value: unknown,
	target: GitProjectTarget,
): asserts value is GitExecutorScope {
	if (
		!isRecord(value) ||
		value.executorId !== target.executorId ||
		typeof value.instanceId !== 'string' ||
		!value.instanceId
	) {
		throw new ApiError(
			502,
			'Git returned a different executor or an invalid serving instance.',
			'GIT_INVALID_RESULT',
		);
	}
}

export async function gitApiGet<T>(
	target: GitProjectTarget,
	url: string,
	options?: ApiFetchOptions,
): Promise<T & GitExecutorScope> {
	const result = await apiGet<T>(url, options);
	assertGitResponseScope(result, target);
	return result;
}

export async function gitApiPost<T>(
	target: GitProjectTarget,
	url: string,
	body: unknown,
	options?: ApiFetchOptions,
): Promise<T & GitExecutorScope> {
	const result = await apiPost<T>(url, body, options);
	assertGitResponseScope(result, target);
	return result;
}

export async function gitApiMutation<T>(
	target: GitProjectTarget,
	url: string,
	body: unknown,
	options?: ApiFetchOptions,
): Promise<T & GitExecutorScope> {
	try {
		const result = await gitApiPost<T>(target, url, body, options);
		if (!isRecord(result) || typeof result.success !== 'boolean') {
			throw new ApiError(502, 'Git returned an invalid mutation result.', 'GIT_INVALID_RESULT');
		}
		return result;
	} catch (error) {
		if (
			error instanceof ApiError &&
			error.errorCode !== 'GIT_INVALID_RESULT' &&
			(error.errorCode || error.status < 500)
		)
			throw error;
		throw new ApiError(
			503,
			'Git mutation could not be confirmed. Inspect the repository before trying again.',
			'GIT_MUTATION_OUTCOME_UNKNOWN',
		);
	}
}
