import {
	getAuthStatus,
	login as apiLogin,
	register as apiRegister,
	getUser,
	changeUsername as apiChangeUsername,
	changePassword as apiChangePassword,
} from '$lib/api/auth.js';
import { ApiError, isIntermediaryResponse } from '$lib/api/client.js';
import {
	getAuthToken,
	retainAuthToken,
	setAuthToken,
	clearAuthToken,
	setAuthDispatchAvailable,
	onAuthRejection,
	readStoredAuthToken,
	discardStoredAuthToken,
	isOlderAuthToken,
	authTokenIdentity,
	publishCredentialPending,
	credentialPendingDeadline,
	CREDENTIAL_PENDING_MS,
} from '$lib/auth/session';
import type {
	AuthUser,
	AuthSessionResponse,
	ChangeUsernameRequest,
	ChangePasswordRequest,
} from '$shared/auth';
import * as m from '$lib/paraglide/messages.js';

export type AuthAvailability =
	| 'initializing'
	| 'active'
	| 'repairing'
	| 'reauth-required'
	| 'storage-unavailable'
	| 'signed-out';
export type PresentationOwner = { readonly mode: 'authenticated' | 'local'; readonly key: string };
export interface AuthResult {
	success: boolean;
	error?: string;
	errorCode?: string;
}

function describeAuthError(error: unknown): string {
	if (!(error instanceof ApiError)) return m.auth_errors_network();
	if (error.errorCode === 'AUTH_STORAGE_UNAVAILABLE') return m.auth_storage_unavailable();
	if (error.status === 401) return m.auth_errors_invalid_credentials();
	return error.message;
}

export class AuthStore {
	#version = 0;
	#rejectionVersion = 0;
	#uncertainToken: string | null = null;
	#rejectedStoredToken: string | null = null;
	#statusCheck: Promise<void> | null = null;
	#statusKnown = false;
	#probe: Promise<void> | null = null;
	#probeAgain = false;
	#repairTimer: ReturnType<typeof setTimeout> | null = null;
	#pendingToken: string | null = null;
	#pendingDeadline = 0;
	#dispose: (() => void) | null = null;
	#destroyed = false;
	token = $state<string | null>(getAuthToken());
	user = $state<AuthUser | null>(null);
	presentationOwner = $state<PresentationOwner | null>(null);
	availability = $state<AuthAvailability>('initializing');
	needsSetup = $state(false);
	authDisabled = $state(false);
	error = $state<string | null>(null);
	persistenceWarning = $state(false);
	credentialPending = $state(false);
	isLoading = $derived(this.availability === 'initializing');
	isUnavailable = $derived(
		this.availability === 'storage-unavailable' ||
			(this.availability === 'repairing' && !this.presentationOwner),
	);
	isAuthenticated = $derived(
		this.availability === 'active' && (this.authDisabled || (!!this.token && !!this.user)),
	);

	start(): void {
		if (this.#dispose || typeof window === 'undefined') return;
		const release = onAuthRejection(({ token, code }) => this.sessionRejected(token, code));
		const reconcile = () => {
			void this.reconcile();
		};
		const visible = () => {
			if (document.visibilityState === 'visible') reconcile();
		};
		window.addEventListener('storage', reconcile);
		window.addEventListener('online', reconcile);
		window.addEventListener('pageshow', reconcile);
		document.addEventListener('visibilitychange', visible);
		this.#dispose = () => {
			release();
			window.removeEventListener('storage', reconcile);
			window.removeEventListener('online', reconcile);
			window.removeEventListener('pageshow', reconcile);
			document.removeEventListener('visibilitychange', visible);
		};
	}

	#setAvailability(value: AuthAvailability): void {
		this.availability = value;
		setAuthDispatchAvailable(value === 'active');
	}

	#accept(data: AuthSessionResponse): boolean {
		if (isOlderAuthToken(data.token, this.token)) return false;
		const stored = readStoredAuthToken();
		const newerStoredCandidate =
			stored !== this.#rejectedStoredToken && isOlderAuthToken(data.token, stored);
		const identity = authTokenIdentity(data.token);
		if (!identity || identity.ownerKey !== data.user.id)
			throw new Error('Invalid session identity.');
		const ownerChanged =
			this.presentationOwner &&
			(this.presentationOwner.mode !== 'authenticated' ||
				this.presentationOwner.key !== data.user.id);
		if (this.#repairTimer) clearTimeout(this.#repairTimer);
		this.#repairTimer = null;
		this.token = data.token;
		this.#uncertainToken = null;
		this.user = data.user;
		this.presentationOwner = { mode: 'authenticated', key: data.user.id };
		this.needsSetup = false;
		this.error = null;
		if (newerStoredCandidate) {
			// Retains the verified response without overwriting an unverified sibling candidate.
			retainAuthToken(data.token);
			this.#setAvailability('repairing');
			this.#scheduleRepair(2_000);
		} else {
			this.persistenceWarning = !setAuthToken(data.token);
			this.#setAvailability('active');
		}
		if (ownerChanged) window.location.reload();
		return true;
	}

	async checkAuthStatus(): Promise<void> {
		if (this.presentationOwner) return this.reconcile();
		if (this.#statusCheck) return this.#statusCheck;
		this.#statusCheck = this.#checkStatus().finally(() => {
			this.#statusCheck = null;
		});
		return this.#statusCheck;
	}

	async #checkStatus(): Promise<void> {
		const version = this.#version;
		const rejectionVersion = this.#rejectionVersion;
		this.#setAvailability('initializing');
		try {
			const status = await getAuthStatus();
			if (version !== this.#version || this.#destroyed) return;
			this.authDisabled = status.authDisabled;
			this.#statusKnown = true;
			this.needsSetup = status.needsSetup;
			if (status.authDisabled) {
				this.token = null;
				this.user = { id: 'local', username: 'local' };
				this.presentationOwner = { mode: 'local', key: 'local' };
				clearAuthToken();
				this.#setAvailability('active');
			} else if (!status.needsSetup && this.token) {
				const token = this.token;
				const data = await getUser(token);
				if (
					version === this.#version &&
					rejectionVersion === this.#rejectionVersion &&
					!this.#destroyed
				)
					this.#accept({ success: true, token, user: data.user });
			} else this.#setAvailability('signed-out');
		} catch (error) {
			if (version !== this.#version || this.#destroyed) return;
			this.#probeFailed(error);
		}
	}

	login(username: string, password: string): Promise<AuthResult> {
		return this.#openSession(() => apiLogin(username, password));
	}
	register(username: string, password: string): Promise<AuthResult> {
		return this.#openSession(() => apiRegister(username, password));
	}
	async #openSession(request: () => Promise<AuthSessionResponse>): Promise<AuthResult> {
		if (this.authDisabled) return { success: false, error: m.auth_errors_auth_disabled() };
		const version = ++this.#version;
		let rejectionVersion = this.#rejectionVersion;
		try {
			let data = await request();
			if (version !== this.#version || this.#destroyed) return { success: false };
			if (rejectionVersion !== this.#rejectionVersion) {
				rejectionVersion = this.#rejectionVersion;
				const verified = await getUser(data.token);
				if (
					version !== this.#version ||
					rejectionVersion !== this.#rejectionVersion ||
					this.#destroyed
				)
					return { success: false };
				data = { ...data, user: verified.user };
			}
			return { success: this.#accept(data) };
		} catch (error) {
			if (version !== this.#version || this.#destroyed) return { success: false };
			if (error instanceof ApiError && error.errorCode === 'AUTH_STORAGE_UNAVAILABLE') {
				this.#version++;
				this.#setAvailability('storage-unavailable');
			}
			this.error = describeAuthError(error);
			return { success: false, error: this.error };
		}
	}

	changeUsername(input: ChangeUsernameRequest): Promise<AuthResult> {
		return this.#changeCredentials((token) => apiChangeUsername(input, token));
	}
	changePassword(input: ChangePasswordRequest): Promise<AuthResult> {
		return this.#changeCredentials((token) => apiChangePassword(input, token));
	}
	async #changeCredentials(
		request: (token: string) => Promise<AuthSessionResponse>,
	): Promise<AuthResult> {
		const token = this.token;
		if (this.credentialPending || !this.isAuthenticated || this.authDisabled || !token)
			return { success: false };
		const version = ++this.#version;
		this.credentialPending = true;
		this.#pendingToken = token;
		this.#pendingDeadline = Date.now() + CREDENTIAL_PENDING_MS;
		publishCredentialPending(token);
		try {
			const data = await request(token);
			const before = authTokenIdentity(token);
			const after = authTokenIdentity(data.token);
			if (
				!before ||
				!after ||
				after.ownerKey !== before.ownerKey ||
				after.credentialRevision !== before.credentialRevision + 1
			)
				throw new Error('Invalid replacement session.');
			if (this.#destroyed) return { success: false };
			if (version !== this.#version) {
				const current = authTokenIdentity(this.token);
				return {
					success:
						this.isAuthenticated &&
						current?.ownerKey === after.ownerKey &&
						current.credentialRevision >= after.credentialRevision,
				};
			}
			return { success: this.#accept(data) };
		} catch (error) {
			if (this.#destroyed) return { success: false };
			const code = error instanceof ApiError ? error.errorCode : undefined;
			if (version === this.#version) {
				if (code === 'AUTH_STORAGE_UNAVAILABLE' || code === 'AUTH_SESSION_INVALID')
					this.sessionRejected(token, code);
				else if (!(error instanceof ApiError) || isIntermediaryResponse(error)) {
					this.error = m.auth_change_unknown();
					this.#uncertainToken = token;
					this.#version++;
					this.#pendingDeadline = 0;
					if (this.#repairTimer) clearTimeout(this.#repairTimer);
					this.#repairTimer = null;
					this.#setAvailability('reauth-required');
					void this.reconcileReplacement();
					return { success: false, error: this.error, errorCode: 'AUTH_OUTCOME_UNKNOWN' };
				}
			}
			return { success: false, error: describeAuthError(error), errorCode: code };
		} finally {
			this.credentialPending = false;
		}
	}

	sessionRejected(
		token: string | null,
		code: 'AUTH_SESSION_INVALID' | 'AUTH_STORAGE_UNAVAILABLE',
	): void {
		if (token !== this.token || this.#destroyed || this.authDisabled) return;
		if (this.availability === 'storage-unavailable') return;
		this.#rejectionVersion++;
		if (code === 'AUTH_STORAGE_UNAVAILABLE') {
			this.#version++;
			this.error = m.auth_storage_unavailable();
			this.#setAvailability('storage-unavailable');
			return;
		}
		this.#setAvailability(token === this.#uncertainToken ? 'reauth-required' : 'repairing');
		void this.reconcile();
	}

	async reconcileReplacement(): Promise<void> {
		const stored = readStoredAuthToken();
		if (stored && stored !== this.token && !isOlderAuthToken(stored, this.token))
			await this.reconcile();
	}

	reconcile(): Promise<void> {
		if (this.#destroyed || this.authDisabled || this.availability === 'storage-unavailable')
			return Promise.resolve();
		if (this.#probe) {
			this.#probeAgain = true;
			return this.#probe;
		}
		this.#probe = this.#reconcile().finally(() => {
			this.#probe = null;
			if (this.#probeAgain) {
				this.#probeAgain = false;
				void this.reconcile();
			}
		});
		return this.#probe;
	}
	async #reconcile(): Promise<void> {
		if (!this.#statusKnown && !this.presentationOwner) return this.checkAuthStatus();
		const version = this.#version;
		const stored = readStoredAuthToken();
		const rejectionVersion = this.#rejectionVersion;
		const candidate =
			stored && stored !== this.#rejectedStoredToken && !isOlderAuthToken(stored, this.token)
				? stored
				: this.token;
		if (candidate && candidate === this.#uncertainToken) return;
		if (!candidate) {
			if (!this.presentationOwner) await this.checkAuthStatus();
			else this.#setAvailability('reauth-required');
			return;
		}
		try {
			const data = await getUser(candidate);
			if (
				version !== this.#version ||
				rejectionVersion !== this.#rejectionVersion ||
				this.#destroyed
			)
				return;
			if (candidate !== this.token) this.#version++;
			this.#accept({ success: true, user: data.user, token: candidate });
		} catch (error) {
			if (version !== this.#version || this.#destroyed) return;
			let failure = error;
			if (error instanceof ApiError && error.errorCode === 'AUTH_SESSION_INVALID') {
				this.#rejectedStoredToken = candidate;
				discardStoredAuthToken(candidate);
			}
			if (candidate !== this.token && this.token && this.token !== this.#uncertainToken) {
				// Untrusted storage must not revoke an independently accepted memory session.
				try {
					const current = this.token;
					const data = await getUser(current);
					if (
						version === this.#version &&
						rejectionVersion === this.#rejectionVersion &&
						!this.#destroyed
					)
						this.#accept({ success: true, user: data.user, token: current });
					return;
				} catch (currentError) {
					failure = currentError;
				}
			}
			if (version === this.#version && !this.#destroyed) this.#probeFailed(failure);
		}
	}

	#probeFailed(error: unknown): void {
		if (error instanceof ApiError && error.errorCode === 'AUTH_STORAGE_UNAVAILABLE') {
			this.#version++;
			this.error = m.auth_storage_unavailable();
			this.#setAvailability('storage-unavailable');
			return;
		}
		if (error instanceof ApiError && error.errorCode === 'AUTH_SESSION_INVALID') {
			this.#rejectionVersion++;
			if (this.#pendingToken !== this.token) {
				this.#pendingToken = this.token;
				this.#pendingDeadline = credentialPendingDeadline(this.token) ?? 0;
			}
			if (this.#pendingDeadline > Date.now()) {
				this.#setAvailability('repairing');
				this.#scheduleRepair(Math.min(500, this.#pendingDeadline - Date.now()));
			} else {
				if (this.presentationOwner) this.#setAvailability('reauth-required');
				else {
					if (this.token) {
						this.#rejectedStoredToken = this.token;
						discardStoredAuthToken(this.token);
					}
					clearAuthToken();
					this.token = null;
					this.#setAvailability('signed-out');
					const stored = readStoredAuthToken();
					if (stored && stored !== this.#rejectedStoredToken) {
						this.#setAvailability('repairing');
						void this.reconcile();
					}
				}
			}
			return;
		}
		this.error = describeAuthError(error);
		this.#setAvailability(this.#uncertainToken ? 'reauth-required' : 'repairing');
		this.#scheduleRepair(2_000);
	}
	#scheduleRepair(delay: number): void {
		if (this.#repairTimer) clearTimeout(this.#repairTimer);
		this.#repairTimer = setTimeout(() => {
			this.#repairTimer = null;
			void this.reconcile();
		}, delay);
	}
	destroy(): void {
		this.#destroyed = true;
		this.#version++;
		this.#dispose?.();
		if (this.#repairTimer) clearTimeout(this.#repairTimer);
	}
}

export function createAuthStore(): AuthStore {
	return new AuthStore();
}
