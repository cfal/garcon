import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAuthState } from '../settings-auth-state.svelte.js';
import {
	completeAgentAuthLogin,
	getAgentAuthLoginStatus,
	getAgentAuthStatus,
	launchAgentAuthLogin,
} from '$lib/api/agents.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte.js';

vi.mock('$lib/api/agents.js', () => ({
	completeAgentAuthLogin: vi.fn(),
	getAgentAuthLoginStatus: vi.fn(),
	getAgentAuthStatus: vi.fn(),
	getAgentReadiness: vi.fn(async () => ({})),
	launchAgentAuthLogin: vi.fn(),
}));

const DEVICE_AUTH = { url: 'https://example.test/device', code: 'AAAA-BBBBB' };
const CLAUDE_AUTH = { url: 'https://example.test/claude', needsCode: true };
const SESSION_ID = 'session-a';
const POLL_TICK_MS = 1500;

function createModelCatalog(agentIds: string[] = []) {
	return {
		getAgent: () => ({ authLoginSupported: true }),
		getAgentMetadataList: () => agentIds.map((id) => ({ id })),
		forceRefresh: async () => undefined,
	} as unknown as ModelCatalogStore;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('SettingsAuthState login lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubGlobal('open', vi.fn());
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: DEVICE_AUTH,
		});
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			running: true,
			sessionId: SESSION_ID,
			deviceAuth: DEVICE_AUTH,
		});
		vi.mocked(getAgentAuthStatus).mockResolvedValue({
			authenticated: true,
			canReauth: true,
			label: 'user@example.com',
		});
		vi.mocked(completeAgentAuthLogin).mockResolvedValue({
			completed: true,
			sessionId: SESSION_ID,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('keeps the device code visible while stale credentials report authenticated', async () => {
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS * 3);

		expect(getAgentAuthLoginStatus).toHaveBeenCalledWith('codex');
		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);
	});

	it('clears the device code and refreshes auth once the owned session ends', async () => {
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ running: true, sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH })
			.mockResolvedValue({ running: false });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');
		vi.mocked(getAgentAuthStatus).mockClear();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();
		expect(getAgentAuthStatus).toHaveBeenCalledWith('codex');
		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
	});

	it('polls an already-running session through the pre-code window', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: false,
			alreadyRunning: true,
			sessionId: SESSION_ID,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ running: true, sessionId: SESSION_ID })
			.mockResolvedValue({ running: true, sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');
		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);
		expect(window.open).not.toHaveBeenCalled();
	});

	it('restores and resumes polling an active session on initialize and reopen', async () => {
		const settingsAuth = new SettingsAuthState(createModelCatalog(['codex']));
		const firstCleanup = settingsAuth.initialize();
		await vi.waitFor(() => expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH));

		firstCleanup();
		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();
		settingsAuth.initialize();
		await vi.waitFor(() => expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH));

		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(4);
	});

	it('invalidates an in-flight launch when Settings is destroyed', async () => {
		const launch = deferred<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
		vi.mocked(launchAgentAuthLogin).mockReturnValue(launch.promise);
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		const login = settingsAuth.handleLogin('codex');

		settingsAuth.destroy();
		launch.resolve({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: DEVICE_AUTH,
		});
		await login;

		expect(window.open).not.toHaveBeenCalled();
		expect(getAgentAuthLoginStatus).not.toHaveBeenCalled();
		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();
		expect(settingsAuth.isLoginPending('codex')).toBe(false);
	});

	it('keeps a newer login pending when an older completion settles', async () => {
		const firstCompletion = deferred<Awaited<ReturnType<typeof completeAgentAuthLogin>>>();
		const secondLaunch = deferred<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
		const secondSessionAuth = { url: 'https://example.test/claude-next', needsCode: true };
		vi.mocked(launchAgentAuthLogin)
			.mockResolvedValueOnce({
				launched: true,
				alreadyRunning: false,
				sessionId: SESSION_ID,
				deviceAuth: CLAUDE_AUTH,
			})
			.mockReturnValueOnce(secondLaunch.promise);
		vi.mocked(completeAgentAuthLogin).mockReturnValueOnce(firstCompletion.promise);
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			running: true,
			sessionId: 'session-b',
			deviceAuth: secondSessionAuth,
		});

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		const completion = settingsAuth.completeLogin('claude', 'first-code');
		const newerLogin = settingsAuth.handleLogin('claude');

		firstCompletion.resolve({ completed: true, sessionId: SESSION_ID });
		await completion;

		expect(settingsAuth.isLoginPending('claude')).toBe(true);

		secondLaunch.resolve({
			launched: true,
			alreadyRunning: false,
			sessionId: 'session-b',
			deviceAuth: secondSessionAuth,
		});
		await newerLogin;

		expect(settingsAuth.deviceAuthFor('claude')).toEqual(secondSessionAuth);
		expect(settingsAuth.isLoginPending('claude')).toBe(false);
	});

	it('ignores a stale restored session after a newer login launches', async () => {
		const staleRestore = deferred<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		const secondSessionAuth = { url: 'https://example.test/claude-next', needsCode: true };
		vi.mocked(getAgentAuthLoginStatus)
			.mockReturnValueOnce(staleRestore.promise)
			.mockResolvedValue({
				running: true,
				sessionId: 'session-b',
				deviceAuth: secondSessionAuth,
			});
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: 'session-b',
			deviceAuth: secondSessionAuth,
		});

		const settingsAuth = new SettingsAuthState(createModelCatalog(['claude']));
		settingsAuth.initialize();
		await settingsAuth.handleLogin('claude');

		staleRestore.resolve({
			running: true,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		await staleRestore.promise;
		await Promise.resolve();

		expect(settingsAuth.deviceAuthFor('claude')).toEqual(secondSessionAuth);
		await settingsAuth.completeLogin('claude', 'second-code');
		expect(completeAgentAuthLogin).toHaveBeenCalledWith('claude', 'session-b', 'second-code');
	});

	it('clears a Claude code form when its login process exits', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ running: true, sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH })
			.mockResolvedValue({ running: false });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH);

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.deviceAuthFor('claude')).toBeUndefined();
		expect(getAgentAuthStatus).toHaveBeenCalledWith('claude');
	});

	it('clears failed Claude completion state so sign-in can be retried', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(completeAgentAuthLogin).mockRejectedValue(new Error('code rejected'));

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		await settingsAuth.completeLogin('claude', 'bad-code');

		expect(completeAgentAuthLogin).toHaveBeenCalledWith('claude', SESSION_ID, 'bad-code');
		expect(settingsAuth.deviceAuthFor('claude')).toBeUndefined();
		expect(settingsAuth.isLoginPending('claude')).toBe(false);
		expect(settingsAuth.authFor('claude').error).toBe('code rejected');
	});
});
