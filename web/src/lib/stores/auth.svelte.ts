// Reactive auth store using Svelte 5 runes. Manages token persistence,
// login/register flows, and initial auth status checking.

import {
	getAuthStatus,
	login as apiLogin,
	register as apiRegister,
	getUser,
	logout as apiLogout,
	type AuthUser
} from '$lib/api/auth.js';
import { getAuthToken, setAuthToken, clearAuthToken, ApiError } from '$lib/api/client.js';

/** Maps API errors to user-facing messages based on HTTP status. */
function describeAuthError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 401) return 'Invalid credentials. Please try again.';
		if (err.status === 403) return 'Access denied. You do not have permission.';
		if (err.status >= 500) return 'Server error. Please try again later.';
		return err.message;
	}
	if (err instanceof Error) return err.message;
	return 'Network error. Please check your connection.';
}

export interface AuthResult {
	success: boolean;
	error?: string;
}

export class AuthStore {
	token = $state<string | null>(null);
	user = $state<AuthUser | null>(null);
	isLoading = $state(true);
	needsSetup = $state(false);
	authDisabled = $state(false);
	error = $state<string | null>(null);
	isAuthenticated = $derived(this.authDisabled || (!!this.token && !!this.user));

	constructor() {
		this.token = getAuthToken();
	}

	/** Queries the server for auth status and validates any stored token. */
	async checkAuthStatus(): Promise<void> {
		try {
			this.isLoading = true;
			this.error = null;

			const status = await getAuthStatus();
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
					const data = await getUser();
					this.user = data.user;
				} catch {
					// Token is invalid or expired
					clearAuthToken();
					this.token = null;
					this.user = null;
				}
			} else {
				this.user = null;
			}
		} catch (err) {
			console.error('[AuthStore] Auth status check failed:', err);
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
					error: 'Authentication is disabled by server configuration.'
				};
			}
			const data = await apiLogin(username, password);
			this.token = data.token;
			this.user = data.user;
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
					error: 'Authentication is disabled by server configuration.'
				};
			}
			const data = await apiRegister(username, password);
			this.token = data.token;
			this.user = data.user;
			this.needsSetup = false;
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
