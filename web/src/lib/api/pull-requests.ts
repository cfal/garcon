import type { ApiFetchOptions } from './client.js';
import { ghApiGet } from './gh.js';
import { gitDocumentKey, gitProjectQuery, type GitProjectTarget } from './git-client.js';
import type {
	GhRepositoryIdentity,
	PullRequestDetail as PullRequestDetailWire,
	PullRequestListResult,
} from '$shared/gh';
import { ghOperationTimeoutMs } from '$shared/git-execution';
export type {
	PullRequestState,
	PullRequestChecksState,
	PullRequestReviewDecision,
	PullRequestMergeable,
	PullRequestThreadSide,
	PullRequestCheckState,
	PullRequestSummary,
	PullRequestListResult,
	PullRequestReviewCommentItem,
	PullRequestThread,
	PullRequestCheck,
} from '$shared/gh';

export interface PullRequestDetail extends PullRequestDetailWire {
	reviewId: string;
	documentId: string;
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

export async function getPullRequest(
	target: GitProjectTarget & { repository: GhRepositoryIdentity },
	number: number,
	options?: ApiFetchOptions,
): Promise<PullRequestDetail> {
	const query = new URLSearchParams(gitProjectQuery(target));
	query.set('number', String(number));
	query.set('repositoryHost', target.repository.host);
	query.set('repositoryName', target.repository.nameWithOwner);
	const detail = await ghApiGet<PullRequestDetailWire>(
		target.executorId,
		`/api/v1/gh/pull-request?${query}`,
		{ timeoutMs: ghOperationTimeoutMs('getPullRequest'), ...options },
	);
	return {
		...detail,
		reviewId: JSON.stringify([
			target.executorId,
			target.projectPath,
			target.repository.host,
			target.repository.nameWithOwner,
			detail.number,
		]),
		documentId: gitDocumentKey({
			...detail,
			documentId: JSON.stringify([
				target.projectPath,
				target.repository.host,
				target.repository.nameWithOwner,
				detail.number,
				detail.updatedAt,
			]),
		}),
	};
}
