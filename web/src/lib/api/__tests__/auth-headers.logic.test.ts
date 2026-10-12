// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { getUser } from '../auth';

afterEach(() => vi.unstubAllGlobals());

it.each(['malformed\nheader', 'non-byte-\u03bb'])(
	'rejects an invalid bearer header locally without issuing a request: %j',
	async (token) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal('fetch', fetch);
		await expect(getUser(token)).rejects.toMatchObject({
			errorCode: 'AUTH_SESSION_INVALID',
		});
		expect(fetch).not.toHaveBeenCalled();
	},
);

it('does not classify network failure as a malformed token', async () => {
	const error = new TypeError('Network unavailable');
	vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
	await expect(getUser('synthetic-token')).rejects.toBe(error);
});
