import type { IssueActivity, IssuePriority, IssueStatus } from '$shared/issues';
import * as m from '$lib/paraglide/messages.js';

export function issueStatusLabel(status: IssueStatus): string {
	return {
		open: m.issues_open,
		'in-progress': m.issues_in_progress,
		'in-review': m.issues_in_review,
		closed: m.issues_closed,
	}[status]();
}
export function issuePriorityLabel(priority: IssuePriority): string {
	return [m.issues_urgent, m.issues_high, m.issues_normal, m.issues_low][priority]!();
}
export function issueActivityLabel(action: IssueActivity['action']): string {
	return {
		created: m.issues_actor_created,
		updated: m.issues_actor_updated,
		claimed: m.issues_actor_claimed,
		released: m.issues_actor_released,
		closed: m.issues_actor_closed,
		reopened: m.issues_actor_reopened,
		'comment-added': m.issues_actor_comment_added,
		'comment-edited': m.issues_actor_comment_edited,
		'comment-removed': m.issues_actor_comment_removed,
		linked: m.issues_actor_linked,
		unlinked: m.issues_actor_unlinked,
	}[action]();
}
export interface IssueChatSummary {
	readonly id: string;
	readonly title: string | null;
}

export function isIssueProjectPath(project: string): boolean {
	return /^(?:[/\\]|[a-zA-Z]:[/\\])/.test(project);
}

export function issueDeepLink(issueId: string): string {
	const url = new URL('/', window.location.origin);
	url.searchParams.set('issue', issueId);
	return url.href;
}
