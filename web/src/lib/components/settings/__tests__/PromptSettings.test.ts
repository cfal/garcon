import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { AppShellStore } from '$lib/stores/app-shell.svelte';
import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte';
import { ScheduledPromptsStore } from '$lib/scheduling/scheduled-prompts-store.svelte';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { makeRemoteSettingsSnapshot } from '$lib/stores/__tests__/remote-settings-snapshot-fixture';
import type { Preamble } from '$shared/preambles';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';
import PromptSettingsTestHost from './PromptSettingsTestHost.svelte';

vi.mock('$lib/api/chats.js', () => ({
	validateStart: vi.fn(async () => ({ valid: true, isGitRepo: true })),
}));
vi.mock('$lib/api/chat-preambles.js', () => ({
	preambleSelectionPreview: vi.fn(async () => ({
		canonicalProjectPath: '/workspace/project',
		orderedPreambleIds: ['preamble-a'],
		projection: {
			catalogRevision: 1,
			eligiblePreambles: [{ id: 'preamble-a', title: 'Repository conventions' }],
			unavailable: [],
		},
	})),
}));

const preamble: Preamble = {
	id: 'preamble-a',
	title: 'Repository conventions',
	content: 'Keep changes scoped.',
	enabled: true,
	scope: { type: 'global' },
	agentIds: [],
	tagFilter: { mode: 'all', tags: [] },
	createdAt: '2030-01-01T00:00:00.000Z',
	updatedAt: '2030-01-01T00:00:00.000Z',
};
const prompt: ScheduledPrompt = {
	id: 'prompt-a',
	prompt: 'Original prompt',
	schedule: { type: 'once', nextRunAt: '2099-01-02T09:00:00.000Z' },
	target: {
		type: 'new-chat',
		agentId: 'claude',
		projectPath: '/workspace/project',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettingsById: {},
		tags: [],
		preambleChoice: { mode: 'explicit', orderedPreambleIds: ['preamble-a'] },
	},
	createdAt: '2030-01-01T00:00:00.000Z',
	updatedAt: '2030-01-01T00:00:00.000Z',
};

function setup(tab = 'preambles') {
	const appShell = new AppShellStore();
	const loadPreambles = vi.fn(async () => ({ revision: 1, preambles: [preamble] }));
	const loadSnippets = vi.fn(async () => ({ revision: 1, snippets: [] }));
	const loadPrompts = vi.fn(async () => ({ revision: 1, prompts: [prompt], runLog: [] }));
	const preambles = new PreamblesStore({ get: loadPreambles });
	const snippets = new SnippetsStore({ get: loadSnippets });
	const scheduledPrompts = new ScheduledPromptsStore({ get: loadPrompts });
	const remoteSettings = new RemoteSettingsStore();
	remoteSettings.applySnapshot(makeRemoteSettingsSnapshot());
	vi.spyOn(remoteSettings, 'refreshInBackground').mockResolvedValue();
	appShell.openSettings(tab);
	const rendered = render(PromptSettingsTestHost, {
		appShell,
		preambles,
		snippets,
		scheduledPrompts,
		remoteSettings,
	});
	return { ...rendered, appShell, preambles, loadPreambles, loadSnippets, loadPrompts };
}

describe('prompt management in Settings', () => {
	it('loads only the selected catalog and hosts each section in the same dialog', async () => {
		const { appShell, loadPreambles, loadSnippets, loadPrompts } = setup();
		const settings = screen.getByRole('dialog', { name: 'Settings' });
		await screen.findByRole('heading', { name: 'Repository conventions' }, { timeout: 10_000 });
		expect(loadPreambles).toHaveBeenCalledOnce();
		expect(loadSnippets).not.toHaveBeenCalled();
		expect(loadPrompts).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('tab', { name: 'Snippets' }));
		await screen.findByRole('button', { name: 'Add snippet' }, { timeout: 10_000 });
		expect(loadSnippets).toHaveBeenCalledOnce();
		expect(screen.queryByRole('heading', { name: 'Repository conventions' })).toBeNull();
		await fireEvent.click(screen.getByRole('tab', { name: 'Scheduled Prompts' }));
		await screen.findByRole('heading', { name: 'Original prompt' }, { timeout: 10_000 });
		expect(loadPrompts).toHaveBeenCalledOnce();
		expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(settings);
		expect(screen.getAllByRole('dialog')).toHaveLength(1);
		await fireEvent.click(within(settings).getByRole('button', { name: 'Close' }));
		expect(appShell.showSettings).toBe(false);
	}, 30_000);

	it('restores picker and editor openers without a catalog visit', async () => {
		setup('scheduled-prompts');
		const editPrompt = await screen.findByRole('button', { name: 'Edit prompt' }, { timeout: 10_000 });
		editPrompt.focus();
		await fireEvent.click(editPrompt);
		const editor = await screen.findByRole('dialog', { name: 'Edit Scheduled Prompt' });
		const editPreambles = within(editor).getByRole('button', { name: 'Edit preambles' });
		await waitFor(() => expect(editPreambles.hasAttribute('disabled')).toBe(false));
		editPreambles.focus();
		await fireEvent.click(editPreambles);
		const picker = await screen.findByRole('dialog', { name: 'Chat preambles' });
		await fireEvent.click(within(picker).getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(document.activeElement).toBe(editPreambles));
		await fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(document.activeElement).toBe(editPrompt));
	}, 30_000);

	it.each(['close', 'back', 'tab', 'escape'] as const)(
		'preserves the scheduled editor and unapplied picker draft through %s',
		async (returnAction) => {
			const { appShell } = setup('scheduled-prompts');
			const editPrompt = await screen.findByRole('button', { name: 'Edit prompt' }, { timeout: 10_000 });
			editPrompt.focus();
			await fireEvent.click(editPrompt);
			const editor = await screen.findByRole('dialog', { name: 'Edit Scheduled Prompt' });
			const promptInput = await within(editor).findByRole('textbox', { name: 'Prompt' });
			await waitFor(() =>
				expect((promptInput as HTMLTextAreaElement).value).toBe('Original prompt'),
			);
			await fireEvent.input(promptInput, { target: { value: 'Unsaved scheduled draft' } });
			const editPreambles = within(editor).getByRole('button', { name: 'Edit preambles' });
			await waitFor(() => expect(editPreambles.hasAttribute('disabled')).toBe(false));
			editPreambles.focus();
			await fireEvent.click(editPreambles);
			const picker = await screen.findByRole('dialog', { name: 'Chat preambles' });
			await fireEvent.click(
				await within(picker).findByRole('switch', { name: 'Remove Repository conventions' }),
			);
			await fireEvent.click(within(picker).getByRole('button', { name: 'Manage preambles' }));
			await screen.findByRole('heading', { name: 'Repository conventions' }, { timeout: 10_000 });
			expect(appShell.settingsTab).toBe('preambles');
			expect(editor.isConnected).toBe(true);
			expect(editor.style.display).toBe('none');
			expect(screen.queryByRole('dialog', { name: 'Edit Scheduled Prompt' })).toBeNull();
			await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chat preambles' })).toBeNull());
			const settings = screen.getByRole('dialog', { name: 'Settings' });
			if (returnAction === 'close')
				await fireEvent.click(within(settings).getByRole('button', { name: 'Close' }));
			else if (returnAction === 'back')
				await fireEvent.click(screen.getByRole('button', { name: 'Back to scheduled prompt' }));
			else if (returnAction === 'tab')
				await fireEvent.click(screen.getByRole('tab', { name: 'Scheduled Prompts' }));
			else await fireEvent.keyDown(window, { key: 'Escape' });
			const restoredPicker = await screen.findByRole('dialog', { name: 'Chat preambles' });
			expect(appShell.showSettings).toBe(true);
			expect(appShell.settingsTab).toBe('scheduled-prompts');
			expect(promptInput.isConnected).toBe(true);
			expect((promptInput as HTMLTextAreaElement).value).toBe('Unsaved scheduled draft');
			expect(
				within(restoredPicker).queryByRole('switch', { name: 'Remove Repository conventions' }),
			).toBeNull();
			await waitFor(() =>
				expect(document.activeElement).toBe(
					within(restoredPicker).getByRole('button', { name: 'Manage preambles' }),
				),
			);
			await fireEvent.click(within(restoredPicker).getByRole('button', { name: 'Manage preambles' }));
			await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Chat preambles' })).toBeNull());
			expect(appShell.settingsTab).toBe('preambles');
			expect(appShell.scheduledPromptSuspended).toBe(true);
			await fireEvent.click(screen.getByRole('button', { name: 'Back to scheduled prompt' }));
			const finalPicker = await screen.findByRole('dialog', { name: 'Chat preambles' });
			await fireEvent.click(within(finalPicker).getByRole('button', { name: 'Apply' }));
			await waitFor(() => expect(document.activeElement).toBe(editPreambles));
			expect(appShell.settingsTab).toBe('scheduled-prompts');
			expect(promptInput.isConnected).toBe(true);
			expect((promptInput as HTMLTextAreaElement).value).toBe('Unsaved scheduled draft');
			await fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
			await waitFor(() => expect(document.activeElement).toBe(editPrompt));
		},
		30_000,
	);
});
