// Reactive auth store using Svelte 5 runes. Manages token persistence,
// login/register flows, and initial auth status checking.

import {
	getAuthStatus,
	login as apiLogin,
	register as apiRegister,
	getUser,
	logout as apiLogout,
	type AuthUser,
} from '$lib/api/auth.js';
import { getAuthToken, setAuthToken, clearAuthToken, ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';

const AUTH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

function isAuthoritativeAuthRejection(err: unknown): boolean {
	return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

function isRetryableAuthError(err: unknown): boolean {
	if (!(err instanceof ApiError)) return true;
	const apiError = err as ApiError;
	return apiError.retryable || apiError.status === 429 || apiError.status >= 500;
}

async function retryAuthRequest<T>(request: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			return await request();
		} catch (err) {
			lastError = err;
			if (!isRetryableAuthError(err) || attempt === AUTH_RETRY_DELAYS_MS.length) throw err;
			await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_DELAYS_MS[attempt]));
		}
	}
	throw lastError;
}

/** Maps API errors to user-facing messages based on HTTP status. */
function describeAuthError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 401) return m.auth_errors_invalid_credentials();
		if (err.status === 403) return m.auth_errors_access_denied();
		if (err.status === 409) return err.message;
		if (err.status >= 500) return m.auth_errors_server();
		return err.message;
	}
	if (err instanceof Error) return m.auth_errors_network();
	return m.auth_errors_network();
}

export interface AuthResult {
	success: boolean;
	error?: string;
}

export class AuthStore {
	private statusCheck: Promise<void> | null = null;
	token = $state<string | null>(null);
	user = $state<AuthUser | null>(null);
	isLoading = $state(true);
	needsSetup = $state(false);
	authDisabled = $state(false);
	isUnavailable = $state(false);
	error = $state<string | null>(null);
	isAuthenticated = $derived(this.authDisabled || (!!this.token && !!this.user));

	constructor() {
		this.token = getAuthToken();
	}

	/** Queries the server for auth status and validates any stored token. */
	async checkAuthStatus(): Promise<void> {
		if (this.statusCheck) return this.statusCheck;
		const check = this.performAuthStatusCheck();
		this.statusCheck = check;
		try {
			await check;
		} finally {
			if (this.statusCheck === check) this.statusCheck = null;
		}
	}

	private async performAuthStatusCheck(): Promise<void> {
		try {
			this.isLoading = true;
			this.isUnavailable = false;
			this.error = null;

			const status = await retryAuthRequest(getAuthStatus);
			this.authDisabled = Boolean(status.authDisabled);

			if (this.authDisabled) {
				this.needsSetup = false;
				this.token = null;
				this.user = { id: 'local', username: 'local' };
				clearAuthToken();
				this.isLoading = false;
				return;
			}

			if (status.needsSetup) {
				this.needsSetup = true;
				this.user = null;
				this.isLoading = false;
				return;
			}

			this.needsSetup = false;

			if (this.token) {
				try {
					const data = await retryAuthRequest(getUser);
					this.user = data.user;
				} catch (err) {
					if (!isAuthoritativeAuthRejection(err)) throw err;
					// The server authoritatively rejected the token.
					clearAuthToken();
					this.token = null;
					this.user = null;
				}
			} else {
				this.user = null;
			}
		} catch (err) {
			console.error('[AuthStore] Auth status check failed:', err);
			this.isUnavailable = true;
			this.error = describeAuthError(err);
		} finally {
			this.isLoading = false;
		}
	}

	/** Authenticates with username/password, persisting the token on success. */
	async login(username: string, password: string): Promise<AuthResult> {
		try {
			this.error = null;
			if (this.authDisabled) {
				return {
					success: false,
					error: m.auth_errors_auth_disabled(),
				};
			}
			const data = await apiLogin(username, password);
			this.token = data.token;
			this.user = data.user;
			this.isUnavailable = false;
			setAuthToken(data.token);
			return { success: true };
		} catch (err: unknown) {
			const message = describeAuthError(err);
			this.error = message;
			return { success: false, error: message };
		}
	}

	/** Registers the first user account, persisting the token on success. */
	async register(username: string, password: string): Promise<AuthResult> {
		try {
			this.error = null;
			if (this.authDisabled) {
				return {
					success: false,
					error: m.auth_errors_auth_disabled(),
				};
			}
			const data = await apiRegister(username, password);
			this.token = data.token;
			this.user = data.user;
			this.needsSetup = false;
			this.isUnavailable = false;
			setAuthToken(data.token);
			return { success: true };
		} catch (err: unknown) {
			const message = describeAuthError(err);
			this.error = message;
			return { success: false, error: message };
		}
	}

	/** Clears local auth state and notifies the server. */
	logout(): void {
		const hadToken = !!this.token;
		if (this.authDisabled) return;
		this.token = null;
		this.user = null;
		clearAuthToken();

		if (hadToken) {
			apiLogout().catch((err: unknown) => {
				console.error('Logout endpoint error:', err);
			});
		}
	}
}

export function createAuthStore(): AuthStore {
	return new AuthStore();
}
