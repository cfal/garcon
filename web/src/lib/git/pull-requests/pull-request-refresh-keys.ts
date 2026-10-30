// Decides which part of the selected pull request a change invalidates. The
// inputs are the fingerprint fields of the inbox summary, which the scanner
// refreshes from batched GitHub fingerprint reads. Each read reloads only when
// its key changes:
// - status follows every successful scan as well as the commit pair, checks, the review decision, mergeability,
//   and `updatedAt`, which moves with title, description, and label edits;
// - review threads follow review activity: the head (which outdates threads),
//   the review and thread counts, and `updatedAt`, because an edited review
//   comment changes no count. The executor revalidates an unchanged thread
//   listing with a conditional request, so an `updatedAt` move without review
//   activity costs a 304 instead of a transfer;
// - the diff follows only the commit pair the latest status reports.

import type { PullRequestCommits, PullRequestStatus, PullRequestSummary } from '$shared/gh';

type RefreshSignal = Pick<
	PullRequestSummary,
	| 'headRefOid'
	| 'baseRefOid'
	| 'updatedAt'
	| 'isDraft'
	| 'checksState'
	| 'checkCounts'
	| 'reviewDecision'
	| 'mergeable'
	| 'reviewCount'
	| 'reviewThreadCount'
>;

export function pullRequestStatusKey(pull: RefreshSignal, scannedAt: string | null = null): string {
	return JSON.stringify([
		scannedAt,
		pull.headRefOid,
		pull.baseRefOid,
		pull.updatedAt,
		pull.isDraft,
		pull.checksState,
		pull.checkCounts,
		pull.reviewDecision,
		pull.mergeable,
	]);
}

export function pullRequestReviewThreadsKey(pull: RefreshSignal): string {
	return JSON.stringify([
		pull.headRefOid,
		pull.updatedAt,
		pull.reviewCount,
		pull.reviewThreadCount,
	]);
}

export function pullRequestDiffCommits(status: PullRequestStatus): PullRequestCommits {
	return { baseRefOid: status.baseRefOid, headRefOid: status.headRefOid };
}
