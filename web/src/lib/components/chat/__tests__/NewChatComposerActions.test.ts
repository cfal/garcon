import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import { PROMPT_REFINEMENT_DRAFT_MAX_LENGTH } from '$shared/prompt-refinement';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as refinementApi from '$lib/api/prompt-refinement';
import * as settingsApi from '$lib/api/settings';
import NewChatFormTestHost from './NewChatFormTestHost.svelte';
import {
	emitLastComposerEditorTextChange,
	resetComposerEditorStub,
} from './ComposerEditorStub.svelte';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn().mockResolvedValue({ valid: true, isGitRepo: false }),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
}));

vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

vi.mock('$lib/api/prompt-refinement', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/prompt-refinement')>();
	return { ...actual, refinePrompt: vi.fn() };
});

vi.mock('../ComposerEditor.svelte', async () => ({
	default: (await import('./ComposerEditorStub.svelte')).default,
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
		features: { transcriptSearch: { enabled: false } },
		ui: {},
		uiEffective: {},
		paths: {
			pinnedProjectPaths: [],
			browseStartPath: '/workspace',
			recentProjectPaths: ['/workspace/project'],
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

async function renderReady(onStartChat = vi.fn()): Promise<{
	container: HTMLElement;
	messageInput: HTMLTextAreaElement;
	onStartChat: ReturnType<typeof vi.fn>;
}> {
	const result = render(NewChatFormTestHost, { props: { onStartChat } });
	await waitFor(() => {
		expect(screen.queryByRole('status', { name: 'Loading chat defaults...' })).toBeNull();
	});
	return {
		container: result.container,
		messageInput: screen.getByPlaceholderText('How can I help you today?'),
		onStartChat,
	};
}

async function settleExpandedDialogOpen(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

describe('NewChatForm composer actions', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn().mockImplementation(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
			})),
		);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValue(makeSnapshot());
	});

	afterEach(() => {
		cleanup();
		resetComposerEditorStub();
		vi.mocked(refinementApi.refinePrompt).mockReset();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('places Refine between expanded composer and Start and enforces draft limits', async () => {
		const { messageInput } = await renderReady();
		const open = screen.getByRole('button', { name: 'Open expanded composer' });
		const refine = screen.getByRole('button', { name: 'Refine prompt' });
		const start = screen.getByRole('button', { name: 'Start session' });

		expect(open.compareDocumentPosition(refine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(refine.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect((refine as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.input(messageInput, { target: { value: 'A draft to improve' } });
		expect((refine as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.input(messageInput, {
			target: { value: 'x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1) },
		});
		expect((refine as HTMLButtonElement).disabled).toBe(true);
	});

	it('live-syncs the expanded editor and restores compact focus and selection on close', async () => {
		const { messageInput } = await renderReady();
		await fireEvent.input(messageInput, { target: { value: 'Draft from compact' } });
		messageInput.setSelectionRange(2, 7);

		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await settleExpandedDialogOpen();
		expect(editor.value).toBe('Draft from compact');

		await fireEvent.input(editor, { target: { value: 'Edited in expanded mode' } });
		expect(messageInput.value).toBe('Edited in expanded mode');
		editor.setSelectionRange(3, 9);
		await fireEvent.pointerUp(editor);

		await fireEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', {
				name: 'Close expanded composer',
			}),
		);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(messageInput.value).toBe('Edited in expanded mode');
		expect(messageInput.selectionStart).toBe(3);
		expect(messageInput.selectionEnd).toBe(9);
		expect(document.activeElement).toBe(messageInput);
	});

	it('locks every draft mutation while refining and preserves attachments on success', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const { container, messageInput, onStartChat } = await renderReady();
		await fireEvent.input(messageInput, { target: { value: 'Keep this draft' } });
		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		await fireEvent.change(fileInput, {
			target: { files: [new File(['image'], 'original.png', { type: 'image/png' })] },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await waitFor(() => expect(refinementApi.refinePrompt).toHaveBeenCalledOnce());
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];
		expect(messageInput.readOnly).toBe(true);
		expect(fileInput.disabled).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Open expanded composer' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Refining prompt...' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Add to prompt' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole('button', {
					name: 'Remove attachment original.png',
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);

		messageInput.value = 'Synthetic mutation';
		await fireEvent.input(messageInput);
		expect(messageInput.value).toBe('Keep this draft');
		await fireEvent.change(fileInput, {
			target: { files: [new File(['late'], 'late.png', { type: 'image/png' })] },
		});
		await fireEvent.keyDown(messageInput, { key: 'Enter' });
		expect(onStartChat).not.toHaveBeenCalled();

		pending.resolve({ success: true, refinedPrompt: 'A precise new-chat request.' });
		await waitFor(() => expect(messageInput.value).toBe('A precise new-chat request.'));
		expect(screen.getByRole('button', { name: 'Remove attachment original.png' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Remove attachment late.png' })).toBeNull();
		expect(messageInput.readOnly).toBe(false);
		expect(messageInput.selectionStart).toBe(messageInput.value.length);
		expect(document.activeElement).toBe(messageInput);
		expect((options?.signal as AbortSignal).aborted).toBe(false);
	});

	it('keeps refinement running when the expanded editor closes', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const { messageInput } = await renderReady();
		await fireEvent.input(messageInput, { target: { value: 'Expanded source' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await settleExpandedDialogOpen();
		const dialog = screen.getByRole('dialog');

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Refine prompt' }));
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];
		expect(editor.readOnly).toBe(true);
		expect(messageInput.readOnly).toBe(true);
		emitLastComposerEditorTextChange('Synthetic expanded mutation');
		expect(messageInput.value).toBe('Expanded source');

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close expanded composer' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect((options?.signal as AbortSignal).aborted).toBe(false);
		expect(screen.getByRole('button', { name: 'Cancel prompt refinement' })).toBeTruthy();
		expect(document.activeElement).toBe(messageInput);

		pending.resolve({ success: true, refinedPrompt: 'Refined after closing the editor' });
		await waitFor(() => expect(messageInput.value).toBe('Refined after closing the editor'));
		expect(document.activeElement).toBe(messageInput);
	});
});
