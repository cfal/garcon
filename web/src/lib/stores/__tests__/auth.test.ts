import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../auth.svelte';
import { ApiError, apiGet } from '$lib/api/client';
import {
	clearAuthToken,
	setAuthToken,
	getAuthToken,
	readStoredAuthToken,
	canDispatchAuthenticated,
	setAuthDispatchAvailable,
	publishCredentialPending,
} from '$lib/auth/session';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import type { AuthSessionResponse } from '$shared/auth';

vi.mock('$lib/api/auth.js', () => ({
	getAuthStatus: vi.fn(),
	login: vi.fn(),
	register: vi.fn(),
	getUser: vi.fn(),
	changeUsername: vi.fn(),
	changePassword: vi.fn(),
	logout: vi.fn(),
}));
vi.mock('$lib/utils/browser-data-lifetime', () => ({
	captureBrowserDataLifetime: vi.fn(),
	isBrowserDataCurrent: vi.fn(() => true),
	canPersistBrowserData: vi.fn(() => true),
	browserDocumentEpoch: () => null,
	waitForBrowserLogoutCleanup: vi.fn(() => null),
	publishBrowserLogout: vi.fn(),
	retireBrowserData: vi.fn(),
	readBrowserLogoutEpoch: () => localStorage.getItem('garcon.logout-epoch'),
}));
vi.mock('$lib/auth/logout-cleanup', () => ({
	clearBrowserPrivateData: vi.fn(async () => true),
	clearTabPrivateData: vi.fn(() => true),
	reconcileTabPrivateData: vi.fn(() => true),
}));
import * as api from '$lib/api/auth.js';
import * as lifetime from '$lib/utils/browser-data-lifetime';
import * as cleanup from '$lib/auth/logout-cleanup';

const user = { id: 'owner-before', username: 'owner-before' };
function session(revision = 1, username = user.username): AuthSessionResponse {
	return {
		success: true,
		user: { ...user, username },
		token: `header.${btoa(JSON.stringify({ sub: user.id, credentialRevision: revision, sid: 'a'.repeat(64) }))}.signature`,
	};
}
const invalid = () => new ApiError(401, 'Invalid session', 'AUTH_SESSION_INVALID');
const stores: AuthStore[] = [];
function store() {
	const auth = new AuthStore();
	stores.push(auth);
	return auth;
}
async function signedIn() {
	setAuthToken(session().token);
	const auth = store();
	await auth.checkAuthStatus();
	return auth;
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	vi.mocked(lifetime.isBrowserDataCurrent).mockReturnValue(true);
	vi.mocked(lifetime.canPersistBrowserData).mockReturnValue(true);
	vi.mocked(lifetime.publishBrowserLogout).mockReturnValue({
		epoch: 'next',
		deadline: Date.now() + 10_000,
		coordinated: true,
	});
	vi.mocked(cleanup.clearBrowserPrivateData).mockResolvedValue(true);
	vi.mocked(cleanup.clearTabPrivateData).mockReturnValue(true);
	vi.mocked(cleanup.reconcileTabPrivateData).mockReturnValue(true);
	clearAuthToken();
	localStorage.clear();
	sessionStorage.clear();
	setAuthDispatchAvailable(true);
	vi.mocked(api.getAuthStatus).mockResolvedValue({
		needsSetup: false,
		authDisabled: false,
		isAuthenticated: false,
	});
	vi.mocked(api.getUser).mockResolvedValue({ user });
});

describe('deliberate logout', () => {
	async function ready() {
		const navigate = vi.fn();
		setAuthToken(session().token);
		const auth = new AuthStore(navigate);
		stores.push(auth);
		await auth.checkAuthStatus();
		return { auth, navigate };
	}

	it('abandons presentation immediately, revokes once, cleans data and fully navigates', async () => {
		const { auth, navigate } = await ready();
		const pending = Promise.withResolvers<void>();
		vi.mocked(api.logout).mockReturnValue(pending.promise);
		const logout = auth.logout();
		expect(auth.logout()).toBe(logout);
		expect(auth.presentationOwner).toBeNull();
		expect(auth.user).toBeNull();
		expect(auth.isAuthenticated).toBe(false);
		expect(canDispatchAuthenticated()).toBe(false);
		expect(getAuthToken()).toBeNull();
		expect(api.logout).toHaveBeenCalledExactlyOnceWith(session().token);
		expect(cleanup.clearBrowserPrivateData).toHaveBeenCalledTimes(1);
		pending.resolve();
		await logout;
		expect(navigate).toHaveBeenCalledExactlyOnceWith('/login?loggedOut=confirmed');
	});

	it('holds fresh sign-in admission until shared cleanup settles', async () => {
		const { auth } = await ready();
		const cleanup = Promise.withResolvers<void>();
		vi.mocked(lifetime.waitForBrowserLogoutCleanup).mockReturnValue(cleanup.promise);
		vi.mocked(api.login).mockResolvedValue(session(2));
		const login = auth.login('owner', 'password');
		expect(api.login).not.toHaveBeenCalled();
		cleanup.resolve();
		expect((await login).success).toBe(true);
		expect(api.login).toHaveBeenCalledTimes(1);
	});

	it.each(['login', 'probe', 'credentials'] as const)(
		'a late %s cannot restore a logged-out session',
		async (operation) => {
			const { auth } = await ready();
			const pending = Promise.withResolvers<AuthSessionResponse>();
			let request: Promise<unknown>;
			if (operation === 'login') {
				vi.mocked(api.login).mockReturnValue(pending.promise);
				request = auth.login('owner', 'password');
			} else if (operation === 'probe') {
				vi.mocked(api.getUser).mockReturnValue(pending.promise);
				request = auth.reconcile();
			} else {
				vi.mocked(api.changeUsername).mockReturnValue(pending.promise);
				request = auth.changeUsername({ username: 'next', currentPassword: 'password' });
			}
			// Another tab may log out while this tab is changing credentials.
			auth.start();
			vi.mocked(lifetime.isBrowserDataCurrent).mockReturnValue(false);
			window.dispatchEvent(new Event('storage'));
			pending.resolve(session(2));
			await request;
			expect(auth.logoutPending).toBe(true);
			expect(auth.token).toBeNull();
			expect(auth.presentationOwner).toBeNull();
			expect(getAuthToken()).toBeNull();
		},
	);

	it('reports unknown server revocation and incomplete cleanup instead of success', async () => {
		const { auth, navigate } = await ready();
		vi.mocked(api.logout).mockRejectedValue(new TypeError('offline'));
		vi.mocked(cleanup.clearBrowserPrivateData).mockResolvedValue(false);
		await auth.logout();
		expect(navigate).toHaveBeenCalledExactlyOnceWith(
			'/login?loggedOut=unconfirmed&cleanup=incomplete',
		);
		expect(auth.token).toBeNull();
	});

	it('a sleeping peer clears only its tab data and preserves a fresh stored login', async () => {
		const { auth, navigate } = await ready();
		auth.start();
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(2).token, epoch: null }),
		);
		vi.mocked(lifetime.isBrowserDataCurrent).mockReturnValue(false);
		window.dispatchEvent(new Event('pageshow'));
		expect(readStoredAuthToken()).toBe(session(2).token);
		expect(cleanup.reconcileTabPrivateData).toHaveBeenCalledTimes(2);
		expect(cleanup.clearTabPrivateData).not.toHaveBeenCalled();
		expect(cleanup.clearBrowserPrivateData).not.toHaveBeenCalled();
		expect(api.logout).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledExactlyOnceWith('/login?loggedOut=peer');
	});

	it('a BFCache-restored document preserves drafts already reconciled by a newer document', async () => {
		const { auth, navigate } = await ready();
		auth.start();
		const actualCleanup = await vi.importActual<typeof cleanup>('$lib/auth/logout-cleanup');
		vi.mocked(cleanup.clearTabPrivateData).mockImplementation(actualCleanup.clearTabPrivateData);
		vi.mocked(cleanup.reconcileTabPrivateData).mockImplementation(
			actualCleanup.reconcileTabPrivateData,
		);
		localStorage.setItem('garcon.logout-epoch', 'new-lifetime');
		sessionStorage.setItem('garcon.tab-logout-epoch', 'new-lifetime');
		sessionStorage.setItem('garcon-ticket-draft-v1:fresh', 'New ticket draft');
		sessionStorage.setItem('chat-canvas-recovery-v1:fresh', 'New canvas draft');
		vi.mocked(lifetime.isBrowserDataCurrent).mockReturnValue(false);

		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		expect(auth.logoutPending).toBe(true);
		expect(auth.token).toBeNull();
		expect(sessionStorage.getItem('garcon-ticket-draft-v1:fresh')).toBe('New ticket draft');
		expect(sessionStorage.getItem('chat-canvas-recovery-v1:fresh')).toBe('New canvas draft');
		expect(navigate).toHaveBeenCalledExactlyOnceWith('/login?loggedOut=peer');
	});

	it('an uncoordinated peer logout clears private tab data despite an unchanged epoch', async () => {
		const channel = {
			onmessage: null as ((event: MessageEvent) => void) | null,
			postMessage: vi.fn(),
			close: vi.fn(),
		} satisfies Pick<BroadcastChannel, 'onmessage' | 'postMessage' | 'close'>;
		vi.stubGlobal(
			'BroadcastChannel',
			class {
				constructor() {
					return channel;
				}
			},
		);
		const { auth, navigate } = await ready();
		auth.start();
		const actualCleanup = await vi.importActual<typeof cleanup>('$lib/auth/logout-cleanup');
		vi.mocked(cleanup.clearTabPrivateData).mockImplementation(actualCleanup.clearTabPrivateData);
		vi.mocked(cleanup.reconcileTabPrivateData).mockImplementation(
			actualCleanup.reconcileTabPrivateData,
		);
		sessionStorage.setItem('garcon-ticket-draft-v1:previous', 'Previous ticket draft');
		sessionStorage.setItem('chat-canvas-recovery-v1:previous', 'Previous canvas draft');
		sessionStorage.setItem('unrelated-app', 'keep');

		channel.onmessage?.(new MessageEvent('message', { data: { type: 'logout', epoch: null } }));

		expect(auth.logoutPending).toBe(true);
		expect(auth.token).toBeNull();
		expect(sessionStorage.getItem('garcon-ticket-draft-v1:previous')).toBeNull();
		expect(sessionStorage.getItem('chat-canvas-recovery-v1:previous')).toBeNull();
		expect(sessionStorage.getItem('unrelated-app')).toBe('keep');
		expect(navigate).toHaveBeenCalledExactlyOnceWith('/login?loggedOut=peer&cleanup=incomplete');
	});

	it('the peer logout destination never deletes a subsequent fresh login', async () => {
		setAuthToken(session(2).token);
		const previousUrl = window.location.href;
		window.history.replaceState(null, '', '/login?loggedOut=peer');
		try {
			const auth = store();
			await auth.checkAuthStatus();
			expect(auth.isAuthenticated).toBe(false);
			expect(getAuthToken()).toBeNull();
			expect(readStoredAuthToken()).toBe(session(2).token);
		} finally {
			window.history.replaceState(null, '', previousUrl);
		}
	});
});
afterEach(() => {
	for (const auth of stores.splice(0)) auth.destroy();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('initial authority', () => {
	it.each([false, true])(
		'discards a rejected cold storage candidate without a probe loop (storage read-only: %s)',
		async (readOnly) => {
			const auth = store();
			await auth.checkAuthStatus();
			const rejected = session(999).token;
			localStorage.setItem(
				LOCAL_STORAGE_KEYS.authToken,
				JSON.stringify({ token: rejected, epoch: null }),
			);
			if (readOnly)
				vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
					throw new Error('Read-only storage');
				});
			vi.mocked(api.getUser)
				.mockRejectedValueOnce(invalid())
				.mockReturnValue(new Promise(() => {}));
			await auth.reconcile();
			await vi.advanceTimersByTimeAsync(0);
			expect(api.getUser).toHaveBeenCalledTimes(1);
			expect(auth.token).toBeNull();
			expect(auth.availability).toBe('signed-out');
			expect(readStoredAuthToken()).toBe(readOnly ? rejected : null);
			vi.mocked(api.login).mockResolvedValue(session());
			expect((await auth.login('owner-before', 'password')).success).toBe(true);
		},
	);
	it('reconciles a different token stored while a cold candidate is rejected', async () => {
		const auth = store();
		await auth.checkAuthStatus();
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session().token, epoch: null }),
		);
		const pending = Promise.withResolvers<{ user: typeof user }>();
		vi.mocked(api.getUser).mockReturnValueOnce(pending.promise);
		const repair = auth.reconcile();
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(2).token, epoch: null }),
		);
		pending.reject(invalid());
		await repair;
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getUser).toHaveBeenCalledTimes(2);
		expect(auth.token).toBe(session(2).token);
		expect(auth.isAuthenticated).toBe(true);
	});
	it('discards rejected boot-token claims before accepting a valid sign-in', async () => {
		setAuthToken(session(999).token);
		const auth = store();
		vi.mocked(api.getUser).mockRejectedValue(invalid());
		await auth.checkAuthStatus();
		expect(auth.availability).toBe('signed-out');
		expect(auth.token).toBeNull();
		vi.mocked(api.login).mockResolvedValue(session());
		expect((await auth.login('owner-before', 'password')).success).toBe(true);
		expect(auth.token).toBe(session().token);
	});
	it('validates the captured stored token and establishes stable presentation ownership', async () => {
		const auth = await signedIn();
		expect(api.getUser).toHaveBeenCalledWith(session().token);
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.presentationOwner).toEqual({ mode: 'authenticated', key: user.id });
	});
	it('coalesces setup checks', async () => {
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.getAuthStatus>>>();
		vi.mocked(api.getAuthStatus).mockReturnValue(pending.promise);
		const auth = store();
		const first = auth.checkAuthStatus();
		const second = auth.checkAuthStatus();
		pending.resolve({ needsSetup: true, authDisabled: false, isAuthenticated: false });
		await Promise.all([first, second]);
		expect(api.getAuthStatus).toHaveBeenCalledTimes(1);
		expect(auth.needsSetup).toBe(true);
	});
	it('supports local mode without retaining bearer authority', async () => {
		setAuthToken(session().token);
		vi.mocked(api.getAuthStatus).mockResolvedValue({
			needsSetup: false,
			authDisabled: true,
			isAuthenticated: true,
		});
		const auth = store();
		await auth.checkAuthStatus();
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.token).toBeNull();
		expect(getAuthToken()).toBeNull();
		expect(auth.presentationOwner).toEqual({ mode: 'local', key: 'local' });
	});
	it('keeps credentials through a network outage and recovers', async () => {
		setAuthToken(session().token);
		vi.mocked(api.getAuthStatus).mockRejectedValueOnce(new TypeError('offline'));
		const auth = store();
		await auth.checkAuthStatus();
		expect(auth.isUnavailable).toBe(true);
		expect(auth.token).toBe(session().token);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(auth.isAuthenticated).toBe(true);
	});
	it('does not interpret generic 401/403 or provider failures as revocation', async () => {
		const auth = await signedIn();
		vi.mocked(api.getUser).mockRejectedValue(new ApiError(403, 'Provider denied'));
		await auth.reconcile();
		expect(auth.availability).toBe('repairing');
		expect(auth.token).toBe(session().token);
	});
	it('fences auth-storage failure without retrying or offering sign-in', async () => {
		const auth = await signedIn();
		vi.mocked(api.getUser).mockRejectedValue(
			new ApiError(503, 'Storage', 'AUTH_STORAGE_UNAVAILABLE'),
		);
		await auth.reconcile();
		await vi.advanceTimersByTimeAsync(60_000);
		await auth.reconcile();
		expect(api.getUser).toHaveBeenCalledTimes(2);
		expect(auth.availability).toBe('storage-unavailable');
		expect(canDispatchAuthenticated()).toBe(false);
	});
});

describe('session ordering and credential operations', () => {
	it.each([false, true])(
		'revalidates a login response overtaken by revocation, current=%s',
		async (current) => {
			const auth = await signedIn();
			const pending = Promise.withResolvers<AuthSessionResponse>();
			vi.mocked(api.login).mockReturnValue(pending.promise);
			const login = auth.login('owner', 'password');
			vi.mocked(api.getUser).mockRejectedValue(invalid());
			auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
			await auth.reconcile();
			if (current) vi.mocked(api.getUser).mockResolvedValue({ user });
			pending.resolve(session(current ? 2 : 1));
			await login;
			expect(auth.isAuthenticated).toBe(current);
			expect(api.getUser).toHaveBeenLastCalledWith(session(current ? 2 : 1).token);
		},
	);
	it('ignores stale status completion after login', async () => {
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.getAuthStatus>>>();
		vi.mocked(api.getAuthStatus).mockReturnValue(pending.promise);
		vi.mocked(api.login).mockResolvedValue(session());
		const auth = store();
		const status = auth.checkAuthStatus();
		await auth.login('owner-before', 'password');
		pending.resolve({ needsSetup: true, authDisabled: false, isAuthenticated: false });
		await status;
		expect(auth.isAuthenticated).toBe(true);
		expect(auth.needsSetup).toBe(false);
	});
	it('fences earlier login at the start of a later login', async () => {
		const first = Promise.withResolvers<AuthSessionResponse>();
		vi.mocked(api.login)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(session(2, 'owner-after'));
		const auth = store();
		const earlier = auth.login('old', 'password');
		await auth.login('new', 'password');
		first.resolve(session());
		await earlier;
		expect(auth.token).toBe(session(2).token);
	});
	it.each(['changeUsername', 'changePassword'] as const)(
		'adopts %s atomically without a status check or presentation reset',
		async (operation) => {
			const auth = await signedIn();
			vi.mocked(api[operation]).mockResolvedValue(session(2, 'owner-after'));
			const result =
				operation === 'changeUsername'
					? await auth.changeUsername({ username: 'owner-after', currentPassword: 'password' })
					: await auth.changePassword({
							newPassword: 'password-next',
							currentPassword: 'password',
						});
			expect(result.success).toBe(true);
			expect(auth.user?.id).toBe(user.id);
			expect(auth.token).toBe(session(2).token);
			expect(auth.isAuthenticated).toBe(true);
			expect(api.getAuthStatus).toHaveBeenCalledTimes(1);
			auth.sessionRejected(session().token, 'AUTH_SESSION_INVALID');
			expect(auth.isAuthenticated).toBe(true);
		},
	);
	it('uses one mutation gate and retains it until the replacement is installed', async () => {
		const auth = await signedIn();
		const pending = Promise.withResolvers<AuthSessionResponse>();
		vi.mocked(api.changeUsername).mockReturnValue(pending.promise);
		const change = auth.changeUsername({ username: 'next', currentPassword: 'password' });
		expect(
			(await auth.changePassword({ currentPassword: 'password', newPassword: 'next-password' }))
				.success,
		).toBe(false);
		expect(api.changePassword).not.toHaveBeenCalled();
		pending.resolve(session(2));
		await change;
		expect(auth.credentialPending).toBe(false);
	});
	it('wrong current password is a form error and does not revoke authority', async () => {
		const auth = await signedIn();
		vi.mocked(api.changePassword).mockRejectedValue(
			new ApiError(400, 'Incorrect password', 'AUTH_CURRENT_PASSWORD_INVALID'),
		);
		expect(
			await auth.changePassword({ currentPassword: 'wrong', newPassword: 'new-password' }),
		).toMatchObject({ success: false, errorCode: 'AUTH_CURRENT_PASSWORD_INVALID' });
		expect(auth.isAuthenticated).toBe(true);
	});
	it('holds early socket revocation until the source response arrives', async () => {
		const auth = await signedIn();
		const pending = Promise.withResolvers<AuthSessionResponse>();
		vi.mocked(api.changeUsername).mockReturnValue(pending.promise);
		vi.mocked(api.getUser).mockRejectedValue(invalid());
		const change = auth.changeUsername({ username: 'next', currentPassword: 'password' });
		auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
		await auth.reconcile();
		expect(auth.availability).toBe('repairing');
		expect(auth.presentationOwner?.key).toBe(user.id);
		pending.resolve(session(2, 'next'));
		await change;
		expect(auth.isAuthenticated).toBe(true);
	});
	it.each([new TypeError('lost response'), new Error('malformed successful response')])(
		'never repeats an unknown mutation',
		async (error) => {
			const auth = await signedIn();
			vi.mocked(api.changePassword).mockRejectedValue(error);
			const result = await auth.changePassword({
				currentPassword: 'password',
				newPassword: 'new-password',
			});
			expect(result.errorCode).toBe('AUTH_OUTCOME_UNKNOWN');
			expect(auth.availability).toBe('reauth-required');
			expect(api.changePassword).toHaveBeenCalledTimes(1);
			expect(auth.presentationOwner?.key).toBe(user.id);
		},
	);
	it('keeps memory authority when token persistence fails', async () => {
		const auth = await signedIn();
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('unavailable');
		});
		vi.mocked(api.changeUsername).mockResolvedValue(session(2));
		await auth.changeUsername({ username: 'next', currentPassword: 'password' });
		expect(auth.persistenceWarning).toBe(true);
		expect(getAuthToken()).toBe(session(2).token);
		await auth.reconcile();
		expect(auth.token).toBe(session(2).token);
	});
});

describe('same-origin repair', () => {
	it.each([false, true])(
		'retains a successful replacement while validating newer storage (candidate valid: %s)',
		async (valid) => {
			const auth = await signedIn();
			const pending = Promise.withResolvers<AuthSessionResponse>();
			vi.mocked(api.changePassword).mockReturnValue(pending.promise);
			const change = auth.changePassword({
				currentPassword: 'before',
				newPassword: 'after-password',
			});
			const candidate = session(999).token;
			localStorage.setItem(
				LOCAL_STORAGE_KEYS.authToken,
				JSON.stringify({ token: candidate, epoch: null }),
			);
			vi.mocked(api.getUser).mockImplementation(async (token) => {
				if (token === session(2).token || (valid && token === candidate)) return { user };
				throw invalid();
			});
			pending.resolve(session(2));
			expect((await change).success).toBe(true);
			expect(auth.token).toBe(session(2).token);
			expect(getAuthToken()).toBe(session(2).token);
			expect(canDispatchAuthenticated()).toBe(false);
			expect(readStoredAuthToken()).toBe(candidate);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(auth.token).toBe(valid ? candidate : session(2).token);
			expect(auth.isAuthenticated).toBe(true);
			expect(readStoredAuthToken()).toBe(auth.token);
		},
	);
	it('backs off an unchanged failing storage candidate even when memory verification succeeds', async () => {
		const auth = await signedIn();
		const candidate = session(999).token;
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: candidate, epoch: null }),
		);
		vi.mocked(api.getUser)
			.mockClear()
			.mockImplementation(async (token) => {
				if (token === candidate) throw new TypeError('Network failure');
				return { user };
			});
		await auth.reconcile();
		await vi.advanceTimersByTimeAsync(0);
		expect(api.getUser).toHaveBeenCalledTimes(2);
		expect(auth.token).toBe(session().token);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(api.getUser).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(api.getUser).toHaveBeenCalledTimes(4);
	});
	it('never lets an in-flight login lift a storage fence', async () => {
		const auth = await signedIn();
		const pending = Promise.withResolvers<AuthSessionResponse>();
		vi.mocked(api.login).mockReturnValue(pending.promise);
		const login = auth.login('owner', 'password');
		auth.sessionRejected(auth.token, 'AUTH_STORAGE_UNAVAILABLE');
		pending.resolve(session());
		await login;
		expect(auth.availability).toBe('storage-unavailable');
		expect(auth.isAuthenticated).toBe(false);
	});
	it('does not overwrite a newer stored replacement with a delayed probe', async () => {
		const auth = await signedIn();
		const probe = Promise.withResolvers<{ user: typeof user }>();
		vi.mocked(api.getUser).mockReturnValueOnce(probe.promise).mockResolvedValue({ user });
		const earlier = auth.reconcile();
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(2).token, epoch: null }),
		);
		probe.resolve({ user });
		await earlier;
		await auth.reconcile();
		expect(readStoredAuthToken()).toBe(session(2).token);
		expect(auth.token).toBe(session(2).token);
	});
	it('does not revive a rejected session through a previously successful probe', async () => {
		const auth = await signedIn();
		const probe = Promise.withResolvers<{ user: typeof user }>();
		vi.mocked(api.getUser).mockReturnValueOnce(probe.promise).mockRejectedValue(invalid());
		const earlier = auth.reconcile();
		auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
		probe.resolve({ user });
		await earlier;
		await auth.reconcile();
		expect(auth.isAuthenticated).toBe(false);
		expect(canDispatchAuthenticated()).toBe(false);
	});
	it('does not use the old session to resolve an uncertain credential mutation', async () => {
		const auth = await signedIn();
		vi.mocked(api.changePassword).mockRejectedValue(new TypeError('lost response'));
		await auth.changePassword({ currentPassword: 'password', newPassword: 'new-password' });
		await auth.reconcile();
		expect(auth.availability).toBe('reauth-required');
		expect(api.getUser).toHaveBeenCalledTimes(1);
	});
	it.each(['HTTP', 'WS'] as const)(
		'keeps sign-in available after an uncertain mutation receives a late %s rejection',
		async (source) => {
			const auth = await signedIn();
			auth.start();
			const delayed = Promise.withResolvers<Response>();
			vi.stubGlobal(
				'fetch',
				vi.fn(() => delayed.promise),
			);
			const oldRequest = source === 'HTTP' ? apiGet('/protected') : null;
			vi.mocked(api.changePassword).mockRejectedValue(new TypeError('Lost response'));
			await auth.changePassword({ currentPassword: 'password', newPassword: 'new-password' });
			expect(auth.availability).toBe('reauth-required');
			if (oldRequest) {
				delayed.resolve(
					Response.json(
						{
							error: 'Revoked',
							errorCode: 'AUTH_SESSION_INVALID',
							retryable: false,
						},
						{ status: 401 },
					),
				);
				await expect(oldRequest).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_INVALID' });
			} else auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
			await auth.reconcile();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(auth.availability).toBe('reauth-required');
			expect(canDispatchAuthenticated()).toBe(false);
			expect(auth.presentationOwner?.key).toBe(user.id);
			expect(api.getUser).toHaveBeenCalledTimes(1);
			expect(api.changePassword).toHaveBeenCalledTimes(1);
			vi.mocked(api.login).mockResolvedValue(session(2));
			expect((await auth.login(user.username, 'new-password')).success).toBe(true);
			expect(auth.isAuthenticated).toBe(true);
		},
	);
	it('retains the storage fence after late revocation of an uncertain session', async () => {
		const auth = await signedIn();
		vi.mocked(api.changePassword).mockRejectedValue(new TypeError('Lost response'));
		await auth.changePassword({ currentPassword: 'password', newPassword: 'new-password' });
		auth.sessionRejected(auth.token, 'AUTH_STORAGE_UNAVAILABLE');
		auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
		await auth.reconcile();
		expect(auth.availability).toBe('storage-unavailable');
		expect(canDispatchAuthenticated()).toBe(false);
		expect(api.getUser).toHaveBeenCalledTimes(1);
	});
	it('still adopts an independent replacement after late rejection of an uncertain session', async () => {
		const auth = await signedIn();
		vi.mocked(api.changePassword).mockRejectedValue(new TypeError('Lost response'));
		await auth.changePassword({ currentPassword: 'password', newPassword: 'new-password' });
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(2).token, epoch: null }),
		);
		auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
		await auth.reconcile();
		expect(auth.token).toBe(session(2).token);
		expect(auth.isAuthenticated).toBe(true);
		expect(api.getUser).toHaveBeenLastCalledWith(session(2).token);
	});
	it.each([invalid(), new TypeError('Offline')])(
		'keeps uncertain authority suspended when a stored replacement fails verification',
		async (failure) => {
			const auth = await signedIn();
			vi.mocked(api.changePassword).mockRejectedValue(new TypeError('Lost response'));
			await auth.changePassword({ currentPassword: 'password', newPassword: 'new-password' });
			localStorage.setItem(
				LOCAL_STORAGE_KEYS.authToken,
				JSON.stringify({ token: session(999).token, epoch: null }),
			);
			vi.mocked(api.getUser).mockRejectedValueOnce(failure).mockResolvedValue({ user });
			await auth.reconcile();
			expect(api.getUser).toHaveBeenCalledTimes(2);
			expect(api.getUser).toHaveBeenLastCalledWith(session(999).token);
			expect(auth.availability).toBe('reauth-required');
			expect(canDispatchAuthenticated()).toBe(false);
		},
	);
	it('validates storage replacement and refuses late old login completion', async () => {
		const auth = await signedIn();
		const pending = Promise.withResolvers<AuthSessionResponse>();
		vi.mocked(api.login).mockReturnValue(pending.promise);
		const login = auth.login('owner', 'password');
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(2).token, epoch: null }),
		);
		await auth.reconcile();
		pending.resolve(session());
		await login;
		expect(auth.token).toBe(session(2).token);
		expect(api.getUser).toHaveBeenLastCalledWith(session(2).token);
	});
	it('never accepts an unvalidated higher revision from storage', async () => {
		const auth = await signedIn();
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.authToken,
			JSON.stringify({ token: session(999).token, epoch: null }),
		);
		vi.mocked(api.getUser).mockRejectedValueOnce(invalid()).mockResolvedValueOnce({ user });
		await auth.reconcile();
		expect(auth.token).toBe(session().token);
		expect(auth.isAuthenticated).toBe(true);
	});
	it('bounds pending notices and then requires reauthentication in place', async () => {
		const auth = await signedIn();
		publishCredentialPending(auth.token!);
		vi.mocked(api.getUser).mockRejectedValue(invalid());
		auth.sessionRejected(auth.token, 'AUTH_SESSION_INVALID');
		await auth.reconcile();
		await vi.advanceTimersByTimeAsync(35_001);
		expect(auth.availability).toBe('reauth-required');
		expect(auth.presentationOwner?.key).toBe(user.id);
	});
	it.each(['storage', 'pageshow', 'online', 'visibilitychange'])(
		'reconciles on %s without remounting',
		async (event) => {
			const auth = await signedIn();
			auth.start();
			localStorage.setItem(
				LOCAL_STORAGE_KEYS.authToken,
				JSON.stringify({ token: session(2).token, epoch: null }),
			);
			(event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
			await auth.reconcile();
			expect(auth.token).toBe(session(2).token);
		},
	);
});
