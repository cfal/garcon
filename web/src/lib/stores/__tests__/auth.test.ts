import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthStore } from '../auth.svelte';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store[k] ?? null,
	setItem: (k: string, v: string) => { store[k] = v; },
	removeItem: (k: string) => { delete store[k]; },
});

vi.mock('$lib/api/auth.js', () => ({
	getAuthStatus: vi.fn(),
	login: vi.fn(),
	register: vi.fn(),
	getUser: vi.fn(),
	logout: vi.fn(),
}));

vi.mock('$lib/api/client.js', () => ({
	getAuthToken: () => localStorage.getItem('bearer-token'),
	setAuthToken: vi.fn(),
	clearAuthToken: vi.fn(),
	ApiError: class extends Error {
		status: number;
		constructor(status: number, message: string) {
			super(message);
			this.status = status;
		}
	},
}));

import {
	getAuthStatus,
	login as apiLogin,
	register as apiRegister,
	getUser,
	logout as apiLogout,
} from '$lib/api/auth.js';
import { setAuthToken, clearAuthToken } from '$lib/api/client.js';

describe('AuthStore', () => {
	beforeEach(() => {
		for (const k of Object.keys(store)) delete store[k];
		vi.clearAllMocks();
	});

	describe('constructor', () => {
		it('reads token from localStorage', () => {
			store['bearer-token'] = 'saved-token';
			const auth = new AuthStore();
			expect(auth.token).toBe('saved-token');
		});

		it('starts with isLoading true', () => {
			const auth = new AuthStore();
			expect(auth.isLoading).toBe(true);
			expect(auth.isAuthenticated).toBe(false);
		});
	});

	describe('checkAuthStatus', () => {
		it('sets needsSetup when server reports setup needed', async () => {
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: true, isAuthenticated: false, authDisabled: false,
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.needsSetup).toBe(true);
			expect(auth.isLoading).toBe(false);
		});

		it('validates stored token by fetching user', async () => {
			store['bearer-token'] = 'valid-token';
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false, isAuthenticated: true, authDisabled: false,
			});
			vi.mocked(getUser).mockResolvedValue({
				user: { id: '1', username: 'admin' },
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.user).toEqual({ id: '1', username: 'admin' });
		});

		it('clears invalid token when getUser fails', async () => {
			store['bearer-token'] = 'expired-token';
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false, isAuthenticated: false, authDisabled: false,
			});
			vi.mocked(getUser).mockRejectedValue(new Error('401'));
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.token).toBeNull();
			expect(clearAuthToken).toHaveBeenCalled();
		});

		it('enters app mode without token when auth is disabled by server config', async () => {
			store['bearer-token'] = 'stale-token';
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false, isAuthenticated: true, authDisabled: true,
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.authDisabled).toBe(true);
			expect(auth.isAuthenticated).toBe(true);
			expect(auth.user).toEqual({ id: 'local', username: 'local' });
			expect(auth.token).toBeNull();
			expect(clearAuthToken).toHaveBeenCalled();
		});
	});

	describe('login', () => {
		it('persists token on success', async () => {
			vi.mocked(apiLogin).mockResolvedValue({
				success: true, token: 'new-token',
				user: { id: '1', username: 'admin' },
			});
			const auth = new AuthStore();
			const result = await auth.login('admin', 'pass');
			expect(result.success).toBe(true);
			expect(auth.token).toBe('new-token');
			expect(setAuthToken).toHaveBeenCalledWith('new-token');
		});

		it('returns error on failure', async () => {
			vi.mocked(apiLogin).mockRejectedValue(new Error('bad creds'));
			const auth = new AuthStore();
			const result = await auth.login('admin', 'wrong');
			expect(result.success).toBe(false);
			expect(auth.error).toBeTruthy();
		});
	});

	describe('register', () => {
		it('persists token and clears needsSetup on success', async () => {
			vi.mocked(apiRegister).mockResolvedValue({
				success: true, token: 'reg-token',
				user: { id: '2', username: 'newuser' },
			});
			const auth = new AuthStore();
			auth.needsSetup = true;
			const result = await auth.register('newuser', 'pass');
			expect(result.success).toBe(true);
			expect(auth.needsSetup).toBe(false);
			expect(auth.token).toBe('reg-token');
			expect(setAuthToken).toHaveBeenCalledWith('reg-token');
		});
	});

	describe('logout', () => {
		it('clears state and calls server', () => {
			vi.mocked(apiLogout).mockResolvedValue(undefined);
			const auth = new AuthStore();
			auth.token = 'tok';
			auth.user = { id: '1', username: 'admin' };
			auth.logout();
			expect(auth.token).toBeNull();
			expect(auth.user).toBeNull();
			expect(apiLogout).toHaveBeenCalled();
		});

		it('skips server call when no token', () => {
			const auth = new AuthStore();
			auth.logout();
			expect(apiLogout).not.toHaveBeenCalled();
		});
	});
});
