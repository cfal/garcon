import type * as Wire from '$shared/git';
import type { ApiFetchOptions } from './client.js';
import {
	gitApiPost,
	gitProjectFields,
	gitDocumentRef,
	gitDocumentKey,
	type GitProjectTarget,
	type GitReviewDocumentRef,
} from './git-client.js';
import type { GitReviewDocumentIndexedFileBodiesResponse } from './git.js';
import { getGitReviewDocumentFileBodies } from './git.js';
import {
	finishGitReviewPerformanceSpan,
	registerGitReviewDocument,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

export type GitComparisonMode = Wire.GitComparisonMode;

export type GitComparisonRevisionEndpoint = Wire.GitComparisonRevisionEndpoint;

export type GitComparisonWorkingTreeEndpoint = Wire.GitComparisonWorkingTreeEndpoint;

export type GitComparisonFromEndpoint = Wire.GitComparisonFromEndpoint;
export type GitComparisonToEndpoint = Wire.GitComparisonToEndpoint;

export type GitResolvedComparisonRevision = Wire.GitResolvedComparisonRevision;

export type GitResolvedComparisonWorkingTree = Wire.GitResolvedComparisonWorkingTree;

export type GitResolvedComparisonTo = Wire.GitResolvedComparisonTo;

export interface GitComparisonSnapshotReady extends Wire.GitComparisonSnapshotReady {
	document: GitReviewDocumentRef;
}

export type GitComparisonSnapshotNotFound = Wire.GitComparisonSnapshotNotFound;

export type GitComparisonSnapshotNoMergeBase = Wire.GitComparisonSnapshotNoMergeBase;

export type GitComparisonSnapshotWorkingTreeChanging =
	Wire.GitComparisonSnapshotWorkingTreeChanging;

export type GitComparisonSnapshotResponse =
	| GitComparisonSnapshotReady
	| GitComparisonSnapshotNotFound
	| GitComparisonSnapshotNoMergeBase
	| GitComparisonSnapshotWorkingTreeChanging;

export type GitComparisonRevisionExpectation = Wire.GitComparisonRevisionExpectation;

export type GitComparisonWorkingTreeExpectation = Wire.GitComparisonWorkingTreeExpectation;

export type GitComparisonFreshnessToExpectation = Wire.GitComparisonFreshnessToExpectation;

export type GitComparisonFreshnessReady = Wire.GitComparisonFreshnessReady;

export type GitComparisonFreshnessNotFound = Wire.GitComparisonFreshnessNotFound;

export type GitComparisonFreshnessResponse = Wire.GitComparisonFreshnessResponse;

export type GitComparisonFileRequest = Wire.GitComparisonFileRequest;

export type GitComparisonBodyTarget =
	{ kind: 'revision'; hash: string } | { kind: 'working-tree'; fingerprint: string };

export type GitComparisonFileBodiesResponse = GitReviewDocumentIndexedFileBodiesResponse;

export async function getGitComparisonSnapshot(
	target: GitProjectTarget,
	from: GitComparisonFromEndpoint,
	to: GitComparisonToEndpoint,
	mode: GitComparisonMode,
	options?: ApiFetchOptions & { context?: number; bodyCandidateCount?: number },
): Promise<GitComparisonSnapshotResponse> {
	const { context = 5, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	const span = startGitReviewPerformanceSpan('snapshot');
	try {
		const response = await gitApiPost<Wire.GitComparisonSnapshotResponse>(
			target,
			'/api/v1/git/comparisons/snapshot',
			{ ...gitProjectFields(target), from, to, mode, context, bodyCandidateCount },
			fetchOptions,
		);
		if (response.status !== 'ready') return response;
		const document = gitDocumentRef(response, response.documentId);
		registerGitReviewDocument(gitDocumentKey(document), span);
		return { ...response, document, documentId: gitDocumentKey(document) };
	} finally {
		finishGitReviewPerformanceSpan(span);
	}
}

export async function getGitComparisonFreshness(
	target: GitProjectTarget,
	from: GitComparisonRevisionExpectation,
	to: GitComparisonFreshnessToExpectation,
	options?: ApiFetchOptions,
): Promise<GitComparisonFreshnessResponse> {
	return gitApiPost<GitComparisonFreshnessResponse>(
		target,
		'/api/v1/git/comparisons/freshness',
		{ ...gitProjectFields(target), from, to },
		options,
	);
}

export async function getGitComparisonFileBodies(
	target: GitProjectTarget,
	document: GitReviewDocumentRef,
	effectiveFromHash: string,
	to: GitComparisonBodyTarget,
	files: GitComparisonFileRequest[],
	options?: ApiFetchOptions & {
		context?: number;
		purpose?: import('./git.js').GitReviewBodyPurpose;
	},
): Promise<GitComparisonFileBodiesResponse> {
	const { context: _context = 5, purpose = 'prefetch', ...fetchOptions } = options ?? {};
	void effectiveFromHash;
	void to;
	return getGitReviewDocumentFileBodies(
		target,
		document,
		files.map((file) => file.path),
		purpose,
		fetchOptions,
	);
}
