import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import { PROMPT_REFINEMENT_DRAFT_MAX_LENGTH } from '$shared/prompt-refinement';
import * as refinementApi from '$lib/api/prompt-refinement';
import { ApiError } from '$lib/api/client';
import { chatDraftStorageKey } from '$lib/utils/local-persistence';
import PromptComposerTestHost from './PromptComposerTestHost.svelte';
import {
	emitLastPromptEditorTextChange,
	resetPromptEditorStub,
} from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';

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

function compactTextarea(): HTMLTextAreaElement {
	return screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
}

async function typeDraft(value: string): Promise<HTMLTextAreaElement> {
	const textarea = compactTextarea();
	await fireEvent.input(textarea, { target: { value } });
	return textarea;
}

async function settleExpandedDialogOpen(): Promise<void> {
	// Lets Bits UI finish delayed dismissible-layer registration before tests close the dialog.
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

describe('PromptComposer prompt refinement', () => {
	afterEach(() => {
		cleanup();
		resetPromptEditorStub();
		vi.mocked(refinementApi.refinePrompt).mockReset();
		localStorage.clear();
	});

	it('places Refine between expanded composer and Send and enforces draft limits', async () => {
		render(PromptComposerTestHost, { selectedChatId: 'chat-refine-order' });
		const open = screen.getByRole('button', { name: 'Open expanded composer' });
		const refine = screen.getByRole('button', { name: 'Refine prompt' });
		const send = screen.getByRole('button', { name: 'Send message' });

		expect(open.compareDocumentPosition(refine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(refine.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect((refine as HTMLButtonElement).disabled).toBe(true);

		await typeDraft('A draft to improve');
		expect((refine as HTMLButtonElement).disabled).toBe(false);
		await typeDraft('x'.repeat(PROMPT_REFINEMENT_DRAFT_MAX_LENGTH + 1));
		expect((refine as HTMLButtonElement).disabled).toBe(true);
	});

	it('locks compact draft mutations and cancellation preserves text and attachments', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const onsubmit = vi.fn();
		const { container } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-refine-lock',
			onsubmit,
		});
		const textarea = await typeDraft('Keep this draft');
		const originalAttachment = new File(['image'], 'original.png', { type: 'image/png' });
		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		await fireEvent.change(fileInput, { target: { files: [originalAttachment] } });

		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await waitFor(() => expect(vi.mocked(refinementApi.refinePrompt)).toHaveBeenCalledOnce());
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];
		expect(vi.mocked(refinementApi.refinePrompt).mock.calls[0][0]).toEqual({
			draft: 'Keep this draft',
		});
		expect(textarea.readOnly).toBe(true);
		expect(textarea.getAttribute('aria-busy')).toBe('true');
		expect(
			(screen.getByRole('button', { name: 'Cancel prompt refinement' }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
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
			(screen.getByRole('button', { name: 'Remove attachment original.png' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		textarea.value = 'Synthetic mutation';
		await fireEvent.input(textarea);
		expect(textarea.value).toBe('Keep this draft');
		await fireEvent.change(fileInput, {
			target: { files: [new File(['new'], 'late.png', { type: 'image/png' })] },
		});
		expect(screen.getByTestId('composer-attachment-count').textContent).toBe('1');
		await fireEvent.keyDown(textarea, { key: 'Enter' });
		await fireEvent.submit(textarea.closest('form') as HTMLFormElement);
		expect(onsubmit).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel prompt refinement' }));
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		expect(textarea.readOnly).toBe(false);
		expect(textarea.value).toBe('Keep this draft');
		expect(screen.getByTestId('composer-attachment-count').textContent).toBe('1');

		pending.resolve({ success: true, refinedPrompt: 'Must not apply' });
		await pending.promise;
		await Promise.resolve();
		expect(textarea.value).toBe('Keep this draft');
	});

	it('replaces and persists a current result while preserving attachments and caret', async () => {
		vi.mocked(refinementApi.refinePrompt).mockResolvedValueOnce({
			success: true,
			refinedPrompt: 'A precise and actionable request.',
		});
		const chatId = 'chat-refine-success';
		const { container } = render(PromptComposerTestHost, { selectedChatId: chatId });
		const textarea = await typeDraft('make this better');
		await fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
			target: { files: [new File(['image'], 'kept.png', { type: 'image/png' })] },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await waitFor(() => expect(textarea.value).toBe('A precise and actionable request.'));
		expect(screen.getByTestId('composer-attachment-count').textContent).toBe('1');
		expect(textarea.selectionStart).toBe(textarea.value.length);
		expect(textarea.selectionEnd).toBe(textarea.value.length);
		expect(document.activeElement).toBe(textarea);
		expect(screen.getByText('Prompt refined.')).toBeTruthy();
		await waitFor(() => {
			expect(localStorage.getItem(chatDraftStorageKey(chatId))).toBe(
				'A precise and actionable request.',
			);
		});
	});

	it('avoids revision churn for identical output and preserves failed drafts', async () => {
		vi.mocked(refinementApi.refinePrompt).mockResolvedValueOnce({
			success: true,
			refinedPrompt: 'Already clear',
		});
		const { component } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-refine-unchanged',
		});
		const textarea = await typeDraft('Already clear');
		const revision = component.getComposerContentRevision();
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await screen.findByText('No changes were needed.');
		expect(component.getComposerContentRevision()).toBe(revision);

		vi.mocked(refinementApi.refinePrompt).mockRejectedValueOnce(
			new ApiError(504, 'private provider detail', 'PROMPT_REFINEMENT_TIMEOUT'),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		expect(await screen.findByText(/Prompt refinement timed out/)).toBeTruthy();
		expect(textarea.value).toBe('Already clear');
		expect(screen.queryByText(/private provider detail/)).toBeNull();
	});

	it('discards a result after external draft mutation or a chat switch', async () => {
		const stale = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(stale.promise);
		const { rerender } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-refine-stale',
		});
		const textarea = await typeDraft('Source draft');
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await fireEvent.click(screen.getByTestId('append-draft'));
		stale.resolve({ success: true, refinedPrompt: 'Stale result' });
		await screen.findByText(/draft changed while refinement was running/i);
		expect(textarea.value).toContain('Appended review block');
		expect(textarea.value).not.toBe('Stale result');

		const switched = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(switched.promise);
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[1];
		await rerender({ selectedChatId: 'chat-refine-next' });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		await fireEvent.input(textarea, { target: { value: 'New chat draft' } });
		switched.resolve({ success: true, refinedPrompt: 'Wrong chat result' });
		await switched.promise;
		await Promise.resolve();
		expect(textarea.value).toBe('New chat draft');
	});

	it('locks the expanded editor, keeps Close independent, and applies after closing', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const { container } = render(PromptComposerTestHost, {
			selectedChatId: 'chat-refine-expanded-close',
		});
		const textarea = await typeDraft('Expanded source');
		await fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
			target: { files: [new File(['image'], 'kept.png', { type: 'image/png' })] },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await settleExpandedDialogOpen();
		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByTitle('Attached files: 1')).toBeTruthy();
		const refine = within(dialog).getByRole('button', { name: 'Refine prompt' });
		const close = within(dialog).getByRole('button', { name: 'Close expanded editor' });
		expect(refine.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		await fireEvent.click(refine);
		expect(editor.readOnly).toBe(true);
		expect(textarea.readOnly).toBe(true);
		emitLastPromptEditorTextChange('Synthetic expanded mutation');
		expect(textarea.value).toBe('Expanded source');
		expect((close as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(close);
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];
		expect((options?.signal as AbortSignal).aborted).toBe(false);
		expect(screen.getByRole('button', { name: 'Cancel prompt refinement' })).toBeTruthy();

		pending.resolve({ success: true, refinedPrompt: 'Refined after close' });
		await waitFor(() => expect(textarea.value).toBe('Refined after close'));
		expect(textarea.selectionStart).toBe(textarea.value.length);
		await waitFor(() => expect(document.activeElement).toBe(textarea));
	});

	it('does not reopen snippet surfaces when the expanded editor closes during refinement', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(PromptComposerTestHost, { selectedChatId: 'chat-refine-expanded-trigger' });
		const textarea = await typeDraft('Expanded source');
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await fireEvent.input(editor, { target: { value: 'Review ;;dep' } });
		editor.setSelectionRange(editor.value.length, editor.value.length);
		await fireEvent.pointerUp(editor);
		await settleExpandedDialogOpen();
		const dialog = screen.getByRole('dialog');
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Refine prompt' }));
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Close expanded editor' }));

		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.queryByRole('option', { name: /review/i })).toBeNull();

		pending.resolve({ success: true, refinedPrompt: 'Refined without a palette' });
		await waitFor(() => expect(textarea.value).toBe('Refined without a palette'));
	});

	it('gives expanded Escape precedence, then lets compact Escape cancel', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(PromptComposerTestHost, { selectedChatId: 'chat-refine-expanded-escape' });
		const textarea = await typeDraft('Escape source');
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = await screen.findByRole('textbox', { name: 'Expanded composer text' });
		await settleExpandedDialogOpen();
		await fireEvent.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Refine prompt' }),
		);
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await fireEvent.keyDown(editor, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect((options?.signal as AbortSignal).aborted).toBe(false);
		expect(textarea.readOnly).toBe(true);

		await fireEvent.keyDown(textarea, { key: 'Escape' });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		expect(textarea.readOnly).toBe(false);
		expect(textarea.value).toBe('Escape source');
		await waitFor(() => expect(document.activeElement).toBe(textarea));

		pending.resolve({ success: true, refinedPrompt: 'Must not apply' });
		await pending.promise;
	});

	it('cancels from expanded composer without closing it and restores editability', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(PromptComposerTestHost, { selectedChatId: 'chat-refine-expanded-cancel' });
		await typeDraft('Cancel source');
		await fireEvent.click(screen.getByRole('button', { name: 'Open expanded composer' }));
		const editor = (await screen.findByRole('textbox', {
			name: 'Expanded composer text',
		})) as HTMLTextAreaElement;
		await settleExpandedDialogOpen();
		const dialog = screen.getByRole('dialog');
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Refine prompt' }));
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel prompt refinement' }));

		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(editor.readOnly).toBe(false);
		await waitFor(() => expect(document.activeElement).toBe(editor));

		pending.resolve({ success: true, refinedPrompt: 'Must not apply' });
		await pending.promise;
	});
});
