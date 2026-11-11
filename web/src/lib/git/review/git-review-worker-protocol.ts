import type { GitReviewFilePatchBody } from '$lib/api/git.js';
import type { GitDiffSyntaxFile } from './git-diff-syntax.js';
import type { GitDiffSyntaxTransfer } from './git-diff-syntax-transfer.js';
import type { GitPatchIndexData, GitSplitPatchIndexData } from './git-patch-index.js';
import type { GitReviewWorkerTiming } from './git-review-performance.js';

export const GIT_REVIEW_WORKER_LIMITS = Object.freeze({
	maxPatchCharacters: 5_000_000,
	maxRows: 50_000,
	maxPendingRequests: 8,
	maxPendingBytes: 24_000_000,
	requestTimeoutMs: 5_000,
	idleTimeoutMs: 30_000,
	maxJobsPerWorker: 128,
});

export type GitReviewWorkerInput =
	| { kind: 'index'; patch: string; renderedRowCount: number }
	| {
			kind: 'highlight';
			documentId: string;
			file: GitDiffSyntaxFile;
			body: GitReviewFilePatchBody;
			index: GitPatchIndexData;
	  };

export type GitReviewWorkerOutput =
	| { kind: 'index'; index: GitPatchIndexData; split: GitSplitPatchIndexData }
	| { kind: 'highlight'; attempt: GitDiffSyntaxTransfer };

export interface GitReviewWorkerRequest {
	id: number;
	input: GitReviewWorkerInput;
}
export type GitReviewWorkerReply =
	| { id: number; status: 'ready'; output: GitReviewWorkerOutput; timings: GitReviewWorkerTiming[] }
	| { id: number; status: 'error'; message: string };

export function reviewWorkerInputBytes(input: GitReviewWorkerInput): number {
	const patch = input.kind === 'index' ? input.patch : (input.body.patch ?? '');
	const rows = input.kind === 'index' ? input.renderedRowCount : input.body.renderedRowCount;
	if (
		patch.length > GIT_REVIEW_WORKER_LIMITS.maxPatchCharacters ||
		!Number.isSafeInteger(rows) ||
		rows < 0 ||
		rows > GIT_REVIEW_WORKER_LIMITS.maxRows
	) {
		throw new Error('Diff exceeds the browser Worker indexing limit.');
	}
	return (
		patch.length * 2 +
		(input.kind === 'highlight'
			? Object.values(input.index).reduce((sum, array) => sum + array.byteLength, 0)
			: 0)
	);
}
