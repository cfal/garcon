import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthStore } from '../auth.svelte';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

vi.mock('$lib/api/auth.js', () => ({
	getAuthStatus: vi.fn(),
	login: vi.fn(),
	register: vi.fn(),
	getUser: vi.fn(),
}));

import {
	getAuthStatus,
	login as apiLogin,
	register as apiRegister,
	getUser,
} from '$lib/api/auth.js';
import { ApiError } from '$lib/api/client.js';

describe('AuthStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		localStorage.clear();
	});

	describe('constructor', () => {
		it('reads token from localStorage', () => {
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'saved-token');
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
		it.each([
			{ status: 400, retryable: false, attempts: 1 },
			{ status: 403, retryable: false, attempts: 1 },
			{ status: 429, retryable: false, attempts: 5 },
			{ status: 503, retryable: false, attempts: 5 },
			{ status: 409, retryable: true, attempts: 5 },
		])(
			'makes $attempts attempts for HTTP $status (retryable: $retryable)',
			async ({ status, retryable, attempts }) => {
				vi.useFakeTimers();
				vi.mocked(getAuthStatus).mockRejectedValue(
					new ApiError(status, 'Unavailable', undefined, undefined, retryable),
				);
				const auth = new AuthStore();
				const check = auth.checkAuthStatus();
				await vi.runAllTimersAsync();
				await check;
				expect(getAuthStatus).toHaveBeenCalledTimes(attempts);
				expect(auth.isLoading).toBe(false);
				expect(auth.isUnavailable).toBe(true);
			},
		);

		it('coalesces concurrent recovery checks', async () => {
			let resolveStatus!: (status: {
				needsSetup: boolean;
				isAuthenticated: boolean;
				authDisabled: boolean;
			}) => void;
			vi.mocked(getAuthStatus).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveStatus = resolve;
					}),
			);
			const auth = new AuthStore();
			const first = auth.checkAuthStatus();
			const second = auth.checkAuthStatus();
			expect(getAuthStatus).toHaveBeenCalledTimes(1);
			resolveStatus({ needsSetup: false, isAuthenticated: false, authDisabled: false });
			await Promise.all([first, second]);
			expect(getAuthStatus).toHaveBeenCalledTimes(1);
		});

		it('sets needsSetup when server reports setup needed', async () => {
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: true,
				isAuthenticated: false,
				authDisabled: false,
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.needsSetup).toBe(true);
			expect(auth.isLoading).toBe(false);
		});

		it('validates stored token by fetching user', async () => {
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'valid-token');
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false,
				isAuthenticated: true,
				authDisabled: false,
			});
			vi.mocked(getUser).mockResolvedValue({
				user: { id: '1', username: 'admin' },
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.user).toEqual({ id: '1', username: 'admin' });
		});

		it.each([401, 403])(
			'clears an invalid token after an authoritative %i rejection',
			async (status) => {
				localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'expired-token');
				vi.mocked(getAuthStatus).mockResolvedValue({
					needsSetup: false,
					isAuthenticated: false,
					authDisabled: false,
				});
				vi.mocked(getUser).mockRejectedValue(new ApiError(status, 'Rejected'));
				const auth = new AuthStore();
				await auth.checkAuthStatus();
				expect(auth.token).toBeNull();
				expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBeNull();
			},
		);

		it('keeps the token and retries when auth status is temporarily unreachable', async () => {
			vi.useFakeTimers();
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'saved-token');
			vi.mocked(getAuthStatus).mockRejectedValue(new TypeError('Failed to fetch'));
			const auth = new AuthStore();

			const check = auth.checkAuthStatus();
			await vi.runAllTimersAsync();
			await check;

			expect(getAuthStatus).toHaveBeenCalledTimes(5);
			expect(auth.token).toBe('saved-token');
			expect(auth.isUnavailable).toBe(true);
			expect(auth.error).toBe('Network error. Please check your connection.');
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBe('saved-token');
		});

		it('recovers when auth status becomes reachable during retries', async () => {
			vi.useFakeTimers();
			vi.mocked(getAuthStatus)
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockResolvedValueOnce({
					needsSetup: false,
					isAuthenticated: false,
					authDisabled: false,
				});
			const auth = new AuthStore();

			const check = auth.checkAuthStatus();
			await vi.runAllTimersAsync();
			await check;

			expect(getAuthStatus).toHaveBeenCalledTimes(2);
			expect(auth.isUnavailable).toBe(false);
			expect(auth.error).toBeNull();
		});

		it('recovers from transient user validation without clearing the token', async () => {
			vi.useFakeTimers();
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'saved-token');
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false,
				isAuthenticated: true,
				authDisabled: false,
			});
			vi.mocked(getUser)
				.mockRejectedValueOnce(new TypeError('Failed to fetch'))
				.mockResolvedValueOnce({ user: { id: '1', username: 'admin' } });
			const auth = new AuthStore();

			const check = auth.checkAuthStatus();
			await vi.runAllTimersAsync();
			await check;

			expect(getUser).toHaveBeenCalledTimes(2);
			expect(auth.token).toBe('saved-token');
			expect(auth.user).toEqual({ id: '1', username: 'admin' });
			expect(auth.isUnavailable).toBe(false);
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBe('saved-token');
		});

		it('keeps the token when user validation exhausts its retries', async () => {
			vi.useFakeTimers();
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'saved-token');
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false,
				isAuthenticated: true,
				authDisabled: false,
			});
			vi.mocked(getUser).mockRejectedValue(new TypeError('Failed to fetch'));
			const auth = new AuthStore();

			const check = auth.checkAuthStatus();
			await vi.runAllTimersAsync();
			await check;

			expect(getUser).toHaveBeenCalledTimes(5);
			expect(auth.token).toBe('saved-token');
			expect(auth.user).toBeNull();
			expect(auth.isUnavailable).toBe(true);
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBe('saved-token');
		});

		it('does not let a stale status response overwrite successful registration', async () => {
			let resolveStatus!: (status: {
				needsSetup: boolean;
				isAuthenticated: boolean;
				authDisabled: boolean;
			}) => void;
			vi.mocked(getAuthStatus).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveStatus = resolve;
					}),
			);
			vi.mocked(apiRegister).mockResolvedValue({
				success: true,
				token: 'reg-token',
				user: { id: '2', username: 'newuser' },
			});
			const auth = new AuthStore();
			const check = auth.checkAuthStatus();

			await auth.register('newuser', 'password');
			resolveStatus({ needsSetup: true, isAuthenticated: false, authDisabled: false });
			await check;

			expect(auth.needsSetup).toBe(false);
			expect(auth.token).toBe('reg-token');
			expect(auth.user).toEqual({ id: '2', username: 'newuser' });
			expect(auth.isUnavailable).toBe(false);
		});

		it('does not let stale status retries mark a successful login unavailable', async () => {
			vi.useFakeTimers();
			vi.mocked(getAuthStatus).mockRejectedValue(new TypeError('Failed to fetch'));
			vi.mocked(apiLogin).mockResolvedValue({
				success: true,
				token: 'new-token',
				user: { id: '1', username: 'admin' },
			});
			const auth = new AuthStore();
			const check = auth.checkAuthStatus();

			await auth.login('admin', 'password');
			expect(auth.isLoading).toBe(false);
			await vi.runAllTimersAsync();
			await check;

			expect(auth.token).toBe('new-token');
			expect(auth.user).toEqual({ id: '1', username: 'admin' });
			expect(auth.isUnavailable).toBe(false);
			expect(auth.error).toBeNull();
		});

		it('enters app mode without token when auth is disabled by server config', async () => {
			localStorage.setItem(LOCAL_STORAGE_KEYS.authToken, 'stale-token');
			vi.mocked(getAuthStatus).mockResolvedValue({
				needsSetup: false,
				isAuthenticated: true,
				authDisabled: true,
			});
			const auth = new AuthStore();
			await auth.checkAuthStatus();
			expect(auth.authDisabled).toBe(true);
			expect(auth.isAuthenticated).toBe(true);
			expect(auth.user).toEqual({ id: 'local', username: 'local' });
			expect(auth.token).toBeNull();
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBeNull();
		});
	});

	describe('login', () => {
		it.each([
			[new ApiError(401, 'Rejected'), 'Invalid credentials. Please try again.'],
			[new ApiError(403, 'Rejected'), 'Access denied. You do not have permission.'],
			[new ApiError(409, 'Already registered'), 'Already registered'],
			[new ApiError(400, 'Invalid input'), 'Invalid input'],
			[new ApiError(503, 'Unavailable'), 'Server error. Please try again later.'],
			[null, 'Network error. Please check your connection.'],
		])('maps %s without retrying a login mutation', async (error, message) => {
			vi.mocked(apiLogin).mockRejectedValue(error);
			const auth = new AuthStore();
			expect(await auth.login('admin', 'pass')).toEqual({ success: false, error: message });
			expect(auth.error).toBe(message);
			expect(apiLogin).toHaveBeenCalledTimes(1);
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBeNull();
		});

		it('persists token on success', async () => {
			vi.mocked(apiLogin).mockResolvedValue({
				success: true,
				token: 'new-token',
				user: { id: '1', username: 'admin' },
			});
			const auth = new AuthStore();
			const result = await auth.login('admin', 'pass');
			expect(result.success).toBe(true);
			expect(auth.token).toBe('new-token');
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBe('new-token');
		});

		it('returns error on failure', async () => {
			vi.mocked(apiLogin).mockRejectedValue(new Error('bad creds'));
			const auth = new AuthStore();
			const result = await auth.login('admin', 'wrong');
			expect(result.success).toBe(false);
			expect(auth.error).toBeTruthy();
		});

		it('maps transport failures to a useful network error', async () => {
			vi.mocked(apiLogin).mockRejectedValue(new TypeError('Failed to fetch'));
			const auth = new AuthStore();
			const result = await auth.login('admin', 'pass');
			expect(result).toEqual({
				success: false,
				error: 'Network error. Please check your connection.',
			});
		});
	});

	describe('register', () => {
		it('persists token and clears needsSetup on success', async () => {
			vi.mocked(apiRegister).mockResolvedValue({
				success: true,
				token: 'reg-token',
				user: { id: '2', username: 'newuser' },
			});
			const auth = new AuthStore();
			auth.needsSetup = true;
			auth.isUnavailable = true;
			const result = await auth.register('newuser', 'pass');
			expect(result.success).toBe(true);
			expect(auth.needsSetup).toBe(false);
			expect(auth.isUnavailable).toBe(false);
			expect(auth.token).toBe('reg-token');
			expect(localStorage.getItem(LOCAL_STORAGE_KEYS.authToken)).toBe('reg-token');
		});
	});
});
