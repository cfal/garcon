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
	options?: ApiFetchOptions,
): Promise<GitReviewDocumentIndexedFileBodiesResponse> {
	const bodySpan = startGitReviewPerformanceSpan(
		purpose === 'visible' ? 'body-visible' : 'body-prefetch',
	);
	let bodySpanFinished = false;
	let response: GitReviewDocumentFileBodiesResponse & GitExecutorScope;
	try {
		const rawResponse = await apiFetch('/api/v1/git/review-documents/files', {
			...options,
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
	markGitReviewBodyReady(gitDocumentKey(document), purpose);
	if (response.status !== 'ready') return { ...response, documentId: gitDocumentKey(document) };
	return {
		...response,
		documentId: gitDocumentKey(document),
		files: Object.fromEntries(
			Object.entries(response.files).map(([path, body]) => [
				path,
				createIndexedGitReviewFileBody(body),
			]),
		),
	};
}
