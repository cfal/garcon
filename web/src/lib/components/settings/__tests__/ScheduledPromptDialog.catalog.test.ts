import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { createExecutorStartupFixture, executorStartupSnapshot } from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import { remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { AppShellStore } from '$lib/stores/app-shell.svelte';
import { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte';
import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte';
import type { ChatListEntry } from '$shared/chat-list';
import type { ScheduledPrompt } from '$shared/scheduled-prompts';
import ScheduledPromptDialog from '../ScheduledPromptDialog.svelte';
import { expandSnippet } from '$lib/api/snippets';

vi.mock('$lib/api/snippets', () => ({ expandSnippet: vi.fn() }));

const snippet = { id: 'synthetic-snippet', shortName: 'command', template: 'printf example',
	defaultArguments: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

let deps: ReturnType<typeof createExecutorStartupFixture>;
let sessions: ChatSessionsStore;
let settings: LocalSettingsStore;
vi.mock('$lib/context', async (original) => ({
	...await original<typeof import('$lib/context')>(),
	getModelCatalog: () => deps.modelCatalog,
	getExecutors: () => deps.executors,
	getRemoteSettings: () => deps.remoteSettings,
	getLocalSettings: () => settings,
	getChatSessions: () => sessions,
	getAppShell: () => new AppShellStore(),
	getSnippets: () => createSnippetsStore({ get: async () => ({ revision: 1, snippets: [snippet] }) }),
	getPreambles: () => createPreamblesStore({ get: async () => ({ revision: 0, preambles: [] }) }),
}));
vi.mock('../ScheduledNewChatComposer.svelte', async () => import('./ScheduledPromptDialogTestStub.svelte'));

afterEach(() => { cleanup(); settings?.destroy(); vi.restoreAllMocks(); });

function renderExistingSchedule() {
	localStorage.clear();
	deps = createExecutorStartupFixture();
	const snapshot = executorStartupSnapshot();
	snapshot.recentAgentSettings.reverse();
	deps.remoteSettings.applySnapshot(snapshot);
	settings = new LocalSettingsStore();
	sessions = new ChatSessionsStore();
	const chat = {
		id: '1791420000000010', agentId: 'claude', executorId: remoteExecutor.id,
		model: 'worker-default', title: 'Synthetic remote chat', projectPath: '/workspace',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		orderGroup: 'normal', tags: [], permissionMode: 'default', thinkingMode: 'none',
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null }, preview: { lastMessage: '' },
		isPinned: false, isArchived: false, isActive: false, isProcessing: false, processingPhase: null,
		isUnread: false, canReloadFromNativeHistory: false, parentChat: null, agentOwnershipEpoch: 'epoch-1',
	} satisfies ChatListEntry;
	sessions.upsertFromServer([chat]);
	const prompt: ScheduledPrompt = {
		id: 'synthetic-schedule', prompt: '  echo {{chat_id}}  \n',
		schedule: { type: 'once', nextRunAt: '2099-01-02T09:00:00.000Z' },
		createdAt: '2029-01-01T00:00:00.000Z', updatedAt: '2029-01-01T00:00:00.000Z',
		target: { type: 'existing-chat', chatId: chat.id, busyBehavior: 'queue' },
	};
	const onSave = vi.fn();
	render(ScheduledPromptDialog, { open: true, scheduledPrompt: prompt,
		currentTime: new Date('2099-01-01T00:00:00.000Z'), onSave, onClose: vi.fn() });
	return { prompt, onSave };
}

it('allows cold existing remote schedules without waiting for inventory and retains literal template controls', async () => {
	const { prompt, onSave } = renderExistingSchedule();
	const metadata = deps.remoteCatalog.agentMetadata;
	metadata.claude!.executionPolicy = 'literal';
	deps.remoteCatalog.agentMetadata = {};
	deps.remoteCatalog.lastValidatedAt = null;
	const discovery = Promise.withResolvers<void>();
	vi.mocked(deps.remoteCatalog.refreshIfStale).mockImplementation(async () => {
		await discovery.promise;
		deps.remoteCatalog.agentMetadata = metadata;
		deps.remoteCatalog.lastValidatedAt = Date.now();
	});
	await waitFor(() => expect(deps.remoteCatalog.refreshIfStale).toHaveBeenCalled());
	const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save Prompt' });
	expect(save.disabled).toBe(false);
	await fireEvent.click(save);
	expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ prompt: prompt.prompt }));
	discovery.resolve();
	await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Prompt' }).disabled).toBe(false));
	expect(screen.getByRole('button', { name: 'Insert {{chat_id}}' })).toBeTruthy();
	expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' }).value).toBe(prompt.prompt);
});

it('cancels pending scheduled snippets when the same target changes execution policy', async () => {
	const { prompt } = renderExistingSchedule();
	const pending = Promise.withResolvers<Awaited<ReturnType<typeof expandSnippet>>>();
	vi.mocked(expandSnippet).mockReturnValueOnce(pending.promise);
	await screen.findByRole('textbox', { name: 'Prompt' });
	await fireEvent.click(screen.getByRole('button', { name: 'Insert Snippet' }));
	await fireEvent.click(await screen.findByRole('option', { name: /^command/ }));
	await waitFor(() => expect(expandSnippet).toHaveBeenCalledOnce());
	deps.remoteCatalog.agentMetadata.claude!.executionPolicy = 'literal';
	await waitFor(() => expect(vi.mocked(expandSnippet).mock.calls[0][1]?.signal?.aborted).toBe(true));
	pending.resolve({ success: true, source: 'snippet', sourceId: snippet.id, sourceUpdatedAt: snippet.updatedAt,
		shortName: snippet.shortName, contextExecutorId: remoteExecutor.id, contextProjectPath: '/workspace',
		expandedText: 'Must not replace the command draft' });
	await pending.promise;
	const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' });
	expect(input.value).toBe(prompt.prompt);
	expect(input.readOnly).toBe(false);
});
