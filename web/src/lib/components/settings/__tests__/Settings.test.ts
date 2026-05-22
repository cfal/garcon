import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
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
    vi.mocked(settingsApi.getRemoteSettings).mockReturnValue(new Promise(() => { }));
    vi.mocked(providersApi.getHarnessAuthStatus).mockResolvedValue({
      authenticated: false,
      canReauth: true,
      label: '',
    });
    vi.mocked(providersApi.getHarnessReadiness).mockResolvedValue({});
  });

  it('renders a tabbed layout with providers, harnesses, local, and remote settings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const appShell = createAppShellStore();
    appShell.openSettings('remote');
    const remoteSettings = new RemoteSettingsStore();
    const refreshSpy = vi.spyOn(remoteSettings, 'refreshInBackground').mockResolvedValue();

    const rendered = render(SettingsTestHarness, { appShell, remoteSettings });

    try {
      await waitFor(() => {
        expect(refreshSpy).toHaveBeenCalled();
      });
      expect(screen.getByRole('tablist')).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Providers' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Other Harnesses' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Local Settings' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Remote Settings' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Remote Settings' })).toBeNull();
      expect(screen.getByText('These settings are stored on the garcon server.')).toBeTruthy();
      expect(appShell.settingsTab).toBe('remote');

      await fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
      expect(appShell.settingsTab).toBe('providers');
      expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
      expect(screen.getByText('Provider configuration for Claude Code, Codex, and Direct Chat.')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'API Providers' })).toBeNull();
      const openAiHeading = screen.getByRole('heading', { name: 'OpenAI Providers' });
      const anthropicHeading = screen.getByRole('heading', { name: 'Anthropic Providers' });
      expect(openAiHeading).toBeTruthy();
      expect(anthropicHeading).toBeTruthy();
      expect(openAiHeading.compareDocumentPosition(anthropicHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText('Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.')).toBeTruthy();
      expect(screen.getByText('Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.')).toBeTruthy();

      await fireEvent.click(screen.getByRole('tab', { name: 'Other Harnesses' }));
      expect(appShell.settingsTab).toBe('other-harnesses');
      expect(screen.queryByRole('heading', { name: 'Other Harnesses' })).toBeNull();
      expect(screen.getByText('These harnesses manage providers and authentication internally.')).toBeTruthy();
	      const otherHarnessNames = ['Amp', 'Cursor', 'Factory', 'OpenCode', 'Pi'].map((name) => screen.getByText(name));
	      expect(otherHarnessNames[0].compareDocumentPosition(otherHarnessNames[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	      expect(otherHarnessNames[1].compareDocumentPosition(otherHarnessNames[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	      expect(otherHarnessNames[2].compareDocumentPosition(otherHarnessNames[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	      expect(otherHarnessNames[3].compareDocumentPosition(otherHarnessNames[4]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText('Pi')).toBeTruthy();
      expect(screen.getByText('pi')).toBeTruthy();

      await fireEvent.click(screen.getByRole('tab', { name: 'Local Settings' }));
      expect(appShell.settingsTab).toBe('local');
      expect(screen.queryByRole('heading', { name: 'Local Settings' })).toBeNull();
      expect(screen.getByText('Max chat width')).toBeTruthy();
      expect(screen.queryByText('Direct (Anthropic)')).toBeNull();
      expect(screen.queryByText('Direct (Chat Completions)')).toBeNull();
      expect(screen.queryByText('Direct (Responses)')).toBeNull();
      expect(screen.getByText('These settings are stored in your browser.')).toBeTruthy();
    } finally {
      appShell.closeSettings();
      rendered.unmount();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
});
