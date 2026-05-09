import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import SettingsTestHarness from './SettingsTestHarness.svelte';

vi.mock('$lib/api/settings.js', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
	sendTelegramTest: vi.fn(),
}));

vi.mock('$lib/api/providers.js', () => ({
	getHarnessAuthStatus: vi.fn(),
	getHarnessReadiness: vi.fn(),
	launchHarnessAuthLogin: vi.fn(),
}));

const settingsApi = await import('$lib/api/settings.js');
const providersApi = await import('$lib/api/providers.js');

describe('Settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValue(new Promise(() => {}));
		vi.mocked(providersApi.getHarnessAuthStatus).mockResolvedValue({
			authenticated: false,
			canReauth: true,
			label: '',
		});
		vi.mocked(providersApi.getHarnessReadiness).mockResolvedValue({});
	});

	it('renders a single-page layout with local and remote sections', async () => {
		const appShell = createAppShellStore();
		appShell.openSettings('remote');
		const remoteSettings = new RemoteSettingsStore();
		const refreshSpy = vi.spyOn(remoteSettings, 'refreshInBackground').mockResolvedValue();

		const rendered = render(SettingsTestHarness, { appShell, remoteSettings });

		try {
			await waitFor(() => {
				expect(refreshSpy).toHaveBeenCalled();
			});
			expect(screen.queryByRole('tablist')).toBeNull();
			expect(await screen.findByRole('heading', { name: 'Local' })).toBeTruthy();
			expect(await screen.findByRole('heading', { name: 'Remote' })).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
			expect(screen.queryByRole('heading', { name: 'API Providers' })).toBeNull();
			expect(screen.getByRole('heading', { name: 'Anthropic Providers' })).toBeTruthy();
			expect(screen.getByText('Use Anthropic Messages-compatible endpoints with Claude Code and Direct.')).toBeTruthy();
			expect(screen.getByRole('heading', { name: 'OpenAI Providers' })).toBeTruthy();
			expect(screen.getByText('Use OpenAI-compatible endpoints with Direct and Codex. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.')).toBeTruthy();
				expect(screen.getByRole('heading', { name: 'Other Harnesses' })).toBeTruthy();
				expect(screen.getByText('Chat horizontal margins')).toBeTruthy();
				expect(screen.queryByText('Direct (Anthropic)')).toBeNull();
			expect(screen.queryByText('Direct (Chat Completions)')).toBeNull();
			expect(screen.queryByText('Direct (Responses)')).toBeNull();
			expect(screen.getByText('These settings are stored in your browser.')).toBeTruthy();
			expect(screen.getByText('These settings are stored on the garcon server.')).toBeTruthy();
		} finally {
			vi.useFakeTimers();
			appShell.closeSettings();
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});
});
