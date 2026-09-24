import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { localExecutionNode, remoteExecutionNode } from '$lib/execution-nodes/__tests__/fixtures';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
import { makeTestGhCapability } from './gh-capability-test-context';

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
	getAgentAuthLoginStatus: vi.fn(),
	completeAgentAuthLogin: vi.fn(),
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
	it('reports recovery cleanup failures and allows retry without concurrent cleanup', async () => {
		const appShell = createAppShellStore();
		appShell.openAppSettings();
		const pending = Promise.withResolvers<boolean>();
		const onClearRecovery = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(true);
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const rendered = render(SettingsTestHost, {
			appShell,
			remoteSettings: new RemoteSettingsStore(),
			onClearRecovery,
		});
		try {
			const button = await screen.findByRole('button', { name: 'Clear recovery data' });
			await fireEvent.click(button);
			expect(button.hasAttribute('disabled')).toBe(true);
			pending.reject(new Error('storage unavailable'));
			await screen.findByText('Could not clear file recovery data. Try again.');
			expect(button.hasAttribute('disabled')).toBe(false);
			await fireEvent.click(button);
			await screen.findByText('Stored file drafts cleared.');
			expect(onClearRecovery).toHaveBeenCalledTimes(2);
		} finally {
			rendered.unmount();
			report.mockRestore();
		}
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(settingsApi.getRemoteSettings).mockReturnValue(new Promise(() => {}));
		vi.mocked(providersApi.getAgentAuthStatus).mockResolvedValue({
			authenticated: false,
			canReauth: true,
			label: '',
		});
		vi.mocked(providersApi.getAgentReadiness).mockResolvedValue({});
		vi.mocked(providersApi.getAgentAuthLoginStatus).mockResolvedValue({ state: 'idle', running: false });
	});

	it('separates server and app settings while preserving their controls', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const appShell = createAppShellStore();
		appShell.openSettings('general');
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
			expect(screen.getByRole('dialog', { name: 'Server Settings' })).toBeTruthy();
			expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('vertical');
			expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual([
				'Execution Nodes', 'Providers', 'Other Agents', 'GitHub', 'General',
			]);
			expect(screen.getByRole('tab', { name: 'Providers' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Other Agents' })).toBeTruthy();
			expect(screen.queryByRole('tab', { name: 'Shortcuts' })).toBeNull();
			expect(screen.queryByText('GitHub CLI')).toBeNull();
			expect(appShell.settingsTab).toBe('general');

			await fireEvent.click(screen.getByRole('tab', { name: 'Execution Nodes' }));
			expect(screen.getByRole('button', { name: 'Add Node' })).toBeTruthy();
			expect(screen.getAllByRole('dialog')).toHaveLength(1);
			await fireEvent.click(screen.getByRole('button', { name: 'Add Node' }));
			await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'Unsaved node' } });
			await fireEvent.click(screen.getByRole('tab', { name: 'General' }));
			await fireEvent.click(screen.getByRole('tab', { name: 'Execution Nodes' }));
			await fireEvent.click(screen.getByRole('button', { name: 'Add Node' }));
			expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('');

			await fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
			expect(appShell.settingsTab).toBe('providers');
			expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
			expect(screen.getByRole('heading', { name: 'Native Providers' })).toBeTruthy();
			expect(screen.getByRole('heading', { name: 'Custom Providers' })).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Local' })).toBeNull();
			expect(screen.queryByRole('combobox', { name: 'Execution node' })).toBeNull();
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
			expect(screen.getByRole('heading', { name: 'Other Agents' })).toBeTruthy();
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

			await fireEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
			expect(screen.getByText('Connected as octocat@github.com')).toBeTruthy();
			expect(screen.queryByRole('heading', { name: 'Local' })).toBeNull();
			expect(screen.queryByRole('combobox')).toBeNull();

			appShell.openAppSettings();
			const titlebarSize = await screen.findByRole('slider', { name: 'Titlebar size adjustment' });
			expect(screen.getByRole('dialog', { name: 'App Settings' })).toBeTruthy();
			expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['General', 'Shortcuts']);
			expect(appShell.appSettingsTab).toBe('general');
			expect((titlebarSize as HTMLInputElement).value).toBe('0');
			await fireEvent.input(titlebarSize, { target: { value: '6' } });
			expect(onLocalSet).toHaveBeenCalledWith('workspaceWindowTitlebarHeightDeltaPx', 6);
			expect(screen.getByText('+6 px').getAttribute('for')).toBe('local-workspace-titlebar-size');
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
			const combineToolUses = screen.getByRole('switch', { name: 'Combine tool use messages' });
			expect(combineToolUses.getAttribute('aria-checked')).toBe('true');
			await fireEvent.click(combineToolUses);
			expect(combineToolUses.getAttribute('aria-checked')).toBe('false');
			expect(onLocalToggle).toHaveBeenCalledWith('combineToolUseMessages');
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
			expect(screen.queryByText('Compact')).toBeNull();
			expect(screen.queryByText('Direct (Anthropic)')).toBeNull();
			expect(screen.queryByText('Direct (Chat Completions)')).toBeNull();
			expect(screen.queryByText('Direct (Responses)')).toBeNull();
			expect(screen.queryByRole('switch', { name: 'Send by Shift+Enter' })).toBeNull();

			await fireEvent.click(screen.getByRole('tab', { name: 'Shortcuts' }));
			expect(appShell.appSettingsTab).toBe('shortcuts');
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
			appShell.closeAppSettings();
			rendered.unmount();
			await vi.runAllTimersAsync();
			vi.useRealTimers();
		}
	});

	it('opens the onboarding wizard from App Settings', async () => {
		const appShell = createAppShellStore();
		appShell.openAppSettings();
		const rendered = render(SettingsTestHost, {
			appShell,
			remoteSettings: new RemoteSettingsStore(),
		});

		try {
			await fireEvent.click(screen.getByRole('button', { name: 'Restart setup wizard' }));

			expect(appShell.showOnboardingWizard).toBe(true);
			expect(appShell.showAppSettings).toBe(false);
		} finally {
			appShell.closeOnboardingWizard();
			rendered.unmount();
		}
	});

	it('shows native authentication for every ready node without querying offline nodes', async () => {
		const offline = { ...remoteExecutionNode, id: '33333333-3333-4333-8333-333333333333', label: 'Offline worker', availability: 'offline' as const };
		const appShell = createAppShellStore();
		appShell.openSettings('providers');
		const rendered = render(SettingsTestHost, {
			appShell, remoteSettings: new RemoteSettingsStore(),
			nodes: [localExecutionNode, remoteExecutionNode, offline],
		});
		try {
			for (const node of [localExecutionNode, remoteExecutionNode]) {
				const section = screen.getByRole('region', { name: node.label });
				expect(within(section).getByRole('heading', { name: node.label })).toBeTruthy();
				await waitFor(() => expect(providersApi.getAgentAuthStatus).toHaveBeenCalledWith('claude', node.id));
				expect(providersApi.getAgentAuthStatus).toHaveBeenCalledWith('codex', node.id);
				expect(within(section).getAllByRole('button', { name: 'Sign in' })).toHaveLength(2);
			}
			expect(screen.getByText('Offline worker is unavailable.')).toBeTruthy();
			expect(providersApi.getAgentReadiness).not.toHaveBeenCalledWith(offline.id);
			expect(screen.queryByRole('combobox')).toBeNull();
			vi.mocked(providersApi.launchAgentAuthLogin).mockRejectedValueOnce(new Error('Synthetic login error'));
			await fireEvent.click(within(screen.getByRole('region', { name: 'Worker' })).getAllByRole('button', { name: 'Sign in' })[0]);
			await waitFor(() => expect(providersApi.launchAgentAuthLogin).toHaveBeenCalledWith('claude', remoteExecutionNode.id));
		} finally { rendered.unmount(); }
	});

	it('rechecks native authentication when a ready node snapshot replaces its runtime', async () => {
		const nodes = [localExecutionNode, remoteExecutionNode];
		const nodeStore = new ExecutionNodesStore(async () => nodes);
		nodeStore.applySnapshot(nodes);
		const appShell = createAppShellStore();
		appShell.openSettings('providers');
		const auth = { authenticated: true, canReauth: true, label: 'Initial account' };
		vi.mocked(providersApi.getAgentAuthStatus).mockResolvedValue(auth);
		const rendered = render(SettingsTestHost, {
			appShell, remoteSettings: new RemoteSettingsStore(), nodeStore,
		});
		try {
			const worker = within(screen.getByRole('region', { name: remoteExecutionNode.label }));
			await worker.findAllByText('Initial account');
			vi.mocked(providersApi.getAgentAuthStatus).mockResolvedValue({ ...auth, label: 'Replacement account' });
			nodeStore.applySnapshot([localExecutionNode, { ...remoteExecutionNode, instanceId: 'replacement-runtime' }]);
			await worker.findAllByText('Replacement account');
			expect(worker.queryByText('Initial account')).toBeNull();
		} finally { rendered.unmount(); }
	});

	it('preserves an entered OAuth code when another node changes availability', async () => {
		const nodes = [localExecutionNode, remoteExecutionNode];
		const nodeStore = new ExecutionNodesStore(async () => nodes);
		nodeStore.applySnapshot(nodes);
		const appShell = createAppShellStore();
		appShell.openSettings('providers');
		const deviceAuth = { url: 'https://example.test/authorize', needsCode: true };
		vi.mocked(providersApi.launchAgentAuthLogin).mockResolvedValue({
			launched: true, alreadyRunning: false, sessionId: 'synthetic-login', deviceAuth,
		});
		const rendered = render(SettingsTestHost, {
			appShell, remoteSettings: new RemoteSettingsStore(), nodeStore,
		});
		try {
			const local = within(screen.getByRole('region', { name: 'Local' }));
			const signIn = await local.findAllByRole('button', { name: 'Sign in' });
			await fireEvent.click(signIn[0]);
			const input = await local.findByRole('textbox');
			await fireEvent.input(input, { target: { value: 'synthetic-oauth-code' } });
			vi.mocked(providersApi.getAgentAuthLoginStatus).mockImplementation(async (agentId, _sessionId, nodeId) => {
				if (agentId === 'claude' && nodeId === 'local') {
					return { state: 'running', running: true, sessionId: 'synthetic-login', deviceAuth };
				}
				return { state: 'idle', running: false };
			});
			vi.mocked(providersApi.getAgentAuthStatus).mockClear();
			nodeStore.applySnapshot([{ ...localExecutionNode }, { ...remoteExecutionNode, availability: 'offline' }]);
			await screen.findByText('Worker is unavailable.');
			expect((local.getByRole('textbox') as HTMLInputElement).value).toBe('synthetic-oauth-code');
			expect(providersApi.getAgentAuthStatus).not.toHaveBeenCalledWith('claude', 'local');
			expect(providersApi.getAgentAuthStatus).not.toHaveBeenCalledWith('codex', 'local');
		} finally { rendered.unmount(); }
	});

	it('shows and refreshes GitHub status per node independently of server settings loading', async () => {
		const remote = { ...remoteExecutionNode, machineServices: { ...remoteExecutionNode.machineServices, git: true, gh: true } };
		const localStatus = makeTestGhCapability();
		const remoteStatus = makeTestGhCapability({ available: false, authenticated: false, reason: 'unauthenticated', login: null, host: null, refresh: vi.fn(async () => {}) });
		const appShell = createAppShellStore();
		appShell.openSettings('github');
		const rendered = render(SettingsTestHost, {
			appShell, remoteSettings: new RemoteSettingsStore(), nodes: [localExecutionNode, remote],
			ghCapability: { forNode: (id) => id === 'local' ? localStatus : remoteStatus },
		});
		try {
			expect(within(screen.getByRole('region', { name: 'Local' })).getByText('Connected as octocat@github.com')).toBeTruthy();
			const worker = within(screen.getByRole('region', { name: 'Worker' }));
			expect(worker.getByText('gh auth login')).toBeTruthy();
			await fireEvent.click(worker.getByRole('button', { name: 'Refresh GitHub CLI status' }));
			expect(remoteStatus.refresh).toHaveBeenCalledOnce();
			expect(screen.queryByRole('combobox')).toBeNull();
		} finally { rendered.unmount(); }
	});
});
