// Typed API client for GitHub pull request operations, backed by the `gh` CLI
// on the server. Pull request diffs reuse the git review file shapes so they
// render with the same diff primitives as the local workbench.

import { apiGet, type ApiFetchOptions } from './client.js';
import type {
	GitReviewFileBody,
	GitReviewFilePatchBody,
	GitReviewFileSummary,
} from './git.js';
import { createIndexedGitReviewFileBody } from '$lib/git/review/git-review-body-index.js';

export type PullRequestState = 'open' | 'closed' | 'merged';
export type PullRequestChecksState = 'passing' | 'failing' | 'pending' | 'none';
export type PullRequestReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;
export type PullRequestMergeable = 'mergeable' | 'conflicting' | 'unknown';
export type PullRequestThreadSide = 'before' | 'after';
export type PullRequestCheckState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';

export interface PullRequestSummary {
	number: number;
	title: string;
	state: PullRequestState;
	isDraft: boolean;
	author: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	updatedAt: string;
	url: string;
	reviewDecision: PullRequestReviewDecision;
	checksState: PullRequestChecksState;
}

export interface PullRequestListResult {
	pulls: PullRequestSummary[];
	repo: { nameWithOwner: string } | null;
}

export interface PullRequestReviewCommentItem {
	id: number;
	author: string;
	body: string;
	createdAt: string;
}

export interface PullRequestThread {
	id: string;
	path: string;
	side: PullRequestThreadSide;
	line: number;
	diffHunk: string;
	isOutdated: boolean;
	comments: PullRequestReviewCommentItem[];
}

export interface PullRequestCheck {
	name: string;
	state: PullRequestCheckState;
	url?: string;
}

export interface PullRequestDetail {
	number: number;
	title: string;
	body: string;
	state: PullRequestState;
	isDraft: boolean;
	author: string;
	headRefName: string;
	baseRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	createdAt: string;
	updatedAt: string;
	url: string;
	mergeable: PullRequestMergeable;
	reviewDecision: PullRequestReviewDecision;
	checks: PullRequestCheck[];
	files: GitReviewFileSummary[];
	fileBodies: Record<string, GitReviewFileBody>;
	threads: PullRequestThread[];
}

interface PullRequestDetailWire extends Omit<PullRequestDetail, 'fileBodies'> {
	fileBodies: Record<string, GitReviewFilePatchBody>;
}

function projectParam(project: string): string {
	return `project=${encodeURIComponent(project)}`;
}

export async function getPullRequests(
	project: string,
	options?: ApiFetchOptions,
): Promise<PullRequestListResult> {
	return apiGet<PullRequestListResult>(
		`/api/v1/gh/pull-requests?${projectParam(project)}`,
		options,
	);
}

export async function getPullRequest(
	project: string,
	number: number,
	options?: ApiFetchOptions,
): Promise<PullRequestDetail> {
	const detail = await apiGet<PullRequestDetailWire>(
		`/api/v1/gh/pull-request?${projectParam(project)}&number=${encodeURIComponent(number)}`,
		options,
	);
	return {
		...detail,
		fileBodies: Object.fromEntries(
			Object.entries(detail.fileBodies).map(([path, body]) => [
				path,
				createIndexedGitReviewFileBody(body),
			]),
		),
	};
}
