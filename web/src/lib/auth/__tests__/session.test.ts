import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiGet } from '$lib/api/client';
import {
	authTokenIdentity,
	clearAuthToken,
	credentialPendingDeadline,
	getAuthToken,
	onAuthRejection,
	publishCredentialPending,
	setAuthDispatchAvailable,
	setAuthToken,
} from '../session';

beforeEach(() => {
	clearAuthToken();
	localStorage.clear();
	setAuthDispatchAvailable(true);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('decodes Unicode identity only as ordering metadata', () => {
	const bytes = new TextEncoder().encode(
		JSON.stringify({ sub: 'owner-\u03bb', credentialRevision: 7 }),
	);
	const token = `header.${btoa(String.fromCharCode(...bytes))}.signature`;
	expect(authTokenIdentity(token)).toEqual({ ownerKey: 'owner-\u03bb', credentialRevision: 7 });
	publishCredentialPending(token);
	expect(credentialPendingDeadline(token)).toBeGreaterThan(Date.now());
	expect(credentialPendingDeadline('header.invalid.signature')).toBeNull();
});

it('never erases a newer sibling token when clearing its captured memory token', () => {
	setAuthToken('before');
	localStorage.setItem('bearer-token', 'after');
	clearAuthToken();
	expect(localStorage.getItem('bearer-token')).toBe('after');
	expect(getAuthToken()).toBeNull();
});

it('reports the token that sent an old request, not a subsequently installed replacement', async () => {
	setAuthToken('before');
	const response = Promise.withResolvers<Response>();
	vi.stubGlobal(
		'fetch',
		vi.fn(() => response.promise),
	);
	const rejected = vi.fn();
	const unsubscribe = onAuthRejection(rejected);
	try {
		const request = apiGet('/protected');
		setAuthToken('after');
		response.resolve(
			Response.json(
				{ success: false, error: 'Revoked', errorCode: 'AUTH_SESSION_INVALID', retryable: false },
				{ status: 401 },
			),
		);
		await expect(request).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_INVALID' });
		expect(rejected).toHaveBeenCalledExactlyOnceWith({
			token: 'before',
			code: 'AUTH_SESSION_INVALID',
		});
		expect(getAuthToken()).toBe('after');
	} finally {
		unsubscribe();
		vi.unstubAllGlobals();
	}
});

it('does not turn a provider 401 into session rejection and blocks dispatch while suspended', async () => {
	const fetch = vi.fn(async () =>
		Response.json({ error: 'Provider rejected', errorCode: 'PROVIDER_ERROR' }, { status: 401 }),
	);
	vi.stubGlobal('fetch', fetch);
	const rejected = vi.fn();
	const unsubscribe = onAuthRejection(rejected);
	try {
		await expect(apiGet('/provider')).rejects.toMatchObject({ status: 401 });
		expect(rejected).not.toHaveBeenCalled();
		setAuthDispatchAvailable(false);
		await expect(apiGet('/protected')).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_INVALID' });
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		unsubscribe();
		vi.unstubAllGlobals();
	}
});
