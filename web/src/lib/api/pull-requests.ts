import type { ApiFetchOptions } from './client.js';
import { ghApiGet } from './gh.js';
import { gitDocumentKey, gitProjectQuery, type GitProjectTarget } from './git-client.js';
import type { PullRequestDetail as PullRequestDetailWire, PullRequestListResult } from '$shared/gh';
import type { GitReviewFileBody } from './git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';
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

export interface PullRequestDetail extends Omit<PullRequestDetailWire, 'fileBodies'> {
	documentId: string;
	fileBodies: Record<string, GitReviewFileBody>;
}

export async function getPullRequests(
	target: GitProjectTarget,
	options?: ApiFetchOptions,
): Promise<PullRequestListResult> {
	return ghApiGet(target.nodeId, `/api/v1/gh/pull-requests?${gitProjectQuery(target)}`, options);
}

export async function getPullRequest(
	target: GitProjectTarget,
	number: number,
	options?: ApiFetchOptions,
): Promise<PullRequestDetail> {
	const detail = await ghApiGet<PullRequestDetailWire>(
		target.nodeId,
		`/api/v1/gh/pull-request?${gitProjectQuery(target)}&number=${encodeURIComponent(number)}`,
		{ timeoutMs: 60_000, ...options },
	);
	return {
		...detail,
		documentId: gitDocumentKey({
			...detail,
			documentId: JSON.stringify([target.projectPath, detail.number, detail.updatedAt]),
		}),
		fileBodies: Object.fromEntries(
			Object.entries(detail.fileBodies).map(([path, body]) => [
				path,
				createIndexedGitReviewFileBody(body),
			]),
		),
	};
}
