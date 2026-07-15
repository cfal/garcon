import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsAuthState } from '../settings-auth-state.svelte.js';
import {
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
const POLL_TICK_MS = 1500;

const modelCatalog = {
	getAgent: () => ({ authLoginSupported: true }),
	forceRefresh: async () => undefined,
} as unknown as ModelCatalogStore;

describe('SettingsAuthState device auth login', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubGlobal('open', vi.fn());
		vi.mocked(launchAgentAuthLogin).mockResolvedValue({
			launched: true,
			alreadyRunning: false,
			deviceAuth: DEVICE_AUTH,
		});
		// Simulates stale credentials: auth status reports authenticated
		// throughout the re-login.
		vi.mocked(getAgentAuthStatus).mockResolvedValue({
			authenticated: true,
			canReauth: true,
			label: 'user@example.com',
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('keeps the device code visible while the login session is running', async () => {
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			running: true,
			deviceAuth: DEVICE_AUTH,
		});

		const settingsAuth = new SettingsAuthState(modelCatalog);
		await settingsAuth.handleLogin('codex');
		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS * 3);

		expect(getAgentAuthLoginStatus).toHaveBeenCalledWith('codex');
		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);
	});

	it('clears the device code and refreshes auth once the session ends', async () => {
		vi.mocked(getAgentAuthLoginStatus)
			.mockResolvedValueOnce({ running: true, deviceAuth: DEVICE_AUTH })
			.mockResolvedValue({ running: false });

		const settingsAuth = new SettingsAuthState(modelCatalog);
		await settingsAuth.handleLogin('codex');
		vi.mocked(getAgentAuthStatus).mockClear();

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(settingsAuth.deviceAuthFor('codex')).toEqual(DEVICE_AUTH);

		await vi.advanceTimersByTimeAsync(POLL_TICK_MS);
		expect(settingsAuth.deviceAuthFor('codex')).toBeUndefined();
		expect(getAgentAuthStatus).toHaveBeenCalledWith('codex');
		expect(settingsAuth.authFor('codex').authenticated).toBe(true);
	});
});
