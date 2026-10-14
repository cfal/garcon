// Groups and filters the cross-repository pull request inbox.

import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';

export type PullRequestInboxGroupId = 'needs-my-review' | 'authored-by-me' | 'needs-team-review' | 'all-open';

export interface PullRequestInboxGroup {
	id: PullRequestInboxGroupId;
	entries: PullRequestReviewInboxEntry[];
}

export function inboxEntryKey(entry: Pick<PullRequestReviewInboxEntry, 'repositoryId'> & { pull: { number: number } }): string {
	return `${entry.repositoryId}#${entry.pull.number}`;
}

// Matches the title, number, author, or branch, and a pasted pull request link by its URL.
export function matchesInboxSearch(entry: PullRequestReviewInboxEntry, query: string): boolean {
	const text = query.trim().toLowerCase();
	if (!text) return true;
	const { pull } = entry;
	const link = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(text)?.[0];
	if (link) return pull.url.toLowerCase() === link;
	return [pull.title, `#${pull.number}`, String(pull.number), pull.author, pull.headRefName]
		.some((value) => value.toLowerCase().includes(text));
}

export function groupInbox(
	entries: readonly PullRequestReviewInboxEntry[],
	options: { query: string; repositoryId: string | null },
): PullRequestInboxGroup[] {
	const visible = entries
		.filter((entry) => matchesInboxSearch(entry, options.query))
		.toSorted((left, right) => right.pull.updatedAt.localeCompare(left.pull.updatedAt));
	return [
		{ id: 'needs-my-review', entries: visible.filter((entry) => entry.pull.reviewRequest === 'me') },
		{ id: 'authored-by-me', entries: visible.filter((entry) => entry.pull.authoredByViewer) },
		{ id: 'needs-team-review', entries: visible.filter((entry) => entry.pull.reviewRequest === 'team') },
		{
			id: 'all-open',
			entries: options.repositoryId === null ? visible : visible.filter((entry) => entry.repositoryId === options.repositoryId),
		},
	];
}
