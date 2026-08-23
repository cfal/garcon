import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as refinementApi from '$lib/api/prompt-refinement';
import * as settingsApi from '$lib/api/settings';
import NewChatDialogTestHost from './NewChatDialogTestHost.svelte';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn().mockResolvedValue({ valid: true, isGitRepo: false }),
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

vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
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
	});

	afterEach(() => {
		cleanup();
		resetPromptEditorStub();
		vi.mocked(refinementApi.refinePrompt).mockReset();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('keeps the small-screen dialog within the safe viewport', async () => {
		render(NewChatDialogTestHost);

		await waitFor(() => {
			expect(document.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
		});

		const contentClass = document
			.querySelector('[data-slot="dialog-content"]')
			?.getAttribute('class');

		expect(contentClass).toContain('top-[var(--app-viewport-center-y)]');
		expect(contentClass).toContain('translate-y-[-50%]');
		expect(contentClass).toContain('safe-viewport-dialog');
		expect(contentClass).toContain('max-h-[calc(var(--app-height)-1rem)]');
		expect(contentClass).toContain('sm:top-[50%]');
		expect(contentClass).not.toContain('top-auto');
		expect(contentClass).not.toContain('bottom-0');
		expect(contentClass).not.toContain('translate-y-0');
	});

	it('places the close action in the project path controls', async () => {
		render(NewChatDialogTestHost);

		const projectPathInput = await screen.findByRole('textbox', { name: 'Project Path' });
		const closeButton = screen.getByRole('button', { name: 'Close' });
		const controlsRow = projectPathInput.parentElement?.parentElement;

		expect(screen.queryByText('Project Path')).toBeNull();
		expect(closeButton.parentElement).toBe(controlsRow);
		expect(closeButton.className).toContain('px-3');
		expect(closeButton.className).toContain('py-2');
		expect(closeButton.className).toContain('border border-border');
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
});
