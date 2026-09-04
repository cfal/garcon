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

vi.mock('$lib/notifications/completion-sound.js', () => ({
	CUSTOM_COMPLETION_SOUND_ACCEPT: '.mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg',
	playCompletionSound: vi.fn(),
	removeCustomCompletionSound: vi.fn(),
	storeCustomCompletionSound: vi.fn(),
	unlockCompletionSound: vi.fn(),
	validateCustomCompletionSound: vi.fn(() => null),
}));

const settingsApi = await import('$lib/api/settings.js');
const providersApi = await import('$lib/api/agents.js');
const completionSound = await import('$lib/notifications/completion-sound.js');
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
			const remoteTab = screen.getByRole('tab', { name: 'Remote Settings' });
			const localTab = screen.getByRole('tab', { name: 'Local Settings' });
			expect(
				remoteTab.compareDocumentPosition(localTab) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Shortcuts' })).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Remote Settings' })).toBeNull();
			expect(
				screen.getByText(
					'These settings are stored on the garcon server, except where a card notes browser-local storage.',
				),
			).toBeTruthy();
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
			expect(screen.queryByRole('combobox', { name: 'Chat list position' })).toBeNull();
			expect(screen.getByText('Max chat width')).toBeTruthy();
			const inactivityDuration = screen.getByRole('combobox', {
				name: 'Inactivity duration',
			});
			expect((inactivityDuration as HTMLSelectElement).value).toBe('3-days');
			expect(screen.getByText('Used when grouping chat items by activity.')).toBeTruthy();
			for (const label of [
				'2 days',
				'3 days',
				'4 days',
				'5 days',
				'1 week',
				'2 weeks',
				'1 month',
				'2 months',
				'3 months',
			]) {
				expect(screen.getByRole('option', { name: label })).toBeTruthy();
			}
			await fireEvent.change(inactivityDuration, { target: { value: '2-weeks' } });
			expect(onLocalSet).toHaveBeenCalledWith('sidebarInactivityDuration', '2-weeks');
			const alwaysExpandCliMessages = screen.getByRole('switch', {
				name: 'Always expand CLI messages',
			});
			expect(alwaysExpandCliMessages.getAttribute('aria-checked')).toBe('false');
			expect(
				screen.getByText('Keeps collapsible CLI rows and CLI user messages expanded.'),
			).toBeTruthy();
			await fireEvent.click(alwaysExpandCliMessages);
			expect(onLocalToggle).toHaveBeenCalledWith('alwaysExpandCliMessages');
			const allowDirectChats = screen.getByRole('switch', { name: 'Allow direct chats' });
			expect(allowDirectChats.getAttribute('aria-checked')).toBe('false');
			expect(
				screen.getByText(
					'Enables chat sessions directly against configured LLM APIs. These sessions are not connected to a project and cannot read or modify your filesystem.',
				),
			).toBeTruthy();
			await fireEvent.click(allowDirectChats);
			expect(onLocalToggle).toHaveBeenCalledWith('allowDirectChats');
			const reduceMotion = screen.getByRole('switch', { name: 'Reduce motion' });
			expect(reduceMotion.getAttribute('aria-checked')).toBe('false');
			await fireEvent.click(reduceMotion);
			expect(onLocalToggle).toHaveBeenCalledWith('reduceMotion');
			expect(screen.getByText('Hide tool calls')).toBeTruthy();
			expect(screen.getByRole('switch', { name: 'Bash' })).toBeTruthy();
			expect(screen.getByRole('switch', { name: 'Exec' })).toBeTruthy();
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
			expect(screen.getByText('Task completion sound')).toBeTruthy();
			const completionSoundMode = screen.getByRole('combobox', { name: 'Sound' });
			expect((completionSoundMode as HTMLSelectElement).value).toBe('off');
			expect(screen.getByRole('option', { name: 'Custom' }).hasAttribute('disabled')).toBe(true);
			await fireEvent.change(completionSoundMode, { target: { value: 'default' } });
			expect(onLocalSet).toHaveBeenCalledWith('completionSoundMode', 'default');
			expect(completionSound.unlockCompletionSound).toHaveBeenCalledOnce();
			await fireEvent.click(screen.getByRole('button', { name: 'Test sound' }));
			expect(completionSound.playCompletionSound).toHaveBeenCalledWith(
				expect.objectContaining({ mode: 'default', visibility: 'always' }),
				{ force: true },
			);
			expect(screen.getByText('File opening')).toBeTruthy();
			const textEditorPlacement = screen.getByRole('combobox', { name: 'Text editors' });
			const imageViewerPlacement = screen.getByRole('combobox', { name: 'Image viewers' });
			const markdownViewerPlacement = screen.getByRole('combobox', {
				name: 'Markdown viewers',
			});
			expect(screen.getAllByRole('option', { name: 'Same window' })).toHaveLength(3);
			expect(screen.getAllByRole('option', { name: 'New window' })).toHaveLength(3);
			expect(screen.getAllByRole('option', { name: 'Dialog' })).toHaveLength(3);
			expect((textEditorPlacement as HTMLSelectElement).value).toBe('same-window');
			expect((imageViewerPlacement as HTMLSelectElement).value).toBe('same-window');
			expect((markdownViewerPlacement as HTMLSelectElement).value).toBe('same-window');
			await fireEvent.change(textEditorPlacement, { target: { value: 'new-window' } });
			await fireEvent.change(imageViewerPlacement, { target: { value: 'new-window' } });
			await fireEvent.change(markdownViewerPlacement, { target: { value: 'dialog' } });
			expect(onLocalSet).toHaveBeenCalledWith('textEditorOpenPlacement', 'new-window');
			expect(onLocalSet).toHaveBeenCalledWith('imageViewerOpenPlacement', 'new-window');
			expect(onLocalSet).toHaveBeenCalledWith('markdownViewerOpenPlacement', 'dialog');
			await fireEvent.change(textEditorPlacement, { target: { value: 'same-window' } });
			await fireEvent.change(imageViewerPlacement, { target: { value: 'same-window' } });
			await fireEvent.change(markdownViewerPlacement, { target: { value: 'same-window' } });
			expect(onLocalSet).toHaveBeenCalledWith('textEditorOpenPlacement', 'same-window');
			expect(onLocalSet).toHaveBeenCalledWith('imageViewerOpenPlacement', 'same-window');
			expect(onLocalSet).toHaveBeenCalledWith('markdownViewerOpenPlacement', 'same-window');
			expect(screen.queryByText('Chat grouping')).toBeNull();
			expect(screen.queryByText('Combine nested paths')).toBeNull();
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
			expect(screen.queryByRole('switch', { name: 'Send by Shift+Enter' })).toBeNull();

			await fireEvent.click(screen.getByRole('tab', { name: 'Shortcuts' }));
			expect(appShell.settingsTab).toBe('shortcuts');
			expect(
				screen.getByText(
					'View and customize keyboard shortcuts, or reference composer and slash commands.',
				),
			).toBeTruthy();
			expect(screen.getByText('New chat')).toBeTruthy();
			expect(screen.getByText('Delete selected chat')).toBeTruthy();
			expect(screen.getByText('Scroll up half a page')).toBeTruthy();
			expect(screen.getByText('Scroll down half a page')).toBeTruthy();
			expect(screen.getByText('Send message')).toBeTruthy();
			expect(screen.getByRole('switch', { name: 'Send by Shift+Enter' })).toBeTruthy();
			expect(screen.getByRole('switch', { name: 'Steer with Ctrl+Enter' })).toBeTruthy();
			expect(screen.getByText('/compact')).toBeTruthy();
			expect(screen.getByText('/fork [<prompt>]')).toBeTruthy();
			expect(screen.getByText('/rename <title>')).toBeTruthy();
			expect(screen.getByText('/move <top|bottom>')).toBeTruthy();
			expect(screen.getByText('/tag <add|rm> <tag> [tag...]')).toBeTruthy();
			expect(screen.getByText('/steer <prompt>')).toBeTruthy();
			expect(screen.getByText('/st <prompt>')).toBeTruthy();
			expect(screen.getByText('/snippet <short-name> [arguments]')).toBeTruthy();
			expect(screen.getByText('/s <short-name> [arguments]')).toBeTruthy();
		} finally {
			appShell.closeSettings();
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});
});
