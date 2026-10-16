// Pure presentation helpers for the pull request viewer. Maps PR domain state
// to semantic-token classes so components stay free of hard-coded palettes.

import type {
	PullRequestCheck,
	PullRequestChecksState,
	PullRequestReviewDecision,
	PullRequestState,
} from '$lib/api/pull-requests';
import {
	isActivePullRequestReviewRun,
	type PullRequestReviewInboxEntry,
	type PullRequestReviewRun,
	type PullRequestReviewSkipReason,
} from '$shared/pull-request-reviews';
import * as m from '$lib/paraglide/messages.js';

export function overallChecksState(checks: PullRequestCheck[]): PullRequestChecksState {
	if (checks.length === 0) return 'none';
	if (checks.some((check) => check.state === 'failure')) return 'failing';
	if (checks.some((check) => check.state === 'pending')) return 'pending';
	return 'passing';
}

export interface PrBadge {
	label: string;
	class: string;
}

export function prStateBadge(state: PullRequestState, isDraft: boolean): PrBadge {
	if (isDraft) return { label: 'Draft', class: 'bg-muted text-muted-foreground' };
	if (state === 'merged') return { label: 'Merged', class: 'bg-pr-merged/15 text-pr-merged' };
	if (state === 'closed') return { label: 'Closed', class: 'bg-git-deleted/15 text-git-deleted' };
	return { label: 'Open', class: 'bg-git-added/15 text-git-added' };
}

export function prStateDotClass(state: PullRequestState, isDraft: boolean): string {
	if (isDraft) return 'bg-muted-foreground';
	if (state === 'merged') return 'bg-pr-merged';
	if (state === 'closed') return 'bg-git-deleted';
	return 'bg-git-added';
}

export function reviewDecisionBadge(decision: PullRequestReviewDecision): PrBadge | null {
	switch (decision) {
		case 'approved':
			return { label: 'Approved', class: 'bg-git-added/15 text-git-added' };
		case 'changes_requested':
			return { label: 'Changes requested', class: 'bg-git-deleted/15 text-git-deleted' };
		case 'review_required':
			return { label: 'Review required', class: 'bg-muted text-muted-foreground' };
		default:
			return null;
	}
}

export function checksStateLabel(state: PullRequestChecksState): string {
	switch (state) {
		case 'passing':
			return 'Checks passing';
		case 'failing':
			return 'Checks failing';
		case 'pending':
			return 'Checks running';
		default:
			return '';
	}
}

export function checksStateClass(state: PullRequestChecksState): string {
	switch (state) {
		case 'passing':
			return 'text-git-added';
		case 'failing':
			return 'text-git-deleted';
		case 'pending':
			return 'text-diff-modified-foreground';
		default:
			return 'text-muted-foreground';
	}
}

export function fileStatusLabel(status: string): string {
	switch (status) {
		case 'A':
			return 'Added';
		case 'D':
			return 'Deleted';
		case 'R':
			return 'Renamed';
		default:
			return 'Modified';
	}
}

export function fileStatusClass(status: string): string {
	switch (status) {
		case 'A':
			return 'text-git-added';
		case 'D':
			return 'text-git-deleted';
		case 'R':
			return 'text-git-renamed';
		default:
			return 'text-git-modified';
	}
}

export type ReviewChipTone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'processing';

export interface ReviewChip {
	label: string;
	tone: ReviewChipTone;
}

const REVIEW_CHIP_TONE_CLASS: Record<ReviewChipTone, string> = {
	success: 'border-status-success-border bg-status-success text-status-success-foreground',
	warning: 'border-status-warning-border bg-status-warning text-status-warning-foreground',
	error: 'border-status-error-border bg-status-error text-status-error-foreground',
	info: 'border-status-info-border bg-status-info text-status-info-foreground',
	neutral: 'border-status-neutral-border bg-status-neutral text-status-neutral-foreground',
	processing: 'border-status-processing-border bg-status-processing/10 text-status-processing',
};

export function reviewChipClass(tone: ReviewChipTone): string {
	return REVIEW_CHIP_TONE_CLASS[tone];
}

export function skipReasonLabel(reason: PullRequestReviewSkipReason): string {
	const labels: Record<PullRequestReviewSkipReason, () => string> = {
		draft: m.pull_request_review_skip_draft,
		'untrusted-author': m.pull_request_review_skip_untrusted_author,
		fork: m.pull_request_review_skip_fork,
		'base-branch': m.pull_request_review_skip_base_branch,
		label: m.pull_request_review_skip_label,
		'too-large': m.pull_request_review_skip_too_large,
		'review-not-requested': m.pull_request_review_skip_not_requested,
		'attempts-exhausted': m.pull_request_review_skip_attempts,
		'daily-limit': m.pull_request_review_skip_daily_limit,
		stopped: m.pull_request_review_skip_stopped,
	};
	return labels[reason]();
}

export function reviewRunChip(run: PullRequestReviewRun): ReviewChip | null {
	switch (run.state) {
		case 'queued':
			return { label: m.pull_request_review_state_queued(), tone: 'neutral' };
		case 'reviewing':
			return { label: m.pull_request_review_state_reviewing(), tone: 'processing' };
		case 'needs-input':
			return { label: m.pull_request_review_state_needs_input(), tone: 'warning' };
		case 'completed':
			return run.post.status === 'posted'
				? { label: m.pull_request_review_state_posted(), tone: 'success' }
				: { label: m.pull_request_review_state_reviewed(), tone: 'success' };
		case 'outdated':
			return { label: m.pull_request_review_state_outdated(), tone: 'warning' };
		case 'failed':
			return { label: m.pull_request_review_state_failed(), tone: 'error' };
		case 'stopped':
			return { label: m.pull_request_review_state_stopped(), tone: 'neutral' };
		case 'interrupted':
			return null;
	}
}

// The one chip an inbox row shows: the review of the current head, else why it was skipped.
export function inboxReviewChip(entry: PullRequestReviewInboxEntry): ReviewChip | null {
	const run = entry.latestRun;
	const head = entry.pull.headRefOid;
	if (
		run &&
		(isActivePullRequestReviewRun(run.state) || run.headSha === head || run.reviewedSha === head)
	) {
		const chip = reviewRunChip(run);
		if (chip) return chip;
	}
	if (entry.autoReview.kind === 'skipped') {
		return {
			label: m.pull_request_review_skipped({ reason: skipReasonLabel(entry.autoReview.reason) }),
			tone: 'neutral',
		};
	}
	if (run && run.state !== 'interrupted')
		return { label: m.pull_request_review_state_outdated(), tone: 'warning' };
	return null;
}

const CHECK_ORDER: Record<PullRequestCheck['state'], number> = {
	failure: 0,
	pending: 1,
	success: 2,
	neutral: 3,
	skipped: 4,
};

// Failing checks first, then running ones, so what needs attention is on top.
export function sortChecksForReview(checks: readonly PullRequestCheck[]): PullRequestCheck[] {
	return checks.toSorted((left, right) => CHECK_ORDER[left.state] - CHECK_ORDER[right.state]);
}

export function checksSummary(checks: readonly PullRequestCheck[]): string {
	const groups: [number, (inputs: { count: number }) => string][] = [
		[CHECK_ORDER.failure, m.pull_request_checks_failing],
		[CHECK_ORDER.pending, m.pull_request_checks_running],
		[CHECK_ORDER.success, m.pull_request_checks_passed],
		[CHECK_ORDER.neutral, m.pull_request_checks_neutral],
		[CHECK_ORDER.skipped, m.pull_request_checks_skipped],
	];
	return groups
		.map(([order, label]) => ({
			label,
			count: checks.filter((check) => CHECK_ORDER[check.state] === order).length,
		}))
		.filter((group) => group.count > 0)
		.map((group) => group.label({ count: group.count }))
		.join(' · ');
}

export function checkStateClass(state: PullRequestCheck['state']): string {
	if (state === 'success') return 'text-git-added';
	if (state === 'failure') return 'text-git-deleted';
	if (state === 'pending') return 'text-diff-modified-foreground';
	return 'text-muted-foreground';
}
