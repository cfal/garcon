import { describe, expect, it } from 'vitest';
import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';
import type { PullRequestSummary } from '$shared/gh';
import { groupInbox, matchesInboxSearch } from '../pull-request-inbox.js';

function entry(
	number: number,
	pull: Partial<PullRequestSummary> = {},
	repositoryId = 'repo-a',
): PullRequestReviewInboxEntry {
	return {
		repositoryId,
		latestRun: null,
		historyRevision: 0,
		autoReview: { kind: 'off' },
		pull: {
			number,
			title: `Change ${number}`,
			state: 'open',
			isDraft: false,
			author: 'author',
			headRefName: 'feature',
			baseRefName: 'main',
			additions: 1,
			deletions: 1,
			changedFiles: 1,
			createdAt: '',
			updatedAt: `2026-01-0${number}T00:00:00Z`,
			url: `https://github.com/acme/app/pull/${number}`,
			reviewDecision: null,
			checksState: 'none',
			headRefOid: 'a'.repeat(40),
			isCrossRepository: false,
			authorAssociation: 'member',
			authorIsBot: false,
			authoredByViewer: false,
			labels: [],
			reviewRequest: null,
			...pull,
		},
	};
}

describe('pull request inbox', () => {
	it('places each pull request in the first group it belongs to, newest first', () => {
		const entries = [
			entry(1, { reviewRequest: 'me', authoredByViewer: true }),
			entry(2, { authoredByViewer: true }),
			entry(3, { reviewRequest: 'team' }),
			entry(4),
			entry(5),
		];
		const groups = groupInbox(entries, { query: '', repositoryId: null });
		expect(
			groups.map((group) => [group.id, group.entries.map((item) => item.pull.number)]),
		).toEqual([
			['needs-my-review', [1]],
			['authored-by-me', [2]],
			['needs-team-review', [3]],
			['other-open', [5, 4]],
		]);
	});

	it('applies the repository filter to every group', () => {
		const entries = [
			entry(1, { reviewRequest: 'me' }, 'repo-b'),
			entry(2, { reviewRequest: 'me' }),
			entry(3, {}, 'repo-b'),
		];
		const groups = groupInbox(entries, { query: '', repositoryId: 'repo-a' });
		expect(groups.flatMap((group) => group.entries.map((item) => item.pull.number))).toEqual([2]);
	});

	it.each([
		['a title word', 'change 2', true],
		['the number', '#2', true],
		['a pasted link', 'https://github.com/acme/app/pull/2/files?w=1', true],
		['a link to another pull request', 'https://github.com/acme/app/pull/20', false],
		['an unrelated word', 'queue', false],
	])('matches %s', (_name, query, expected) => {
		expect(matchesInboxSearch(entry(2), query)).toBe(expected);
	});
});
