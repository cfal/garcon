import { apiPost, type ApiFetchOptions } from './client.js';
import type {
	GitCommitFileSummary,
	GitReviewCollectionLimit,
	GitReviewDocumentLimits,
	GitReviewFileBodiesResponse,
} from './git.js';

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

export interface GitComparisonFileRequest {
	path: string;
	originalPath?: string;
}

export type GitComparisonBodyTarget =
	{ kind: 'revision'; hash: string } | { kind: 'working-tree'; fingerprint: string };

export interface GitComparisonFileBodiesReady extends GitReviewFileBodiesResponse {
	status: 'ready';
}

export interface GitComparisonFileBodiesStale {
	status: 'stale';
	documentId: string;
	expectedFingerprint: string;
	actualFingerprint: string | null;
	message: string;
}

export type GitComparisonFileBodiesResponse =
	GitComparisonFileBodiesReady | GitComparisonFileBodiesStale;

export async function getGitComparisonSnapshot(
	project: string,
	from: GitComparisonFromEndpoint,
	to: GitComparisonToEndpoint,
	mode: GitComparisonMode,
	options?: ApiFetchOptions & { context?: number; bodyCandidateCount?: number },
): Promise<GitComparisonSnapshotResponse> {
	const { context = 5, bodyCandidateCount = 8, ...fetchOptions } = options ?? {};
	return apiPost<GitComparisonSnapshotResponse>(
		'/api/v1/git/comparisons/snapshot',
		{ project, from, to, mode, context, bodyCandidateCount },
		fetchOptions,
	);
}

export async function getGitComparisonFileBodies(
	project: string,
	documentId: string,
	effectiveFromHash: string,
	to: GitComparisonBodyTarget,
	files: GitComparisonFileRequest[],
	options?: ApiFetchOptions & { context?: number },
): Promise<GitComparisonFileBodiesResponse> {
	const { context = 5, ...fetchOptions } = options ?? {};
	return apiPost<GitComparisonFileBodiesResponse>(
		'/api/v1/git/comparisons/files',
		{ project, documentId, effectiveFromHash, to, files, context },
		fetchOptions,
	);
}
