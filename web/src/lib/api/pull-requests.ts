import type { ApiFetchOptions } from './client.js';
import { ghApiGet } from './gh.js';
import { gitDocumentKey, gitProjectQuery, type GitProjectTarget } from './git-client.js';
import type {
	GhRepositoryIdentity,
	PullRequestCommits,
	PullRequestDiff as PullRequestDiffWire,
	PullRequestListResult,
	PullRequestReviewThreads,
	PullRequestStatus,
} from '$shared/gh';
import { ghOperationTimeoutMs } from '$shared/git-execution';
import type { GitReviewFileBody } from './git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
export type {
	PullRequestState,
	PullRequestChecksState,
	PullRequestCommits,
	PullRequestReviewDecision,
	PullRequestMergeable,
	PullRequestThreadSide,
	PullRequestCheckState,
	PullRequestStatus,
	PullRequestSummary,
	PullRequestListResult,
	PullRequestReviewCommentItem,
	PullRequestReviewThreads,
	PullRequestThread,
	PullRequestCheck,
} from '$shared/gh';

export interface PullRequestTarget extends GitProjectTarget {
	readonly repository: GhRepositoryIdentity;
}

export interface PullRequestDiff extends Omit<PullRequestDiffWire, 'fileBodies'> {
	documentId: string;
	fileBodies: Record<string, GitReviewFileBody>;
}

export async function getPullRequests(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<PullRequestListResult> {
	return ghApiGet(target.executorId, `/api/v1/gh/pull-requests?${gitProjectQuery(target)}`, {
		timeoutMs: ghOperationTimeoutMs('listPullRequests'),
		...options,
	});
}

function pullRequestQuery(target: PullRequestTarget, number: number): URLSearchParams {
	const query = new URLSearchParams(gitProjectQuery(target));
	query.set('number', String(number));
	query.set('repositoryHost', target.repository.host);
	query.set('repositoryName', target.repository.nameWithOwner);
	return query;
}

export async function getPullRequestStatus(
	target: PullRequestTarget,
	number: number,
	options?: ApiFetchOptions,
): Promise<PullRequestStatus> {
	return ghApiGet<PullRequestStatus>(
		target.executorId,
		`/api/v1/gh/pull-request/status?${pullRequestQuery(target, number)}`,
		{ timeoutMs: ghOperationTimeoutMs('getPullRequestStatus'), ...options },
	);
}

// Reads the diff of `commits`; the executor rejects it as stale once the pull
// request has moved on.
export async function getPullRequestDiff(
	target: PullRequestTarget,
	number: number,
	commits: PullRequestCommits,
	options?: ApiFetchOptions,
): Promise<PullRequestDiff> {
	const query = pullRequestQuery(target, number);
	query.set('baseRefOid', commits.baseRefOid);
	query.set('headRefOid', commits.headRefOid);
	const diff = await ghApiGet<PullRequestDiffWire>(
		target.executorId,
		`/api/v1/gh/pull-request/diff?${query}`,
		{ timeoutMs: ghOperationTimeoutMs('getPullRequestDiff'), ...options },
	);
	return {
		...diff,
		// The commit pair names the diff, so a status refresh keeps its layout.
		documentId: gitDocumentKey({
			...diff,
			documentId: JSON.stringify([
				target.projectPath,
				target.repository.host,
				target.repository.nameWithOwner,
				diff.number,
				diff.baseRefOid,
				diff.headRefOid,
			]),
		}),
		fileBodies: Object.fromEntries(
			Object.entries(diff.fileBodies).map(([path, body]) => [
				path,
				createIndexedGitReviewFileBody(body),
			]),
		),
	};
}

export async function getPullRequestReviewThreads(
	target: PullRequestTarget,
	number: number,
	options?: ApiFetchOptions,
): Promise<PullRequestReviewThreads> {
	return ghApiGet<PullRequestReviewThreads>(
		target.executorId,
		`/api/v1/gh/pull-request/review-threads?${pullRequestQuery(target, number)}`,
		{ timeoutMs: ghOperationTimeoutMs('getPullRequestReviewThreads'), ...options },
	);
}
