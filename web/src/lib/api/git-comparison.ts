import { apiPost, type ApiFetchOptions } from './client.js';
import type {
	GitCommitFileSummary,
	GitDiffFileRequest,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewDocumentIndexedFileBodiesResponse,
} from './git.js';
import { getGitReviewDocumentFileBodies } from './git.js';
import {
	finishGitReviewPerformanceSpan,
	registerGitReviewDocument,
	startGitReviewPerformanceSpan,
} from '$lib/git/review/git-review-performance.js';

export type GitComparisonMode = 'direct' | 'merge-base';

export interface GitComparisonRevisionEndpoint {
	kind: 'revision';
	revision: string;
}

export interface GitComparisonWorkingTreeEndpoint {
	kind: 'working-tree';
}

export type GitComparisonFromEndpoint = GitComparisonRevisionEndpoint;
export type GitComparisonToEndpoint =
	GitComparisonRevisionEndpoint | GitComparisonWorkingTreeEndpoint;

export interface GitResolvedComparisonRevision {
	kind: 'revision';
	requestedRevision: string;
	label: string;
	hash: string;
	shortHash: string;
}

export interface GitResolvedComparisonWorkingTree {
	kind: 'working-tree';
	label: string;
	branch: string;
	headHash: string | null;
	fingerprint: string;
	shortFingerprint: string;
}

export type GitResolvedComparisonTo =
	GitResolvedComparisonRevision | GitResolvedComparisonWorkingTree;

export interface GitComparisonSnapshotReady {
	status: 'ready';
	project: string;
	repoRoot: string;
	documentId: string;
	mode: GitComparisonMode;
	from: GitResolvedComparisonRevision;
	to: GitResolvedComparisonTo;
	effectiveFromHash: string;
	mergeBaseHash?: string;
	files: GitCommitFileSummary[];
	limits: GitReviewDocumentLimits;
	collectionLimit?: GitReviewCollectionLimit;
	firstBodyCandidates: string[];
}

export interface GitComparisonSnapshotNotFound {
	status: 'not-found';
	project: string;
	endpoint: 'from' | 'to';
	revision: string;
	message: string;
}

export interface GitComparisonSnapshotNoMergeBase {
	status: 'no-merge-base';
	project: string;
	from: GitResolvedComparisonRevision;
	to: GitResolvedComparisonRevision;
	message: string;
}

export interface GitComparisonSnapshotWorkingTreeChanging {
	status: 'working-tree-changing';
	project: string;
	message: string;
}

export type GitComparisonSnapshotResponse =
	| GitComparisonSnapshotReady
	| GitComparisonSnapshotNotFound
	| GitComparisonSnapshotNoMergeBase
	| GitComparisonSnapshotWorkingTreeChanging;

export interface GitComparisonRevisionExpectation {
	kind: 'revision';
	revision: string;
	hash: string;
}

export interface GitComparisonWorkingTreeExpectation {
	kind: 'working-tree';
	fingerprint: string;
}

export type GitComparisonFreshnessToExpectation =
	GitComparisonRevisionExpectation | GitComparisonWorkingTreeExpectation;

export interface GitComparisonFreshnessReady {
	status: 'ready';
	project: string;
	changedEndpoints: Array<'from' | 'to'>;
	fromHash: string;
	to: { kind: 'revision'; hash: string } | { kind: 'working-tree'; fingerprint: string };
}

export interface GitComparisonFreshnessNotFound {
	status: 'not-found';
	project: string;
	endpoint: 'from' | 'to';
	revision: string;
	message: string;
}

export type GitComparisonFreshnessResponse =
	GitComparisonFreshnessReady | GitComparisonFreshnessNotFound;

export type GitComparisonFileRequest = GitDiffFileRequest;

export type GitComparisonBodyTarget =
	{ kind: 'revision'; hash: string } | { kind: 'working-tree'; fingerprint: string };

export type GitComparisonFileBodiesResponse = GitReviewDocumentIndexedFileBodiesResponse;

export async function getGitComparisonSnapshot(
	project: string,
	from: GitComparisonFromEndpoint,
	to: GitComparisonToEndpoint,
	mode: GitComparisonMode,
	options?: ApiFetchOptions & { context?: number; bodyCandidateCount?: number },
): Promise<GitComparisonSnapshotResponse> {
	const { context = 5, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	const span = startGitReviewPerformanceSpan('snapshot');
	try {
		const response = await apiPost<GitComparisonSnapshotResponse>(
			'/api/v1/git/comparisons/snapshot',
			{ project, from, to, mode, context, bodyCandidateCount },
			fetchOptions,
		);
		if (response.status === 'ready') registerGitReviewDocument(response.documentId, span);
		return response;
	} finally {
		finishGitReviewPerformanceSpan(span);
	}
}

export async function getGitComparisonFreshness(
	project: string,
	from: GitComparisonRevisionExpectation,
	to: GitComparisonFreshnessToExpectation,
	options?: ApiFetchOptions,
): Promise<GitComparisonFreshnessResponse> {
	return apiPost<GitComparisonFreshnessResponse>(
		'/api/v1/git/comparisons/freshness',
		{ project, from, to },
		options,
	);
}

export async function getGitComparisonFileBodies(
	project: string,
	documentId: string,
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
		project,
		documentId,
		files.map((file) => file.path),
		purpose,
		fetchOptions,
	);
}
