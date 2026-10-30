// Decides which part of the selected pull request a change invalidates. Each
// read reloads only when its key changes:
// - status follows anything the inbox scan reports changing, including checks
//   and the review decision, because one status read is cheap;
// - review threads follow activity, which GitHub reflects in `updatedAt` for
//   comments, reviews, and pushes, but not for check runs;
// - the diff follows only the commit pair the latest status reports.
// The inbox summary is the only change signal today; a batched GitHub
// fingerprint lookup can replace these inputs without changing the reads.

import type { PullRequestCommits, PullRequestStatus, PullRequestSummary } from '$shared/gh';

type RefreshSignal = Pick<
	PullRequestSummary,
	'headRefOid' | 'updatedAt' | 'checksState' | 'reviewDecision'
>;

export function pullRequestStatusKey(pull: RefreshSignal): string {
	return JSON.stringify([pull.headRefOid, pull.updatedAt, pull.checksState, pull.reviewDecision]);
}

export function pullRequestReviewThreadsKey(pull: RefreshSignal): string {
	return JSON.stringify([pull.headRefOid, pull.updatedAt]);
}

export function pullRequestDiffCommits(status: PullRequestStatus): PullRequestCommits {
	return { baseRefOid: status.baseRefOid, headRefOid: status.headRefOid };
}
