import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGhStatus } from '../gh';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
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
					available: true,
					authenticated: true,
					reason: 'authenticated',
					host: 'github.com',
					login: 'octocat',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);

		const result = await getGhStatus();

		expect(result.available).toBe(true);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/gh/status');
	});
});
