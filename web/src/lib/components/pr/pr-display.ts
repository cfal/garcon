// Pure presentation helpers for the pull request viewer. Maps PR domain state
// to semantic-token classes so components stay free of hard-coded palettes.

import type {
	PullRequestCheck,
	PullRequestCheckState,
	PullRequestChecksState,
	PullRequestReviewDecision,
	PullRequestState,
} from '$lib/api/pull-requests';

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

export function checkStateClass(state: PullRequestCheckState): string {
	switch (state) {
		case 'success':
			return 'text-git-added';
		case 'failure':
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
