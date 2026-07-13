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

function createVisibleStore(): PullRequestsStore {
	const store = new PullRequestsStore();
	store.setCapability(true, true);
	store.setVisible(true);
	return store;
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
		const store = createVisibleStore();
		store.setProject('/proj');
		await tick();
		expect(store.pulls).toHaveLength(2);
		expect(store.repoName).toBe('o/r');
		expect(store.hasLoaded).toBe(true);
	});

	it('records a load error on failure', async () => {
		getPullRequestsMock.mockRejectedValue(new Error('boom'));
		const store = createVisibleStore();
		store.setProject('/proj');
		await tick();
		expect(store.loadError).toBe('boom');
	});

	it('loads detail on select', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(7)], repo: null });
		getPullRequestMock.mockResolvedValue(detail(7));
		const store = createVisibleStore();
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
		const store = createVisibleStore();
		store.setProject('/proj-a');
		store.setProject('/proj-b');
		await tick();
		resolveFirst?.();
		await tick();
		expect(store.pulls.map((pr) => pr.number)).toEqual([99]);
	});

	it('drops a stale list response after the project is cleared', async () => {
		let resolveFirst: (() => void) | undefined;
		getPullRequestsMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = () => resolve({ pulls: [summary(1)], repo: { nameWithOwner: 'o/r' } });
				}),
		);
		const store = createVisibleStore();
		store.setProject('/proj');
		store.setProject(null);
		resolveFirst?.();
		await tick();
		expect(store.pulls).toEqual([]);
		expect(store.repoName).toBe(null);
		expect(store.hasLoaded).toBe(false);
	});

	it('clears selection when the project changes', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(1)], repo: null });
		getPullRequestMock.mockResolvedValue(detail(1));
		const store = createVisibleStore();
		store.setProject('/proj');
		await tick();
		await store.select(1);
		expect(store.hasSelection).toBe(true);
		store.setProject('/other');
		expect(store.hasSelection).toBe(false);
		expect(store.detail).toBe(null);
	});

	it('restores the bounded project presentation snapshot before refreshing', async () => {
		getPullRequestsMock
			.mockResolvedValueOnce({ pulls: [summary(1)], repo: { nameWithOwner: 'o/a' } })
			.mockResolvedValueOnce({ pulls: [summary(2)], repo: { nameWithOwner: 'o/b' } })
			.mockResolvedValueOnce({ pulls: [summary(1)], repo: { nameWithOwner: 'o/a' } });
		getPullRequestMock.mockResolvedValue(detail(1));
		const store = createVisibleStore();
		store.setProject('/project-a', '/canonical/a');
		await tick();
		await store.select(1);
		store.setProject('/project-b', '/canonical/b');
		await tick();

		store.setProject('/project-a-alias', '/canonical/a');
		expect(store.pulls.map((pull) => pull.number)).toEqual([1]);
		expect(store.selectedNumber).toBe(1);
		expect(store.detail?.number).toBe(1);
		await tick();
		expect(getPullRequestsMock).toHaveBeenCalledTimes(3);
	});

	it('does not reload or clear selection for another chat with the same project key', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(3)], repo: null });
		getPullRequestMock.mockResolvedValue(detail(3));
		const store = createVisibleStore();
		store.setProject('/project-link', '/canonical/project');
		await tick();
		await store.select(3);

		store.setProject('/canonical/project', '/canonical/project');
		expect(store.selectedNumber).toBe(3);
		expect(store.detail?.number).toBe(3);
		expect(getPullRequestsMock).toHaveBeenCalledOnce();
	});

	it('resumes an aborted selected detail when the surface becomes visible again', async () => {
		getPullRequestsMock.mockResolvedValue({ pulls: [summary(4)], repo: null });
		getPullRequestMock
			.mockImplementationOnce(() => new Promise(() => undefined))
			.mockResolvedValueOnce(detail(4));
		const store = createVisibleStore();
		store.setProject('/proj');
		await tick();

		void store.select(4);
		await tick();
		store.setVisible(false);
		expect(store.selectedNumber).toBe(4);
		expect(store.detail).toBeNull();

		store.setVisible(true);
		await tick();

		expect(getPullRequestMock).toHaveBeenCalledTimes(2);
		expect(store.detail?.number).toBe(4);
	});

	it('aborts reads when capability disappears and retries in place after recovery', async () => {
		let firstSignal: AbortSignal | undefined;
		getPullRequestsMock
			.mockImplementationOnce((_projectPath, options) => {
				firstSignal = options?.signal;
				return new Promise(() => undefined);
			})
			.mockResolvedValueOnce({ pulls: [summary(8)], repo: null });
		const store = createVisibleStore();
		store.setProject('/proj');
		await tick();

		store.setCapability(true, false);
		expect(firstSignal?.aborted).toBe(true);
		expect(store.capabilityState).toBe('unavailable');
		expect(store.isLoading).toBe(false);

		store.setCapability(true, true);
		await tick();
		expect(store.capabilityState).toBe('available');
		expect(store.pulls.map((pull) => pull.number)).toEqual([8]);
	});
});
