import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client.js';
import { getSharedChat } from '../shares.js';

describe('shared chat API', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('requests a bounded public page with the standard timeout', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ snapshot: null, page: null }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await getSharedChat('share token', 42, 'version');

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/shared?token=share+token&limit=200&before=42&version=version');
		expect(options.signal).toBeDefined();
		expect(options.headers).toBeUndefined();
	});

	it('preserves HTTP status in API errors', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'Share not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				}),
			),
		);

		await expect(getSharedChat('missing')).rejects.toMatchObject({
			name: ApiError.name,
			status: 404,
			message: 'Share not found',
		});
	});
});
