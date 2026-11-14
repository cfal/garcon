import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as refinementApi from '$lib/api/prompt-refinement';
import * as settingsApi from '$lib/api/settings';
import * as snippetsApi from '$lib/api/snippets';
import * as navigation from '$lib/chat/actions/chat-navigation.js';
import * as clientChatId from '$shared/client-chat-id';
import NewChatDialogTestHost from './NewChatDialogTestHost.svelte';
import { createAppShellStore } from '$lib/stores/app-shell.svelte';
import { parseChatId } from '$shared/chat-id';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import type { NewChatDialogSeed } from '$lib/chat/new-chat/new-chat-seed';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn().mockResolvedValue({ valid: true, isGitRepo: false }),
}));

vi.mock('$lib/api/chat-preambles', () => ({
	preambleSelectionPreview: vi.fn(async (request: { projectPath: string }) => ({
		success: true,
		canonicalProjectPath: request.projectPath,
		orderedPreambleIds: [],
		projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
	})),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
}));

vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

vi.mock('$lib/api/prompt-refinement', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/prompt-refinement')>();
	return { ...actual, refinePrompt: vi.fn() };
});

vi.mock('$lib/api/snippets', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/snippets')>();
	return { ...actual, expandSnippet: vi.fn() };
});

vi.mock('$lib/chat/actions/chat-navigation.js', () => ({ gotoChat: vi.fn() }));

vi.mock('$shared/client-chat-id', () => ({
	createClientChatId: vi.fn(() => '1787471053739199'),
}));

vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte')).default,
}));

interface DeferredRefinement {
	promise: Promise<RefinePromptResponse>;
	resolve: (value: RefinePromptResponse) => void;
}

function deferredRefinement(): DeferredRefinement {
	let resolve!: (value: RefinePromptResponse) => void;
	const promise = new Promise<RefinePromptResponse>((done) => (resolve = done));
	return { promise, resolve };
}

function makeSnapshot(): RemoteSettingsSnapshot {
	return {
		version: 1,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true, startAgent: true, resumeAgent: true, schedule: true, tickets: true },
		},
		ui: {},
		uiEffective: {},
		paths: {
			pinnedProjectPaths: [],
			browseStartPath: '/workspace',
			recentProjectPaths: ['/workspace'],
		},
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
	};
}

describe('NewChatDialog', () => {
	const scheduledSeed: NewChatDialogSeed = {
		prefill: 'Review 1000000000000001', prospectiveChatId: parseChatId('1000000000000001'),
		startup: { executorId: 'local', agentId: 'claude', projectPath: '/workspace/scheduled',
			model: 'opus', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
			permissionMode: 'acceptEdits', thinkingMode: 'high', tags: ['scheduled'],
			agentSettingsById: { claude: { ownerId: 'claude', schemaVersion: 1, values: {} } },
			preambleChoice: { mode: 'explicit', orderedPreambleIds: [] } },
	};
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
			})),
		);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValue(makeSnapshot());
		vi.mocked(navigation.gotoChat).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
		resetPromptEditorStub();
		vi.mocked(refinementApi.refinePrompt).mockReset();
		vi.mocked(snippetsApi.expandSnippet).mockReset();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('starts with the copied settings and prospective ID only after an explicit edited submission', async () => {
		const onCreateDraft = vi.fn();
		render(NewChatDialogTestHost, { initialSeed: scheduledSeed, onCreateDraft });
		const textarea = document.querySelector('textarea')!;
		await waitFor(() => expect(textarea.value).toBe(scheduledSeed.prefill));
		expect(onCreateDraft).not.toHaveBeenCalled();
		expect(await screen.findByText('/workspace/scheduled', { exact: true })).toBeTruthy();
		await fireEvent.input(textarea, { target: { value: 'Edited 1000000000000001' } });
		const send = screen.getByRole('button', { name: 'Start session' });
		await waitFor(() => expect(send).toHaveProperty('disabled', false));
		await fireEvent.click(send);
		expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining({
			id: scheduledSeed.prospectiveChatId, projectPath: '/workspace/scheduled',
			startup: expect.objectContaining({ executorId: 'local', agentId: 'claude', model: 'opus',
				firstMessage: 'Edited 1000000000000001', permissionMode: 'acceptEdits', thinkingMode: 'high',
				tags: ['scheduled'], orderedPreambleIds: [], initialImages: [] }),
		}));
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
	});

	it('replaces an already-open seed and clears its configuration on a plain request', async () => {
		const shell = createAppShellStore();
		render(NewChatDialogTestHost, { shell, initialSeed: scheduledSeed });
		await waitFor(() => expect(document.querySelector('textarea')?.value).toBe(scheduledSeed.prefill));
		shell.openNewChatDialog({ ...scheduledSeed, prefill: 'Replacement', startup: { ...scheduledSeed.startup!, projectPath: '/workspace/replacement' } });
		await waitFor(() => expect(document.querySelector('textarea')?.value).toBe('Replacement'));
		expect(await screen.findByText('/workspace/replacement', { exact: true })).toBeTruthy();
		shell.openNewChatDialog();
		await waitFor(() => expect(screen.getByRole('button', { name: '/workspace' }).getAttribute('aria-pressed')).toBe('true'));
		expect(document.querySelector('textarea')?.value).not.toBe('Replacement');
	});

	it('retains edited text and its chat ID, but resets startup settings on ordinary reopen', async () => {
		const shell = createAppShellStore();
		const onCreateDraft = vi.fn();
		render(NewChatDialogTestHost, { shell, initialSeed: scheduledSeed, onCreateDraft });
		const edited = `Edited ${scheduledSeed.prefill}`;
		const textarea = await screen.findByPlaceholderText('How can I help you today?');
		await fireEvent.input(textarea, { target: { value: edited } });
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		shell.openNewChatDialog();
		await waitFor(() => expect(screen.getByPlaceholderText('How can I help you today?')).toHaveProperty('value', edited));
		const send = screen.getByRole('button', { name: 'Start session' });
		await waitFor(() => expect(send).toHaveProperty('disabled', false));
		await fireEvent.click(send);
		expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining({
			id: scheduledSeed.prospectiveChatId,
			projectPath: '/workspace',
			startup: expect.objectContaining({
				firstMessage: edited, permissionMode: 'default', thinkingMode: 'none', tags: undefined,
			}),
		}));
		expect(onCreateDraft.mock.calls[0][0].startup.orderedPreambleIds).toBeUndefined();
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
	});

	it('preserves a retained prompt and existing chat when another tab has consumed its ID', async () => {
		const shell = createAppShellStore();
		const sessions = new ChatSessionsStore();
		const onCreateDraft = vi.fn();
		render(NewChatDialogTestHost, { shell, sessions, initialSeed: scheduledSeed, onCreateDraft });
		const edited = `Edited ${scheduledSeed.prefill}`;
		const textarea = await screen.findByPlaceholderText('How can I help you today?');
		await fireEvent.input(textarea, { target: { value: edited } });
		sessions.upsertFromServer([{
			id: scheduledSeed.prospectiveChatId!, agentId: 'claude', model: 'opus',
			title: 'Synthetic existing chat', projectPath: '/workspace', orderGroup: 'normal', tags: [],
			permissionMode: 'default', thinkingMode: 'none', parentChat: null, agentOwnershipEpoch: 'epoch-a',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			activity: { createdAt: null, lastActivityAt: null, lastReadAt: null }, preview: { lastMessage: '' },
			isPinned: false, isArchived: false, isActive: true, isProcessing: false, processingPhase: null,
			isUnread: false, canReloadFromNativeHistory: false,
		}]);
		const existing = sessions.byId[scheduledSeed.prospectiveChatId!];
		const start = screen.getByRole('button', { name: 'Start session' });
		await waitFor(() => expect(start).toHaveProperty('disabled', false));
		await fireEvent.click(start);
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onCreateDraft).not.toHaveBeenCalled();
		expect(navigation.gotoChat).not.toHaveBeenCalled();
		expect(sessions.byId[existing.id]).toEqual(existing);
		expect(shell.newChatDialogOpen).toBe(true);
		expect(textarea).toHaveProperty('value', edited);
		expect(screen.getByText(/chat ID is already in use/)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		shell.openNewChatDialog();
		await waitFor(() => expect(screen.getByPlaceholderText('How can I help you today?')).toHaveProperty('value', edited));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', false));
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(onCreateDraft).not.toHaveBeenCalled();
		expect(clientChatId.createClientChatId).not.toHaveBeenCalled();
		const reopenedTextarea = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(reopenedTextarea, { target: { value: '' } });
		await fireEvent.input(reopenedTextarea, { target: { value: 'Replacement prompt' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining({
			id: '1787471053739199',
			startup: expect.objectContaining({ firstMessage: 'Replacement prompt' }),
		}));
		expect(sessions.byId[existing.id]).toEqual(existing);
	});

	it.each([undefined, scheduledSeed])('retains one prospective ID through snippet expansion, reopen, and Start (seed: %j)', async initialSeed => {
		const onCreateDraft = vi.fn();
		const shell = createAppShellStore();
		const expectedId = initialSeed?.prospectiveChatId ?? '1787471053739199';
		vi.mocked(snippetsApi.expandSnippet).mockImplementationOnce(async (request) => {
			if (request.context.type !== 'new-chat') throw new Error('Expected new-chat context');
			return {
				success: true,
				source: 'snippet',
				sourceId: 'snippet-handoff',
				sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
				shortName: 'handoff',
				contextExecutorId: 'local',
				contextProjectPath: request.context.projectPath,
				expandedText: `Continue chat ${request.context.chatId}`,
			};
		});
		render(NewChatDialogTestHost, {
			shell, initialSeed,
			snippetTemplate: 'Continue chat {{chat_id}}',
			onCreateDraft,
		});
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const messageInput = screen.getByPlaceholderText(
			'How can I help you today?',
		) as HTMLTextAreaElement;
		await fireEvent.input(messageInput, { target: { value: '/s handoff' } });
		await waitFor(() => {
			expect((screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled).toBe(
				false,
			);
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		await waitFor(() => expect(messageInput.value).toBe(`Continue chat ${expectedId}`));
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		shell.openNewChatDialog();
		await waitFor(() => expect(screen.getByPlaceholderText('How can I help you today?')).toHaveProperty('value', `Continue chat ${expectedId}`));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Start session' })).toHaveProperty('disabled', false));
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));

		await waitFor(() => expect(onCreateDraft).toHaveBeenCalledTimes(1));
		expect(snippetsApi.expandSnippet).toHaveBeenCalledWith(
			expect.objectContaining({
				context: {
					type: 'new-chat',
					executorId: 'local',
					chatId: expectedId,
					projectPath: initialSeed?.startup?.projectPath ?? '/workspace',
				},
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(onCreateDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expectedId,
				startup: expect.objectContaining({ firstMessage: `Continue chat ${expectedId}` }),
			}),
		);
		expect(navigation.gotoChat).toHaveBeenCalledWith(expectedId);
		expect(clientChatId.createClientChatId).toHaveBeenCalledTimes(initialSeed ? 0 : 1);
	});

	it('presents a named landing screen with saved-project guidance', async () => {
		render(NewChatDialogTestHost);
		const landing = await screen.findByRole('dialog', { name: 'New Chat' });
		expect(within(landing).getByRole('heading', { name: 'What would you like to work on?' })).toBeTruthy();
		expect(within(landing).getByText('Choose a project, then select a worktree to start a new chat.')).toBeTruthy();
		await within(landing).findByRole('region', { name: 'Saved and recent projects' });
	});

	it('closes the landing screen from its header', async () => {
		render(NewChatDialogTestHost);

		await screen.findByRole('button', { name: 'Choose project' });
		const closeButton = screen.getByRole('button', { name: 'Close' });
		expect(closeButton.closest('header')).toBeTruthy();
		expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);

		await fireEvent.click(closeButton);
		await waitFor(() => {
			expect(screen.queryByRole('dialog')).toBeNull();
		});
	});

	it('keeps New Chat open when the expanded child closes and restores the compact draft', async () => {
		render(NewChatDialogTestHost);
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const compact = screen.getByPlaceholderText('How can I help you today?') as HTMLTextAreaElement;
		await fireEvent.input(compact, { target: { value: 'Draft in New Chat' } });
		compact.setSelectionRange(1, 6);

		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const expanded = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(screen.getAllByRole('dialog')).toHaveLength(2);
		await fireEvent.input(expanded, { target: { value: 'Live-synced New Chat draft' } });
		expanded.setSelectionRange(4, 11);
		await fireEvent.pointerUp(expanded);

		await fireEvent.keyDown(expanded, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('textbox', { name: 'Expanded composer text' })).toBeNull();
		});
		expect(screen.getAllByRole('dialog')).toHaveLength(1);
		expect(compact.value).toBe('Live-synced New Chat draft');
		expect(compact.selectionStart).toBe(4);
		expect(compact.selectionEnd).toBe(11);
		expect(document.activeElement).toBe(compact);

		await fireEvent.keyDown(compact, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('gives the expanded child Escape priority before refinement and the parent', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(NewChatDialogTestHost);
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const compact = screen.getByPlaceholderText('How can I help you today?') as HTMLTextAreaElement;
		await fireEvent.input(compact, { target: { value: 'Refine inside New Chat' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const expanded = await screen.findByRole('textbox', { name: 'Expanded composer text' });
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		const childDialog = screen.getAllByRole('dialog')[1];
		if (!childDialog) throw new Error('Missing expanded composer dialog');
		await fireEvent.click(within(childDialog).getByRole('button', { name: 'Refine prompt' }));
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await fireEvent.keyDown(expanded, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('textbox', { name: 'Expanded composer text' })).toBeNull();
		});
		expect(screen.getAllByRole('dialog')).toHaveLength(1);
		expect((options?.signal as AbortSignal).aborted).toBe(false);
		expect(compact.readOnly).toBe(true);

		await fireEvent.keyDown(compact, { key: 'Escape' });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		await waitFor(() => expect(compact.readOnly).toBe(false));
		expect(screen.getAllByRole('dialog')).toHaveLength(1);
		expect(compact.value).toBe('Refine inside New Chat');
		expect(document.activeElement).toBe(compact);

		await fireEvent.keyDown(compact, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		pending.resolve({ success: true, refinedPrompt: 'Must not apply' });
		await pending.promise;
	});

	it('cancels refinement when the parent New Chat dialog closes', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(NewChatDialogTestHost);
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		const compact = screen.getByPlaceholderText('How can I help you today?');
		await fireEvent.input(compact, { target: { value: 'Close during refinement' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect((options?.signal as AbortSignal).aborted).toBe(true);

		pending.resolve({ success: true, refinedPrompt: 'Must not apply' });
		await pending.promise;
	});

	async function openMessageInput(): Promise<HTMLTextAreaElement> {
		await waitFor(() => {
			expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
		});
		return screen.getByPlaceholderText('How can I help you today?') as HTMLTextAreaElement;
	}

	async function closeDialog(): Promise<void> {
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	}

	it('restores the unsent prompt when New Chat is closed and reopened', async () => {
		render(NewChatDialogTestHost);
		await fireEvent.input(await openMessageInput(), { target: { value: 'Unsent prompt' } });
		await closeDialog();

		await fireEvent.click(screen.getByTestId('reopen-new-chat'));
		expect((await openMessageInput()).value).toBe('Unsent prompt');
	});

	it('keeps the unsent prompt behind a prefilled New Chat that is edited', async () => {
		render(NewChatDialogTestHost);
		await fireEvent.input(await openMessageInput(), { target: { value: 'Unsent prompt' } });
		await closeDialog();

		await fireEvent.click(screen.getByTestId('reopen-new-chat-prefilled'));
		const prefilled = await openMessageInput();
		expect(prefilled.value).toBe('Prefilled prompt');
		await fireEvent.input(prefilled, { target: { value: 'Prefilled prompt, edited' } });
		await closeDialog();

		await fireEvent.click(screen.getByTestId('reopen-new-chat'));
		expect((await openMessageInput()).value).toBe('Unsent prompt');
	});

	it('starts New Chat empty after the prompt has started a chat', async () => {
		render(NewChatDialogTestHost);
		await fireEvent.input(await openMessageInput(), { target: { value: 'Sent prompt' } });
		await waitFor(() => {
			expect(
				(screen.getByRole('button', { name: 'Start session' }) as HTMLButtonElement).disabled,
			).toBe(false);
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(screen.getByTestId('reopen-new-chat'));
		expect((await openMessageInput()).value).toBe('');
	});
});
