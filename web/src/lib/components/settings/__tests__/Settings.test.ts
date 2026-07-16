import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

vi.mock('$lib/api/settings.js', () => ({
	beginTelegramRecipientLink: vi.fn(),
	clearTelegramBotToken: vi.fn(),
	clearTelegramRecipient: vi.fn(),
	getRemoteSettings: vi.fn(),
	resolveTelegramRecipientLink: vi.fn(),
	saveTelegramBotToken: vi.fn(),
	updateRemoteSettings: vi.fn(),
	sendTelegramTest: vi.fn(),
	testTelegramBotToken: vi.fn(),
}));

vi.mock('$lib/api/agents.js', () => ({
	getAgentAuthStatus: vi.fn(),
	getAgentReadiness: vi.fn(),
	launchAgentAuthLogin: vi.fn(),
}));

const settingsApi = await import('$lib/api/settings.js');
const providersApi = await import('$lib/api/agents.js');
const SettingsTestHost = (await import('./SettingsTestHost.svelte')).default;

describe('Settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValue(new Promise(() => {}));
		vi.mocked(providersApi.getAgentAuthStatus).mockResolvedValue({
			authenticated: false,
			canReauth: true,
			label: '',
		});
		vi.mocked(providersApi.getAgentReadiness).mockResolvedValue({});
	});

	it('renders a tabbed layout with providers, agents, local, and remote settings', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const appShell = createAppShellStore();
		appShell.openSettings('remote');
		const remoteSettings = new RemoteSettingsStore();
		const refreshSpy = vi.spyOn(remoteSettings, 'refreshInBackground').mockResolvedValue();
		const onLocalSet = vi.fn();
		const onLocalToggle = vi.fn();

		const rendered = render(SettingsTestHost, {
			appShell,
			remoteSettings,
			onLocalSet,
			onLocalToggle,
		});

		try {
			await waitFor(() => {
				expect(refreshSpy).toHaveBeenCalled();
			});
			expect(screen.getByRole('tablist')).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Providers' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Other Agents' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Local Settings' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Remote Settings' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Shortcuts' })).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Remote Settings' })).toBeNull();
			expect(screen.getByText('These settings are stored on the garcon server.')).toBeTruthy();
			expect(appShell.settingsTab).toBe('remote');

			await fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
			expect(appShell.settingsTab).toBe('providers');
			expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
			expect(
				screen.getByText('Provider configuration for Claude Code, Codex, and Direct Chat.'),
			).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
			expect(screen.queryByRole('heading', { name: 'API Providers' })).toBeNull();
			const openAiHeading = screen.getByRole('heading', { name: 'OpenAI Providers' });
			const anthropicHeading = screen.getByRole('heading', { name: 'Anthropic Providers' });
			expect(openAiHeading).toBeTruthy();
			expect(anthropicHeading).toBeTruthy();
			expect(
				openAiHeading.compareDocumentPosition(anthropicHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				screen.getByText(
					'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
				),
			).toBeTruthy();
			expect(
				screen.getByText(
					'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
				),
			).toBeTruthy();

			await fireEvent.click(screen.getByRole('tab', { name: 'Other Agents' }));
			expect(appShell.settingsTab).toBe('other-agents');
			expect(screen.queryByRole('heading', { name: 'Other Agents' })).toBeNull();
			expect(
				screen.getByText('These agents manage provider and authentication workflows internally.'),
			).toBeTruthy();
			const otherAgentNames = ['Amp', 'Cursor', 'Factory', 'OpenCode', 'Pi'].map((name) =>
				screen.getByText(name),
			);
			expect(
				otherAgentNames[0].compareDocumentPosition(otherAgentNames[1]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				otherAgentNames[1].compareDocumentPosition(otherAgentNames[2]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				otherAgentNames[2].compareDocumentPosition(otherAgentNames[3]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				otherAgentNames[3].compareDocumentPosition(otherAgentNames[4]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(screen.getByText('Pi')).toBeTruthy();
			expect(screen.getByText('pi')).toBeTruthy();

			await fireEvent.click(screen.getByRole('tab', { name: 'Local Settings' }));
			expect(appShell.settingsTab).toBe('local');
			expect(screen.queryByRole('heading', { name: 'Local Settings' })).toBeNull();
			expect(screen.getByText('Max chat width')).toBeTruthy();
			expect(screen.getByText('Hide tool calls')).toBeTruthy();
			expect(screen.getByText('Command execution (Bash)')).toBeTruthy();
			expect(screen.getByText('File reads and searches')).toBeTruthy();
			expect(screen.getByText('File changes')).toBeTruthy();
			expect(screen.getByText('Web searches and fetches')).toBeTruthy();
			expect(screen.getByText('Tasks and plans')).toBeTruthy();
			expect(screen.getByText('Provider and MCP tools')).toBeTruthy();
			const overlayBackdropEffects = screen.getByRole('switch', {
				name: 'Dim and blur behind overlays',
			});
			expect(overlayBackdropEffects.getAttribute('aria-checked')).toBe('true');
			await fireEvent.click(overlayBackdropEffects);
			expect(onLocalToggle).toHaveBeenCalledWith('overlayBackdropEffects');
			expect(screen.getByText('File opening')).toBeTruthy();
			const textEditorPlacement = screen.getByRole('combobox', { name: 'Text editors' });
			const imageViewerPlacement = screen.getByRole('combobox', { name: 'Image viewers' });
			const markdownViewerPlacement = screen.getByRole('combobox', {
				name: 'Markdown viewers',
			});
			expect(screen.getAllByRole('option', { name: 'Dialog' })).toHaveLength(3);
			expect(screen.getAllByRole('option', { name: 'Main view' })).toHaveLength(3);
			expect(screen.getAllByRole('option', { name: 'Sidebar view' })).toHaveLength(3);
			await fireEvent.change(textEditorPlacement, { target: { value: 'main' } });
			await fireEvent.change(imageViewerPlacement, { target: { value: 'sidebar' } });
			await fireEvent.change(markdownViewerPlacement, { target: { value: 'main' } });
			expect(onLocalSet).toHaveBeenCalledWith('textEditorOpenPlacement', 'main');
			expect(onLocalSet).toHaveBeenCalledWith('imageViewerOpenPlacement', 'sidebar');
			expect(onLocalSet).toHaveBeenCalledWith('markdownViewerOpenPlacement', 'main');
			expect(screen.queryByText('Group chats by project')).toBeNull();
			expect(screen.queryByText('Group nested project paths')).toBeNull();
			expect(
				screen.queryByText(
					'Places chats from nested project folders under the outer project group. Useful for worktrees and monorepos.',
				),
			).toBeNull();
			expect(screen.queryByText('Compact chat items')).toBeNull();
			expect(screen.queryByText('Direct (Anthropic)')).toBeNull();
			expect(screen.queryByText('Direct (Chat Completions)')).toBeNull();
			expect(screen.queryByText('Direct (Responses)')).toBeNull();
			expect(screen.getByText('These settings are stored in your browser.')).toBeTruthy();

			await fireEvent.click(screen.getByRole('tab', { name: 'Shortcuts' }));
			expect(appShell.settingsTab).toBe('shortcuts');
			expect(
				screen.getByText('Keyboard shortcuts and slash commands available across the app.'),
			).toBeTruthy();
			expect(screen.getByText('New chat')).toBeTruthy();
			expect(screen.getByText('Delete selected chat')).toBeTruthy();
			expect(screen.getByText('Send message')).toBeTruthy();
			expect(screen.getByText('/compact')).toBeTruthy();
			expect(screen.getByText('/fork [<prompt>]')).toBeTruthy();
			expect(screen.getByText('/rename <title>')).toBeTruthy();
			expect(screen.getByText('/snippets <short-name> [arguments]')).toBeTruthy();
			expect(screen.getByText('/s <short-name> [arguments]')).toBeTruthy();
		} finally {
			appShell.closeSettings();
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});
});
