import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGhStatus } from '../gh';
import {
	getPullRequestDiff,
	getPullRequestReviewThreads,
	getPullRequestStatus,
	getPullRequests,
	type PullRequestTarget,
} from '../pull-requests';
import type { ApiFetchOptions } from '../client';
import { GH_DETAIL_TIMEOUT_MS } from '$shared/git-execution';

vi.stubGlobal('localStorage', {
	getItem: (key: string) =>
		key === 'bearer-token' ? JSON.stringify({ token: 'test-token', epoch: null }) : null,
	setItem: () => {},
	removeItem: () => {},
});

const commits = { baseRefOid: 'e'.repeat(40), headRefOid: 'a'.repeat(40) };

type Operation = 'list' | 'status' | 'diff' | 'threads';

const PATHS: Record<Operation, string> = {
	list: '/api/v1/gh/pull-requests',
	status: '/api/v1/gh/pull-request/status',
	diff: '/api/v1/gh/pull-request/diff',
	threads: '/api/v1/gh/pull-request/review-threads',
};

function read(
	operation: Operation,
	target: PullRequestTarget,
	options?: ApiFetchOptions,
): Promise<unknown> {
	switch (operation) {
		case 'list':
			return getPullRequests(target, options);
		case 'status':
			return getPullRequestStatus(target, 42, options);
		case 'diff':
			return getPullRequestDiff(target, 42, commits, options);
		case 'threads':
			return getPullRequestReviewThreads(target, 42, options);
	}
}

function payload(executorId: string): Response {
	return new Response(
		JSON.stringify({
			executorId,
			instanceId: 'instance',
			number: 42,
			pulls: [],
			files: [],
			fileBodies: {},
			threads: [],
			...commits,
		}),
	);
}

describe('gh API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getGhStatus calls GET /api/v1/gh/status', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					executorId: 'remote-executor',
					instanceId: 'test-instance',
					available: true,
					authenticated: true,
					reason: 'authenticated',
					host: 'github.com',
					login: 'octocat',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);

		const result = await getGhStatus('remote-executor');

		expect(result.available).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/gh/status?executorId=remote-executor');
	});

	it.each(['list', 'status', 'diff', 'threads'] as const)(
		'keeps the %s request alive for the full paginated GitHub read budget',
		async (operation) => {
			const deadline = new AbortController();
			const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
			const target = {
				executorId: 'remote-executor',
				projectPath: '/project',
				repository: { host: 'github.example.com', nameWithOwner: 'acme/app' },
			};
			fetchMock.mockResolvedValue(payload(target.executorId));

			await read(operation, target);

			expect(timeout).toHaveBeenCalledWith(GH_DETAIL_TIMEOUT_MS);
			expect(fetchMock.mock.calls[0][1].signal).toBe(deadline.signal);
			const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
			expect(url.pathname).toBe(PATHS[operation]);
			expect(url.searchParams.get('executorId')).toBe('remote-executor');
			if (operation !== 'list') {
				expect(url.searchParams.get('number')).toBe('42');
				expect(url.searchParams.get('repositoryHost')).toBe('github.example.com');
				expect(url.searchParams.get('repositoryName')).toBe('acme/app');
			}
			expect(url.searchParams.get('baseRefOid')).toBe(
				operation === 'diff' ? commits.baseRefOid : null,
			);
			expect(url.searchParams.get('headRefOid')).toBe(
				operation === 'diff' ? commits.headRefOid : null,
			);
		},
	);

	it.each(['list', 'status', 'diff', 'threads'] as const)(
		'preserves a shorter caller budget and cancellation for %s',
		async (operation) => {
			const timeout = vi.spyOn(AbortSignal, 'timeout');
			const caller = new AbortController();
			const target = {
				executorId: 'local',
				projectPath: '/project',
				repository: { host: 'github.com', nameWithOwner: 'acme/app' },
			};
			fetchMock.mockResolvedValue(payload('local'));
			const options = { timeoutMs: 123, signal: caller.signal };

			await read(operation, target, options);

			expect(timeout).toHaveBeenCalledWith(123);
			const requestSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
			caller.abort();
			expect(requestSignal.aborted).toBe(true);
		},
	);

	it.each(['status', 'diff', 'threads'] as const)(
		'rejects a %s reply from another executor',
		async (operation) => {
			const target = {
				executorId: 'remote-executor',
				projectPath: '/project',
				repository: { host: 'github.com', nameWithOwner: 'acme/app' },
			};
			fetchMock.mockResolvedValue(payload('local'));
			await expect(read(operation, target)).rejects.toMatchObject({
				errorCode: 'GIT_INVALID_RESULT',
			});
		},
	);
});
