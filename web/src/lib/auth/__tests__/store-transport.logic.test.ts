// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { AuthStore } from '$lib/stores/auth.svelte';
import { clearAuthToken, setAuthDispatchAvailable, setAuthToken } from '../session';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('discards malformed stored headers through the real probe without looping or losing memory authority', async () => {
	vi.useFakeTimers();
	const values = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	} satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>);
	clearAuthToken();
	setAuthDispatchAvailable(true);
	const user = { id: 'synthetic-owner', username: 'synthetic-owner' };
	const token = (revision: number) =>
		`header.${btoa(JSON.stringify({ sub: user.id, credentialRevision: revision }))}.signature`;
	const current = token(1);
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
		if (url === '/api/v1/auth/status')
			return Response.json({ needsSetup: false, authDisabled: false, isAuthenticated: false });
		expect(url).toBe('/api/v1/auth/user');
		expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${current}`);
		return Response.json({ user });
	});
	vi.stubGlobal('fetch', fetch);
	setAuthToken(current);
	const auth = new AuthStore();
	try {
		await auth.checkAuthStatus();
		fetch.mockClear();
		localStorage.setItem('bearer-token', token(999) + '\ninvalid');
		await auth.reconcile();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.token).toBe(current);
		expect(localStorage.getItem('bearer-token')).toBe(current);
	} finally {
		auth.destroy();
	}
});
