import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { SettingsAuthState } from '../settings-auth-state.svelte.js';
import OtherAgentsSection from '../OtherAgentsSection.svelte';
import {
	completeAgentAuthLogin,
	getAgentAuthLoginStatus,
	getAgentAuthStatus,
	launchAgentAuthLogin,
} from '$lib/api/agents.js';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import { nativeCatalogAgent } from '../../../../test/model-catalog';
import * as catalogApi from '$lib/api/model-catalog';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures';

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

function createModelCatalog(agentIds = ['claude', 'codex'], executorId = 'local') {
	const catalog = new ModelCatalogStore(executorId);
	catalog.setOwner('test-owner');
	catalog.agentMetadata = Object.fromEntries(agentIds.map(id => [id, nativeCatalogAgent(id)]));
	vi.spyOn(catalog, 'forceRefresh').mockResolvedValue();
	return catalog;
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
			state: 'running',
			running: true, completionPending: false,
			sessionId: SESSION_ID,
			deviceAuth: DEVICE_AUTH,
		});
		vi.mocked(getAgentAuthStatus).mockResolvedValue({
			authenticated: true,
			canReauth: true,
			label: 'user@example.com',
		});
		vi.mocked(completeAgentAuthLogin).mockResolvedValue({
			submitted: true,
			sessionId: SESSION_ID,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('shows the configured auth method diagnostic without offering an ineffective sign-in', async () => {
		const detail = 'GEMINI_API_KEY is not set.';
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: false, canReauth: false, label: '', detail });
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({ state: 'idle', running: false });
		const settingsAuth = new SettingsAuthState(createModelCatalog(['antigravity']));
		const cleanup = settingsAuth.initialize();
		render(OtherAgentsSection, { settingsAuth });
		await vi.waitFor(() => expect(settingsAuth.authFor('antigravity').loading).toBe(false));
		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: /Antigravity/ }));
		expect(screen.getByText(detail)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
		cleanup();
	});

	it.each(['owner', 'executor'])('ignores a launch reply after %s retirement while Settings stays mounted', async change => {
		const catalog = createModelCatalog(['codex'], remoteExecutor.id);
		catalog.reconcileExecutors([remoteExecutor]);
		const launch = Promise.withResolvers<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
		vi.mocked(launchAgentAuthLogin).mockReturnValueOnce(launch.promise);
		const view = new SettingsAuthState(catalog);
		const pending = view.handleLogin('codex');
		if (change === 'owner') catalog.setOwner('owner-b');
		else catalog.reconcileExecutors([{ ...remoteExecutor, instanceId: 'replacement' }]);
		expect(view.isLoginPending('codex')).toBe(false);
		launch.resolve({ launched: true, alreadyRunning: false, sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH });
		await pending;
		expect(catalog.pendingLogins.sessionId('codex')).toBeUndefined();
		expect(view.deviceAuthFor('codex')).toBeUndefined();
		expect(window.open).not.toHaveBeenCalled();
	});

	it('ignores a sessionless restore reply from the previous browser owner', async () => {
		const catalog = createModelCatalog(['codex']);
		const status = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		vi.mocked(getAgentAuthLoginStatus).mockReturnValueOnce(status.promise);
		const view = new SettingsAuthState(catalog);
		const destroy = view.initialize();
		catalog.setOwner(null);
		status.resolve({ state: 'running', running: true, completionPending: false, sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH });
		await vi.advanceTimersByTimeAsync(0);
		expect(catalog.pendingLogins.sessionId('codex')).toBeUndefined();
		expect(view.deviceAuthFor('codex')).toBeUndefined();
		destroy();
	});

	it('publishes only the signed-in executor catalog when Settings closes after submitting a browser code', async () => {
		const id = remoteExecutor.id;
		const catalog = createModelCatalog(['antigravity'], id);
		vi.mocked(catalog.forceRefresh).mockRestore();
		const defaultModel = { value: 'default', label: 'Default' };
		const discovered = { value: 'sample-model-high', label: 'Sample model (High)' };
		const snapshot = (models: typeof defaultModel[]) => Response.json({
			catalog: { apiProviders: [], agents: [nativeCatalogAgent('antigravity', models)] },
		});
		const stale = Promise.withResolvers<Response>();
		const fresh = Promise.withResolvers<Response>();
		const fetchCatalog = vi.spyOn(catalogApi, 'fetchModelCatalogResponse')
			.mockResolvedValueOnce(snapshot([defaultModel]))
			.mockReturnValueOnce(stale.promise)
			.mockReturnValueOnce(fresh.promise);
		const deviceAuth = { url: 'https://example.test/login', needsCode: true };
		const confirmation = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthStatus>>>();
		vi.mocked(getAgentAuthStatus)
			.mockResolvedValueOnce({ authenticated: false, canReauth: true, label: '' })
			.mockReturnValueOnce(confirmation.promise);
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true, alreadyRunning: false, sessionId: SESSION_ID, deviceAuth,
		});
		const submitted = Promise.withResolvers<Awaited<ReturnType<typeof completeAgentAuthLogin>>>();
		vi.mocked(completeAgentAuthLogin).mockReturnValueOnce(submitted.promise);
		const terminal = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ state: 'idle', running: false })
			.mockResolvedValueOnce({ state: 'running', running: true, sessionId: SESSION_ID, completionPending: false, deviceAuth })
			.mockImplementation(async (agent, sessionId, executorId) => {
				if (agent === 'antigravity' && sessionId === SESSION_ID && executorId === id) return terminal.promise;
				return { state: 'idle', running: false };
			});
		const settingsAuth = new SettingsAuthState(catalog);
		const cleanup = settingsAuth.initialize();
		const view = render(OtherAgentsSection, { settingsAuth });
		await vi.waitFor(() => expect(catalog.isValidated).toBe(true));
		const preLoginRefresh = catalog.forceRefresh();
		await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		expect(screen.getByRole('link', { name: deviceAuth.url })).toBeTruthy();
		const callback = 'https://example.test/callback?code=test-code';
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: callback } });
		await fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
		expect(completeAgentAuthLogin).toHaveBeenCalledWith('antigravity', SESSION_ID, callback, id);
		cleanup();
		view.unmount();
		expect(fetchCatalog).toHaveBeenCalledTimes(2);
		submitted.resolve({ submitted: true, sessionId: SESSION_ID });
		terminal.resolve({ state: 'succeeded', instanceId: 'test-worker', running: false, sessionId: SESSION_ID });
		await vi.waitFor(() => expect(getAgentAuthStatus).toHaveBeenCalledTimes(2));
		expect(fetchCatalog).toHaveBeenCalledTimes(2);
		confirmation.resolve({ authenticated: true, canReauth: true, label: 'Google' });
		await vi.waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(3));
		expect(catalog.isValidated).toBe(true);
		expect(fetchCatalog.mock.calls.every(([executorId]) => executorId === id)).toBe(true);
		fresh.resolve(snapshot([defaultModel, discovered]));
		await vi.waitFor(() => expect(catalog.getModels('antigravity')).toHaveLength(2));
		stale.resolve(snapshot([defaultModel]));
		await preLoginRefresh;
		expect(fetchCatalog).toHaveBeenCalledTimes(3);
		expect(fetchCatalog).toHaveBeenLastCalledWith(id, null, 'test-worker');
		expect(catalog.getModels('antigravity').map(model => model.value)).toEqual(['default', discovered.value]);
	});

	it('keeps the device code visible while stale credentials report authenticated', async () => {
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS * 3);

		expect(getAgentAuthLoginStatus).toHaveBeenCalledWith('codex', SESSION_ID, 'local');
		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);
	});

	it('retains a mounted code form across same-owner reauthentication and releases it on owner loss', async () => {
		const catalog = createModelCatalog(['antigravity']);
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: false, canReauth: true, label: '' });
		const login = { ...CLAUDE_AUTH, url: 'https://example.test/oauth' };
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true, alreadyRunning: false, sessionId: SESSION_ID, deviceAuth: login,
		});
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValueOnce({ state: 'idle', running: false })
			.mockResolvedValue({ state: 'running', running: true, completionPending: false, sessionId: SESSION_ID, deviceAuth: login });
		const settingsAuth = new SettingsAuthState(catalog);
		const cleanup = settingsAuth.initialize();
		render(OtherAgentsSection, { settingsAuth });
		await vi.waitFor(() => expect(settingsAuth.authFor('antigravity').loading).toBe(false));
		await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'synthetic-code' } });
		catalog.setOwner('test-owner');
		await fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
		expect(completeAgentAuthLogin).toHaveBeenCalledWith('antigravity', SESSION_ID, 'synthetic-code', 'local');
		catalog.setOwner(null);
		await vi.waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
		expect(settingsAuth.isLoginPending('antigravity')).toBe(false);
		cleanup();
	});

	it('routes login to the selected executor and ignores replies after leaving that executor', async () => {
		const executorId = '22222222-2222-4222-8222-222222222222';
		const launched = Promise.withResolvers<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
		vi.mocked(launchAgentAuthLogin).mockReturnValueOnce(launched.promise);
		const remote = new SettingsAuthState(createModelCatalog(['codex'], executorId));
		const pending = remote.handleLogin('codex');
		expect(launchAgentAuthLogin).toHaveBeenCalledWith('codex', executorId);
		remote.destroy();
		launched.resolve({ launched: true, alreadyRunning: false, sessionId: SESSION_ID, deviceAuth: DEVICE_AUTH });
		await pending;
		await vi.advanceTimersByTimeAsync(POLL_TICK_MS * 2);
		expect(remote.deviceAuthFor('codex')).toBeUndefined();
		expect(getAgentAuthLoginStatus).not.toHaveBeenCalled();
	});

	it('clears the device code and refreshes auth once the owned session ends', async () => {
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({
				state: 'running',
				running: true, completionPending: false,
				sessionId: SESSION_ID,
				deviceAuth: DEVICE_AUTH,
			})
			.mockResolvedValue({ state: 'succeeded', instanceId: 'test-worker', running: false, sessionId: SESSION_ID });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');
		vi.mocked(getAgentAuthStatus).mockClear();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();
		expect(getAgentAuthStatus).toHaveBeenCalledWith('codex', 'local', 'test-worker');
		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
	});

	it('polls an already-running session through the pre-code window', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: false,
			alreadyRunning: true,
			sessionId: SESSION_ID,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ state: 'running', running: true, completionPending: false, sessionId: SESSION_ID })
			.mockResolvedValue({
				state: 'running',
				running: true, completionPending: false,
				sessionId: SESSION_ID,
				deviceAuth: DEVICE_AUTH,
			});

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

		expect(settingsAuth.isLoginPending('codex')).toBe(true);
		await settingsAuth.completeLogin('codex', 'synthetic-code');
		expect(completeAgentAuthLogin).not.toHaveBeenCalled();
		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(3);
		expect(settingsAuth.isLoginPending('codex')).toBe(false);
	});

	it('invalidates an in-flight launch when Settings is destroyed', async () => {
		const launch = Promise.withResolvers<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
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

	it.each(['resolves', 'rejects'] as const)('preserves a newer login and its polling when an older completion %s', async (settlement) => {
		const firstCompletion = Promise.withResolvers<Awaited<ReturnType<typeof completeAgentAuthLogin>>>();
		const secondLaunch = Promise.withResolvers<Awaited<ReturnType<typeof launchAgentAuthLogin>>>();
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
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({
				state: 'running',
				running: true, completionPending: false,
				sessionId: SESSION_ID,
				deviceAuth: CLAUDE_AUTH,
			})
			.mockResolvedValue({
				state: 'running',
				running: true, completionPending: true,
				sessionId: 'session-b',
				deviceAuth: secondSessionAuth,
			});

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		const completion = settingsAuth.completeLogin('claude', 'first-code');
		const newerLogin = settingsAuth.handleLogin('claude');

		secondLaunch.resolve({
			launched: false,
			alreadyRunning: true,
			sessionId: 'session-b',
			deviceAuth: secondSessionAuth,
		});
		await newerLogin;
		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(2);

		if (settlement === 'resolves') {
			firstCompletion.resolve({ submitted: true, sessionId: SESSION_ID });
		} else {
			firstCompletion.reject(new Error('stale completion failed'));
		}
		await completion;

		expect(settingsAuth.deviceAuthFor('claude')).toEqual(secondSessionAuth);
		expect(settingsAuth.isLoginPending('claude')).toBe(true);
		expect(settingsAuth.authFor('claude').error).toBeNull();
		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(getAgentAuthLoginStatus).toHaveBeenCalledTimes(3);
		expect(getAgentAuthLoginStatus).toHaveBeenLastCalledWith('claude', 'session-b', 'local');
	});

	it('ignores a stale restored session after a newer login launches', async () => {
		const staleRestore = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		const secondSessionAuth = { url: 'https://example.test/claude-next', needsCode: true };
		vi.mocked(getAgentAuthLoginStatus).mockReturnValueOnce(staleRestore.promise).mockResolvedValue({
			state: 'running',
			running: true, completionPending: false,
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
			state: 'running',
			running: true, completionPending: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		await staleRestore.promise;
		await Promise.resolve();

		expect(settingsAuth.deviceAuthFor('claude')).toEqual(secondSessionAuth);
		await settingsAuth.completeLogin('claude', 'second-code');
		expect(completeAgentAuthLogin).toHaveBeenCalledWith('claude', 'session-b', 'second-code', 'local');
	});

	it('clears a Claude code form when its login process exits', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({
				state: 'running',
				running: true, completionPending: false,
				sessionId: SESSION_ID,
				deviceAuth: CLAUDE_AUTH,
			})
			.mockResolvedValue({ state: 'succeeded', instanceId: 'test-worker', running: false, sessionId: SESSION_ID });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH);

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.deviceAuthFor('claude')).toBeUndefined();
		expect(getAgentAuthStatus).toHaveBeenCalledWith('claude', 'local', 'test-worker');
	});

	it('keeps the owned Claude session retryable when code submission fails', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(completeAgentAuthLogin).mockRejectedValue(new Error('code rejected'));
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'running', running: true, completionPending: false,
			sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH,
		});

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		await settingsAuth.completeLogin('claude', 'bad-code');
		await vi.waitFor(() => expect(settingsAuth.isLoginPending('claude')).toBe(false));

		expect(completeAgentAuthLogin).toHaveBeenCalledWith('claude', SESSION_ID, 'bad-code', 'local');
		expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH);
		expect(settingsAuth.isLoginPending('claude')).toBe(false);
		expect(settingsAuth.authFor('claude').error).toBe('code rejected');
	});

	it('keeps Claude session ownership after code submission until terminal success', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			sessionId: SESSION_ID,
			deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({
				state: 'running',
				running: true, completionPending: false,
				sessionId: SESSION_ID,
				deviceAuth: CLAUDE_AUTH,
			})
			.mockResolvedValueOnce({
				state: 'running', running: true, completionPending: true,
				sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH,
			})
			.mockResolvedValue({ state: 'succeeded', instanceId: 'test-worker', running: false, sessionId: SESSION_ID });

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		await settingsAuth.completeLogin('claude', 'auth-code');

		expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH);
		expect(settingsAuth.isLoginPending('claude')).toBe(true);
		expect(getAgentAuthStatus).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(settingsAuth.deviceAuthFor('claude')).toBeUndefined();
		expect(settingsAuth.isLoginPending('claude')).toBe(false);
		expect(getAgentAuthStatus).toHaveBeenCalledWith('claude', 'local', 'test-worker');
	});

	it('surfaces the terminal failure for the owned session', async () => {
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'failed',
			running: false,
			sessionId: SESSION_ID,
			error: 'Sign-in failed. Start a new sign-in attempt.',
		});

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');

		await vi.waitFor(() => expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined());
		expect(settingsAuth.authFor('codex').error).toBe(
			'Sign-in failed. Start a new sign-in attempt.',
		);
		expect(getAgentAuthStatus).not.toHaveBeenCalled();
	});

	it('polls auth after terminal success when credential propagation is delayed', async () => {
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'succeeded', instanceId: 'test-worker',
			running: false,
			sessionId: SESSION_ID,
		});
		vi.mocked(getAgentAuthStatus)
			.mockRejectedValueOnce(new Error('credentials not ready'))
			.mockResolvedValue({
				authenticated: true,
				canReauth: true,
				label: 'new@example.com',
			});

		const catalog = createModelCatalog();
		const settingsAuth = new SettingsAuthState(catalog);
		await settingsAuth.handleLogin('codex');
		expect(settingsAuth.authFor('codex').authenticated).toBe(false);
		expect(catalog.forceRefresh).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
		expect(getAgentAuthStatus).toHaveBeenCalledTimes(2);
		expect(catalog.forceRefresh).toHaveBeenCalledOnce();
	});

	it('polls auth after terminal success when the first credential check is unauthenticated', async () => {
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'succeeded', instanceId: 'test-worker',
			running: false,
			sessionId: SESSION_ID,
		});
		vi.mocked(getAgentAuthStatus)
			.mockResolvedValueOnce({ authenticated: false, canReauth: true, label: '' })
			.mockResolvedValue({
				authenticated: true,
				canReauth: true,
				label: 'new@example.com',
			});

		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('codex');
		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);

		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
		expect(getAgentAuthStatus).toHaveBeenCalledTimes(2);
	});

	it('ignores an initialize auth response superseded by a login operation', async () => {
		const staleAuth = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthStatus>>>();
		vi.mocked(getAgentAuthStatus).mockReturnValueOnce(staleAuth.promise).mockResolvedValue({
			authenticated: true,
			canReauth: true,
			label: 'new@example.com',
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ state: 'idle', running: false })
			.mockResolvedValue({ state: 'succeeded', instanceId: 'test-worker', running: false, sessionId: SESSION_ID });

		const settingsAuth = new SettingsAuthState(createModelCatalog(['codex']));
		settingsAuth.initialize();
		await settingsAuth.handleLogin('codex');
		await Promise.resolve();

		staleAuth.resolve({
			authenticated: false,
			canReauth: true,
			label: 'old@example.com',
		});
		await staleAuth.promise;
		await Promise.resolve();

		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
		expect(settingsAuth.authFor('codex').label).toBe('new@example.com');
	});

	it('restores pending completion and blocks a programmatic duplicate after reopen', async () => {
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'running', running: true, completionPending: true,
			sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH,
		});
		const settingsAuth = new SettingsAuthState(createModelCatalog(['claude']));
		const cleanup = settingsAuth.initialize();
		await vi.waitFor(() => expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH));
		expect(settingsAuth.isLoginPending('claude')).toBe(true);
		await settingsAuth.completeLogin('claude', 'synthetic-code#suffix');
		expect(completeAgentAuthLogin).not.toHaveBeenCalled();
		cleanup();
		settingsAuth.initialize();
		await vi.waitFor(() => expect(settingsAuth.isLoginPending('claude')).toBe(true));
		settingsAuth.destroy();
	});

	it('retains the same form after CLI rejection and allows a complete-code retry', async () => {
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true, alreadyRunning: false, sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH,
		});
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ state: 'running', running: true, completionPending: false, sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH })
			.mockResolvedValueOnce({ state: 'running', running: true, completionPending: false, sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH, retryableError: 'Paste the full code, including its suffix.' })
			.mockResolvedValue({ state: 'running', running: true, completionPending: true, sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH });
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		await settingsAuth.completeLogin('claude', 'partial-code');
		await Promise.resolve();
		expect(settingsAuth.deviceAuthFor('claude')).toEqual(CLAUDE_AUTH);
		expect(settingsAuth.isLoginPending('claude')).toBe(false);
		expect(settingsAuth.authFor('claude').error).toBe('Paste the full code, including its suffix.');
		await settingsAuth.completeLogin('claude', 'complete-code#suffix');
		await Promise.resolve();
		expect(completeAgentAuthLogin).toHaveBeenLastCalledWith('claude', SESSION_ID, 'complete-code#suffix', 'local');
		expect(settingsAuth.authFor('claude').error).toBeNull();
		expect(settingsAuth.isLoginPending('claude')).toBe(true);
		settingsAuth.destroy();
	});

	it('guards duplicate completion while the first request is in flight', async () => {
		const completion = Promise.withResolvers<Awaited<ReturnType<typeof completeAgentAuthLogin>>>();
		vi.mocked(completeAgentAuthLogin).mockReturnValue(completion.promise);
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		const first = settingsAuth.completeLogin('claude', 'synthetic-code#suffix');
		await settingsAuth.completeLogin('claude', 'synthetic-code#suffix');
		expect(completeAgentAuthLogin).toHaveBeenCalledTimes(1);
		completion.resolve({ submitted: true, sessionId: SESSION_ID });
		await first;
		settingsAuth.destroy();
	});

	it('keeps an uncertain submission disabled until owned server status permits retry', async () => {
		const reconciliation = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		vi.mocked(completeAgentAuthLogin).mockRejectedValue(new Error('Executor connection interrupted'));
		const settingsAuth = new SettingsAuthState(createModelCatalog());
		await settingsAuth.handleLogin('claude');
		vi.mocked(getAgentAuthLoginStatus).mockReturnValue(reconciliation.promise);
		await settingsAuth.completeLogin('claude', 'synthetic-code#suffix');
		expect(settingsAuth.isLoginPending('claude')).toBe(true);
		expect(settingsAuth.authFor('claude').error).toBe('Executor connection interrupted');
		await settingsAuth.completeLogin('claude', 'synthetic-code#suffix');
		expect(completeAgentAuthLogin).toHaveBeenCalledTimes(1);
		reconciliation.resolve({
			state: 'running', running: true, completionPending: false,
			sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH,
		});
		await vi.waitFor(() => expect(settingsAuth.isLoginPending('claude')).toBe(false));
		expect(settingsAuth.authFor('claude').error).toBe('Executor connection interrupted');
		settingsAuth.destroy();
	});

	it('preserves a restored retry error when a concurrent auth-status response settles', async () => {
		const initialAuth = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthStatus>>>();
		vi.mocked(getAgentAuthStatus).mockReturnValue(initialAuth.promise);
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'running', running: true, completionPending: false,
			sessionId: SESSION_ID, deviceAuth: CLAUDE_AUTH, retryableError: 'Copy the complete code.',
		});
		const settingsAuth = new SettingsAuthState(createModelCatalog(['claude']));
		settingsAuth.initialize();
		await vi.waitFor(() => expect(settingsAuth.authFor('claude').error).toBe('Copy the complete code.'));
		initialAuth.resolve({ authenticated: false, canReauth: true, label: '' });
		await initialAuth.promise;
		await Promise.resolve();
		expect(settingsAuth.authFor('claude').error).toBe('Copy the complete code.');
		settingsAuth.destroy();
	});
});
