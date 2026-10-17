import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGhStatus } from '../gh';
import { getPullRequest, getPullRequests } from '../pull-requests';
import { GH_DETAIL_TIMEOUT_MS } from '$shared/git-execution';

vi.stubGlobal('localStorage', {
	getItem: (key: string) =>
		key === 'bearer-token' ? JSON.stringify({ token: 'test-token', epoch: null }) : null,
	setItem: () => {},
	removeItem: () => {},
});

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

	it.each(['list', 'detail'] as const)(
		'keeps the %s request alive for the full paginated GitHub read budget',
		async (operation) => {
			const deadline = new AbortController();
			const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
			const target = {
				executorId: 'remote-executor',
				projectPath: '/project',
				repository: { host: 'github.example.com', nameWithOwner: 'acme/app' },
			};
			fetchMock.mockResolvedValue(
				new Response(
					JSON.stringify({
						executorId: target.executorId,
						instanceId: 'instance',
						pulls: [],
						fileBodies: {},
					}),
				),
			);

			if (operation === 'list') await getPullRequests(target);
			else await getPullRequest(target, 42);

			expect(timeout).toHaveBeenCalledWith(GH_DETAIL_TIMEOUT_MS);
			expect(fetchMock.mock.calls[0][1].signal).toBe(deadline.signal);
			expect(fetchMock.mock.calls[0][0]).toContain('executorId=remote-executor');
			if (operation === 'detail') {
				const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
				expect(url.searchParams.get('repositoryHost')).toBe('github.example.com');
				expect(url.searchParams.get('repositoryName')).toBe('acme/app');
			}
		},
	);

	it.each(['list', 'detail'] as const)(
		'preserves a shorter caller budget and cancellation for %s',
		async (operation) => {
			const timeout = vi.spyOn(AbortSignal, 'timeout');
			const caller = new AbortController();
			const target = {
				executorId: 'local',
				projectPath: '/project',
				repository: { host: 'github.com', nameWithOwner: 'acme/app' },
			};
			fetchMock.mockResolvedValue(
				new Response(
					JSON.stringify({
						executorId: 'local',
						instanceId: 'instance',
						pulls: [],
						fileBodies: {},
					}),
				),
			);
			const options = { timeoutMs: 123, signal: caller.signal };

			if (operation === 'list') await getPullRequests(target, options);
			else await getPullRequest(target, 42, options);

			expect(timeout).toHaveBeenCalledWith(123);
			const requestSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
			caller.abort();
			expect(requestSignal.aborted).toBe(true);
		},
	);
});
