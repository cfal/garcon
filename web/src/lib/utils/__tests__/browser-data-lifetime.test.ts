import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	localStorage.clear();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it('publishes logout on HTTP origins without crypto.randomUUID', async () => {
	vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
	const lifetime = await import('../browser-data-lifetime');
	lifetime.captureBrowserDataLifetime();
	const logout = lifetime.publishBrowserLogout();
	expect(logout.coordinated).toBe(true);
	expect(logout.epoch).toMatch(/^[a-f0-9-]{36}$/);
	expect(localStorage.getItem(lifetime.BROWSER_LOGOUT_EPOCH_KEY)).toBe(logout.epoch);
	expect(lifetime.isBrowserDataCurrent()).toBe(false);
});

it('fences an old document before a storage event or pagehide flush', async () => {
	const lifetime = await import('../browser-data-lifetime');
	const { setLocalStorageItem, LOCAL_STORAGE_KEYS } = await import('../local-persistence');
	lifetime.captureBrowserDataLifetime();
	setLocalStorageItem(LOCAL_STORAGE_KEYS.workspaceLayout, 'old layout');
	localStorage.setItem(lifetime.BROWSER_LOGOUT_EPOCH_KEY, 'logout');
	localStorage.removeItem(LOCAL_STORAGE_KEYS.workspaceLayout);
	expect(lifetime.isBrowserDataCurrent()).toBe(false);
	setLocalStorageItem(LOCAL_STORAGE_KEYS.workspaceLayout, 'late checkpoint');
	expect(localStorage.getItem(LOCAL_STORAGE_KEYS.workspaceLayout)).toBeNull();
});

it('never resumes a retired document but allows a fresh document after logout', async () => {
	const previous = await import('../browser-data-lifetime');
	previous.captureBrowserDataLifetime();
	const logout = previous.publishBrowserLogout();
	expect(logout.coordinated).toBe(true);
	expect(previous.isBrowserDataCurrent()).toBe(false);
	vi.resetModules();
	const next = await import('../browser-data-lifetime');
	next.captureBrowserDataLifetime();
	expect(next.isBrowserDataCurrent()).toBe(true);
	expect(next.canPersistBrowserData()).toBe(false);
	previous.finishBrowserLogoutCleanup(logout);
	expect(next.canPersistBrowserData()).toBe(true);
	expect(previous.isBrowserDataCurrent()).toBe(false);
});

it("never tags a late bearer write with another document's logout epoch", async () => {
	const lifetime = await import('../browser-data-lifetime');
	const session = await import('$lib/auth/session');
	lifetime.captureBrowserDataLifetime();
	const write = localStorage.setItem.bind(localStorage);
	vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
		if (key === 'bearer-token') {
			write(lifetime.BROWSER_LOGOUT_EPOCH_KEY, 'logout-from-peer');
			localStorage.removeItem('bearer-token');
		}
		write(key, value);
	});
	expect(session.setAuthToken('late-valid-login')).toBe(false);
	expect(session.readStoredAuthToken()).toBeNull();
	expect(JSON.parse(localStorage.getItem('bearer-token')!)).toEqual({
		token: 'late-valid-login',
		epoch: null,
	});
});

it('bounds abandoned cleanup admission and refuses a late deletion after expiry', async () => {
	vi.useFakeTimers();
	const previous = await import('../browser-data-lifetime');
	const logout = previous.publishBrowserLogout();
	vi.resetModules();
	const fresh = await import('../browser-data-lifetime');
	fresh.captureBrowserDataLifetime();
	expect(fresh.canPersistBrowserData()).toBe(false);
	const waiting = fresh.waitForBrowserLogoutCleanup();
	await vi.advanceTimersByTimeAsync(10_000);
	await waiting;
	expect(fresh.canPersistBrowserData()).toBe(true);
	expect(previous.canClearBrowserData(logout)).toBe(false);
});
