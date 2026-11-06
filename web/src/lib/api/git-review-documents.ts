import { apiFetch, parseApiResponse, ApiError, type ApiFetchOptions } from './client.js';
import {
	assertGitResponseScope,
	gitProjectFields,
	gitDocumentKey,
	type GitProjectTarget,
	type GitReviewDocumentRef,
} from './git-client.js';
import type { GitExecutorScope } from '$shared/git-execution';
import type {
	GitReviewFilePatchBody,
	GitReviewDocumentFileBodiesResponse,
	GitReviewDocumentFileBodiesStale,
	GitReviewDocumentFileBodiesExpired,
	GitReviewDocumentSummary as WireSummary,
} from '$shared/git';
export type {
	GitReviewBodyPurpose,
	GitReviewBodyState,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewLimitReason,
	GitReviewFileSummary,
	GitReviewFilePatchBody,
	GitReviewDocumentFileBodiesReady,
	GitReviewDocumentFileBodiesResponse,
	GitReviewDocumentFileBodiesStale,
	GitReviewDocumentFileBodiesExpired,
} from '$shared/git';
export { GIT_REVIEW_DOCUMENT_LIMITS as DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS } from '$shared/git';
export type { GitReviewMode as GitFileReviewMode } from '$shared/git';
import type { GitReviewBodyPurpose } from '$shared/git';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
import type { GitPatchIndex } from '$lib/git/review/git-patch-index.js';
import {
	finishGitReviewPerformanceSpan,
	markGitReviewBodyReady,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

export interface GitReviewDocumentSummary extends WireSummary {
	document: GitReviewDocumentRef;
}

export interface GitReviewFileBody extends GitReviewFilePatchBody {
	patchIndex: GitPatchIndex | null;
}

export interface GitReviewDocumentIndexedFileBodiesReady {
	status: 'ready';
	documentId: string;
	files: Record<string, GitReviewFileBody>;
	errors: Record<string, string>;
	deferredFiles: string[];
}

export interface GitReviewBodyFetchOptions extends ApiFetchOptions {
	onIndexedBodies?: (result: GitReviewDocumentIndexedFileBodiesReady, paths: string[]) => void;
}

export type GitReviewDocumentIndexedFileBodiesResponse =
	| GitReviewDocumentIndexedFileBodiesReady
	| GitReviewDocumentFileBodiesStale
	| GitReviewDocumentFileBodiesExpired;

export async function getGitReviewDocumentFileBodies(
	target: GitProjectTarget,
	document: GitReviewDocumentRef,
	files: string[],
	purpose: GitReviewBodyPurpose,
	options?: GitReviewBodyFetchOptions,
): Promise<GitReviewDocumentIndexedFileBodiesResponse> {
	const { onIndexedBodies, ...fetchOptions } = options ?? {};
	const bodySpan = startGitReviewPerformanceSpan(
		purpose === 'visible' ? 'body-visible' : 'body-prefetch',
	);
	let bodySpanFinished = false;
	let response: GitReviewDocumentFileBodiesResponse & GitExecutorScope;
	try {
		const rawResponse = await apiFetch('/api/v1/git/review-documents/files', {
			...fetchOptions,
			method: 'POST',
			body: JSON.stringify({ ...gitProjectFields(target), document, files, purpose }),
		});
		if (!rawResponse.ok) {
			response = await parseApiResponse<GitReviewDocumentFileBodiesResponse & GitExecutorScope>(
				rawResponse,
			);
		} else {
			const json = await rawResponse.text();
			finishGitReviewPerformanceSpan(bodySpan);
			bodySpanFinished = true;
			const decodeSpan = startGitReviewPerformanceSpan('json-decode');
			try {
				response = JSON.parse(json) as GitReviewDocumentFileBodiesResponse & GitExecutorScope;
			} finally {
				finishGitReviewPerformanceSpan(decodeSpan);
			}
		}
	} finally {
		if (!bodySpanFinished) finishGitReviewPerformanceSpan(bodySpan);
	}
	assertGitResponseScope(response, target);
	if (response.instanceId !== document.instanceId || response.documentId !== document.documentId) {
		throw new ApiError(
			409,
			'Git review belongs to a different serving instance or document.',
			'GIT_STALE_DOCUMENT',
		);
	}
	if (response.status !== 'ready') return { ...response, documentId: gitDocumentKey(document) };
	if (!Array.isArray(response.deferredFiles)) {
		throw new ApiError(502, 'Invalid Git review body deferrals.', 'GIT_INVALID_RESULT');
	}
	const returned = [...Object.keys(response.files), ...response.deferredFiles];
	if (
		new Set(returned).size !== returned.length ||
		returned.some((path) => !files.includes(path)) ||
		new Set(files).size !== returned.length ||
		(files.length === 1 && response.deferredFiles.length > 0)
	) {
		throw new ApiError(502, 'Invalid Git review body response.', 'GIT_INVALID_RESULT');
	}
	markGitReviewBodyReady(gitDocumentKey(document), purpose);
	const indexed: Record<string, GitReviewFileBody> = Object.create(null);
	for (const path of new Set(files)) {
		const body = Object.hasOwn(response.files, path) ? response.files[path] : undefined;
		if (!body) continue;
		options?.signal?.throwIfAborted();
		try {
			indexed[path] = await createIndexedGitReviewFileBody(body, options?.signal ?? undefined);
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			indexed[path] = {
				...body,
				patch: null,
				patchIndex: null,
				bodyState: 'error',
				error: error instanceof Error ? error.message : 'Diff indexing failed.',
			};
		}
		options?.signal?.throwIfAborted();
		onIndexedBodies?.(
			{
				status: 'ready',
				documentId: gitDocumentKey(document),
				files: { [path]: indexed[path] },
				errors: {},
				deferredFiles: [],
			},
			[path],
		);
		options?.signal?.throwIfAborted();
	}
	return {
		...response,
		documentId: gitDocumentKey(document),
		files: indexed,
	};
}
