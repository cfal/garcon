import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PullRequestsStore } from '../pull-requests.svelte';
import * as prApi from '$lib/api/pull-requests';
import type { PullRequestDetail, PullRequestSummary } from '$lib/api/pull-requests';

vi.mock('$lib/api/pull-requests', () => ({
	getPullRequests: vi.fn(),
	getPullRequest: vi.fn(),
}));

const getPullRequestsMock = vi.mocked(prApi.getPullRequests);
const getPullRequestMock = vi.mocked(prApi.getPullRequest);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function summary(number: number, over: Partial<PullRequestSummary> = {}): PullRequestSummary {
	return {
		number,
		title: `PR ${number}`,
		state: 'open',
		isDraft: false,
		author: 'octocat',
		headRefName: 'feat/x',
		baseRefName: 'main',
		additions: 1,
		deletions: 0,
		changedFiles: 1,
		updatedAt: '2024-01-01T00:00:00Z',
		url: `https://example/pull/${number}`,
		reviewDecision: null,
		checksState: 'none',
		...over,
	};
}

function detail(number: number): PullRequestDetail {
	return {
		...summary(number),
		body: '',
		createdAt: '2024-01-01T00:00:00Z',
		mergeable: 'mergeable',
		checks: [],
		files: [],
		fileBodies: {},
		threads: [],
	};
}

describe('PullRequestsStore', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('loads the list when a project is set', async () => {
		getPullRequestsMock.mockResolvedValue({
			pulls: [summary(1), summary(2)],
			repo: { nameWithOwner: 'o/r' },
		});
		const store = new PullRequestsStore();
		store.setProject('/proj');
		await tick();
		expect(store.pulls).toHaveLength(2);
		expect(store.repoName).toBe('o/r');
		expect(store.hasLoaded).toBe(true);
	});

	it('records a load error on failure', async () => {
		getPullRequestsMock.mockRejectedValue(new Error('boom'));
		const store = new PullRequestsStore();
		store.setProject('/proj');
		await tick();
		expect(store.loadError).toBe('boom');
	});

	it('loads detail on select', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(7)], repo: null });
		getPullRequestMock.mockResolvedValue(detail(7));
		const store = new PullRequestsStore();
		store.setProject('/proj');
		await tick();
		await store.select(7);
		expect(store.selectedNumber).toBe(7);
		expect(store.detail?.number).toBe(7);
	});

	it('drops a stale list response after the project changes', async () => {
		let resolveFirst: (() => void) | undefined;
		getPullRequestsMock
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = () => resolve({ pulls: [summary(1)], repo: null });
					}),
			)
			.mockResolvedValueOnce({ pulls: [summary(99)], repo: null });
		const store = new PullRequestsStore();
		store.setProject('/proj-a');
		store.setProject('/proj-b');
		await tick();
		resolveFirst?.();
		await tick();
		expect(store.pulls.map((pr) => pr.number)).toEqual([99]);
	});

	it('clears selection when the project changes', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(1)], repo: null });
		getPullRequestMock.mockResolvedValue(detail(1));
		const store = new PullRequestsStore();
		store.setProject('/proj');
		await tick();
		await store.select(1);
		expect(store.hasSelection).toBe(true);
		store.setProject('/other');
		expect(store.hasSelection).toBe(false);
		expect(store.detail).toBe(null);
	});
});
