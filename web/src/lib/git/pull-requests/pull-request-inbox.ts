// Groups and filters the cross-repository pull request inbox.

import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';

export type PullRequestInboxGroupId =
	'needs-my-review' | 'authored-by-me' | 'needs-team-review' | 'other-open';

export interface PullRequestInboxGroup {
	id: PullRequestInboxGroupId;
	entries: PullRequestReviewInboxEntry[];
}

export function inboxEntryKey(
	entry: Pick<PullRequestReviewInboxEntry, 'repositoryId'> & { pull: { number: number } },
): string {
	return `${entry.repositoryId}#${entry.pull.number}`;
}

// Matches the title, number, author, or branch, and a pasted pull request link by its URL.
export function matchesInboxSearch(entry: PullRequestReviewInboxEntry, query: string): boolean {
	const text = query.trim().toLowerCase();
	if (!text) return true;
	const { pull } = entry;
	const link = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(text)?.[0];
	if (link) return pull.url.toLowerCase() === link;
	return [pull.title, `#${pull.number}`, String(pull.number), pull.author, pull.headRefName].some(
		(value) => value.toLowerCase().includes(text),
	);
}

function groupOf(entry: PullRequestReviewInboxEntry): PullRequestInboxGroupId {
	if (entry.pull.reviewRequest === 'me') return 'needs-my-review';
	if (entry.pull.authoredByViewer) return 'authored-by-me';
	if (entry.pull.reviewRequest === 'team') return 'needs-team-review';
	return 'other-open';
}

// Places each matching pull request in the first group it belongs to, newest first.
export function groupInbox(
	entries: readonly PullRequestReviewInboxEntry[],
	options: { query: string; repositoryId: string | null },
): PullRequestInboxGroup[] {
	const groups: PullRequestInboxGroup[] = [
		{ id: 'needs-my-review', entries: [] },
		{ id: 'authored-by-me', entries: [] },
		{ id: 'needs-team-review', entries: [] },
		{ id: 'other-open', entries: [] },
	];
	const visible = entries
		.filter((entry) => options.repositoryId === null || entry.repositoryId === options.repositoryId)
		.filter((entry) => matchesInboxSearch(entry, options.query))
		.toSorted((left, right) => right.pull.updatedAt.localeCompare(left.pull.updatedAt));
	for (const entry of visible)
		groups.find((group) => group.id === groupOf(entry))!.entries.push(entry);
	return groups;
}
