import {
	apiFetch,
	parseApiResponse,
	type ApiFetchOptions,
} from './client.js';
import type { GitFileReviewCategory, GitStatusCode } from './git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
import type { GitPatchIndex } from '$lib/git/review/git-patch-index.js';
import {
	finishGitReviewPerformanceSpan,
	markGitReviewBodyReady,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

export type GitFileReviewMode = 'working' | 'staged';
export type GitReviewBodyState =
	'unloaded' | 'loading' | 'loaded' | 'binary' | 'too-large' | 'error';
export type GitReviewLimitReason =
	| 'collection-too-many-files'
	| 'collection-too-many-rows'
	| 'collection-too-many-bytes'
	| 'file-too-many-rows'
	| 'file-too-many-bytes'
	| 'line-too-long'
	| 'binary'
	| 'unsupported-file-kind'
	| 'git-timeout';

export interface GitReviewDocumentLimits {
	maxSummaryFiles: number;
	maxBodyBatchFiles: number;
	maxLoadedRows: number;
	maxLoadedPatchBytes: number;
	maxFileRows: number;
	maxFilePatchBytes: number;
	maxLineBytes: number;
	maxContextLines: number;
	bodyConcurrency: number;
}

export const DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS: GitReviewDocumentLimits = Object.freeze({
	maxSummaryFiles: 10_000,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 100_000,
	maxLoadedPatchBytes: 10_000_000,
	maxFileRows: 50_000,
	maxFilePatchBytes: 5_000_000,
	maxLineBytes: 20_000,
	maxContextLines: 50,
	bodyConcurrency: 4,
});

export interface GitReviewCollectionLimit {
	reason: GitReviewLimitReason;
	message: string;
	visibleFiles: number;
	totalFilesKnown: number;
}

export interface GitReviewFileSummary {
	path: string;
	originalPath?: string;
	indexStatus: GitStatusCode;
	workTreeStatus: GitStatusCode;
	category: GitFileReviewCategory;
	additions: number;
	deletions: number;
	statsKnown?: boolean;
	estimatedRows: number;
	bodyState: GitReviewBodyState;
	bodyFingerprint: string;
	isGenerated: boolean;
	isBinary: boolean;
	isTooLarge: boolean;
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
}

export interface GitReviewDocumentSummary {
	documentId: string;
	project: string;
	mode: GitFileReviewMode;
	context: number;
	files: GitReviewFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
}

export interface GitReviewFileBody {
	path: string;
	bodyFingerprint: string;
	bodyState: GitReviewBodyState;
	category: GitFileReviewCategory;
	isBinary: boolean;
	isTooLarge: boolean;
	renderedRowCount: number;
	patchBytes: number;
	patch: string | null;
	patchIndex: GitPatchIndex | null;
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
	error?: string;
}

export interface GitReviewFilePatchBody {
	path: string;
	bodyFingerprint: string;
	bodyState: GitReviewBodyState;
	category: GitFileReviewCategory;
	isBinary: boolean;
	isTooLarge: boolean;
	renderedRowCount: number;
	patchBytes: number;
	patch: string | null;
	limitReason?: GitReviewLimitReason;
	limitMessage?: string;
	error?: string;
}

export type GitReviewBodyPurpose = 'visible' | 'prefetch';

export interface GitReviewDocumentFileBodiesReady {
	status: 'ready';
	documentId: string;
	files: Record<string, GitReviewFilePatchBody>;
	errors: Record<string, string>;
}

export interface GitReviewDocumentFileBodiesStale {
	status: 'stale';
	documentId: string;
	changedPaths: string[];
	message: string;
}

export interface GitReviewDocumentFileBodiesExpired {
	status: 'document-expired';
	documentId: string;
	message: string;
}

export type GitReviewDocumentFileBodiesResponse =
	| GitReviewDocumentFileBodiesReady
	| GitReviewDocumentFileBodiesStale
	| GitReviewDocumentFileBodiesExpired;

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
	project: string,
	documentId: string,
	files: string[],
	purpose: GitReviewBodyPurpose,
	options?: ApiFetchOptions,
): Promise<GitReviewDocumentIndexedFileBodiesResponse> {
	const bodySpan = startGitReviewPerformanceSpan(
		purpose === 'visible' ? 'body-visible' : 'body-prefetch',
	);
	let bodySpanFinished = false;
	let response: GitReviewDocumentFileBodiesResponse;
	try {
		const rawResponse = await apiFetch('/api/v1/git/review-documents/files', {
			...options,
			method: 'POST',
			body: JSON.stringify({ project, documentId, files, purpose }),
		});
		if (!rawResponse.ok) {
			response = await parseApiResponse<GitReviewDocumentFileBodiesResponse>(rawResponse);
		} else {
			const json = await rawResponse.text();
			finishGitReviewPerformanceSpan(bodySpan);
			bodySpanFinished = true;
			const decodeSpan = startGitReviewPerformanceSpan('json-decode');
			try {
				response = JSON.parse(json) as GitReviewDocumentFileBodiesResponse;
			} finally {
				finishGitReviewPerformanceSpan(decodeSpan);
			}
		}
	} finally {
		if (!bodySpanFinished) finishGitReviewPerformanceSpan(bodySpan);
	}
	markGitReviewBodyReady(documentId, purpose);
	if (response.status !== 'ready') return response;
	return {
		...response,
		files: Object.fromEntries(
			Object.entries(response.files).map(([path, body]) => [
				path,
				createIndexedGitReviewFileBody(body),
			]),
		),
	};
}
