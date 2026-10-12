import { parseAuthTokenIdentity, type AuthTokenIdentity } from '$shared/auth';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import {
	isBrowserDataCurrent,
	canPersistBrowserData,
	browserDocumentEpoch,
	readBrowserLogoutEpoch,
} from '$lib/utils/browser-data-lifetime';

export const CREDENTIAL_PENDING_KEY = 'garcon.credential-update-pending';
export const CREDENTIAL_PENDING_MS = 35_000;
let initialized = false;
let token: string | null = null;
let dispatchAvailable = true;
type Rejection = {
	token: string | null;
	code: 'AUTH_SESSION_INVALID' | 'AUTH_STORAGE_UNAVAILABLE';
};
const listeners = new Set<(event: Rejection) => void>();

export function readStoredAuthToken(): string | null {
	try {
		const stored = JSON.parse(
			globalThis.localStorage?.getItem(LOCAL_STORAGE_KEYS.authToken) ?? 'null',
		);
		return stored?.epoch === readBrowserLogoutEpoch() && typeof stored.token === 'string'
			? stored.token
			: null;
	} catch {
		return null;
	}
}

export function getAuthToken(): string | null {
	if (!initialized) {
		initialized = true;
		token = readStoredAuthToken();
	}
	return token;
}

export function retainAuthToken(value: string): void {
	if (!isBrowserDataCurrent()) return;
	initialized = true;
	token = value;
}

export function setAuthToken(value: string): boolean {
	if (!canPersistBrowserData()) return false;
	const epoch = browserDocumentEpoch();
	retainAuthToken(value);
	try {
		globalThis.localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: value, epoch }),
		);
		return isBrowserDataCurrent();
	} catch {
		return false;
	}
}

export function clearMemoryAuthToken(): void {
	initialized = true;
	token = null;
}

export function clearAuthToken(): void {
	const previous = getAuthToken();
	clearMemoryAuthToken();
	try {
		if (readStoredAuthToken() === previous)
			globalThis.localStorage.removeItem(LOCAL_STORAGE_KEYS.authToken);
	} catch {
		/* Memory remains authoritative when storage is unavailable. */
	}
}

export function discardStoredAuthToken(rejected: string): void {
	try {
		if (readStoredAuthToken() === rejected)
			globalThis.localStorage.removeItem(LOCAL_STORAGE_KEYS.authToken);
	} catch {
		/* A rejected stored candidate never replaces memory authority. */
	}
}

export function setAuthDispatchAvailable(available: boolean): void {
	dispatchAvailable = available;
}
export function canDispatchAuthenticated(): boolean {
	return dispatchAvailable && isBrowserDataCurrent();
}
export function onAuthRejection(listener: (event: Rejection) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export function notifyAuthRejection(capturedToken: string | null, code: string | undefined): void {
	if (code !== 'AUTH_SESSION_INVALID' && code !== 'AUTH_STORAGE_UNAVAILABLE') return;
	for (const listener of listeners) listener({ token: capturedToken, code });
}

// Claims order already validated sessions; they never grant request authority.
export function authTokenIdentity(value: string | null): AuthTokenIdentity | null {
	try {
		const encoded = value?.split('.')[1];
		if (!encoded) return null;
		const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
			c.charCodeAt(0),
		);
		return parseAuthTokenIdentity(
			JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
		);
	} catch {
		return null;
	}
}

export function isOlderAuthToken(candidate: string, accepted: string | null): boolean {
	const next = authTokenIdentity(candidate);
	const current = authTokenIdentity(accepted);
	return (
		!!next &&
		!!current &&
		next.ownerKey === current.ownerKey &&
		next.credentialRevision < current.credentialRevision
	);
}

export function publishCredentialPending(value: string): void {
	if (!isBrowserDataCurrent()) return;
	const identity = authTokenIdentity(value);
	if (!identity) return;
	try {
		globalThis.localStorage.setItem(
			CREDENTIAL_PENDING_KEY,
			JSON.stringify({ ...identity, deadline: Date.now() + CREDENTIAL_PENDING_MS }),
		);
	} catch {
		/* Sibling coordination is best effort; no secrets are stored in this notice. */
	}
}

export function credentialPendingDeadline(value: string | null): number | null {
	const identity = authTokenIdentity(value);
	if (!identity) return null;
	try {
		const raw = JSON.parse(globalThis.localStorage.getItem(CREDENTIAL_PENDING_KEY) ?? 'null');
		if (
			raw?.ownerKey !== identity.ownerKey ||
			raw?.credentialRevision !== identity.credentialRevision ||
			!Number.isFinite(raw.deadline) ||
			raw.deadline <= Date.now()
		)
			return null;
		return Math.min(raw.deadline, Date.now() + CREDENTIAL_PENDING_MS);
	} catch {
		return null;
	}
}
