import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import * as refinementApi from '$lib/api/prompt-refinement.js';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';
import SnippetsSectionTestHost from './SnippetsSectionTestHost.svelte';

vi.mock('$lib/api/prompt-refinement.js', () => ({
	refinePrompt: vi.fn(),
}));

vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
}));

function deferredRefinement() {
	let resolve!: (value: RefinePromptResponse) => void;
	const promise = new Promise<RefinePromptResponse>((done) => (resolve = done));
	return { promise, resolve };
}

async function openCreateForm() {
	const add = await screen.findByRole('button', { name: 'Add snippet' });
	await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
	await fireEvent.click(add);
	return {
		dialog: screen.getByRole('dialog', { name: 'Add Snippet' }),
		name: screen.getByRole('textbox', { name: 'Short name' }) as HTMLInputElement,
		template: screen.getByRole('textbox', { name: 'Snippet text' }) as HTMLTextAreaElement,
	};
}

describe('Snippet template editor', () => {
	afterEach(() => {
		cleanup();
		resetPromptEditorStub();
		vi.mocked(refinementApi.refinePrompt).mockReset();
	});

	it('edits live in an isolated expanded editor and restores the compact selection', async () => {
		render(SnippetsSectionTestHost);
		const { template } = await openCreateForm();
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		template.setSelectionRange(2, 5, 'backward');

		await fireEvent.click(screen.getByRole('button', { name: 'Expand snippet text' }));
		const editorDialog = screen.getByRole('dialog', { name: 'Snippet text' });
		expect(editorDialog.hasAttribute('data-workspace-surface-id')).toBe(false);
		const expandedEditor = await screen.findByRole('textbox', {
			name: 'Expanded snippet text',
		});
		await fireEvent.input(expandedEditor, {
			target: { value: 'Review the change {{arguments}}' },
		});
		expect(template.value).toBe('Review the change {{arguments}}');

		await fireEvent.click(
			within(editorDialog).getByRole('button', { name: 'Close expanded editor' }),
		);
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Snippet text' })).toBeNull());
		expect(document.activeElement).toBe(template);
		expect(template.selectionStart).toBe(2);
		expect(template.selectionEnd).toBe(5);
		expect(template.selectionDirection).toBe('backward');
	});

	it('refines snippet templates through the discriminated target', async () => {
		vi.mocked(refinementApi.refinePrompt).mockResolvedValueOnce({
			success: true,
			refinedPrompt: 'Review the staged change: {{arguments}}',
		});
		render(SnippetsSectionTestHost);
		const { template } = await openCreateForm();
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });

		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await waitFor(() => expect(template.value).toBe('Review the staged change: {{arguments}}'));
		expect(vi.mocked(refinementApi.refinePrompt).mock.calls[0]?.[0]).toEqual({
			draft: 'Review {{arguments}}',
			target: 'snippet-template',
		});
		expect(screen.getByTestId('snippet-notifications').textContent).toContain('Prompt refined.');
		expect(document.activeElement).toBe(template);
	});

	it('cancels refinement before Escape can close the form and blocks every save path', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(SnippetsSectionTestHost);
		const { dialog, name, template } = await openCreateForm();
		await fireEvent.input(name, { target: { value: 'review' } });
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await screen.findByRole('button', { name: 'Cancel prompt refinement' });
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.keyDown(template, { key: 'Enter', ctrlKey: true });
		expect(screen.getByTestId('snippet-create-count').textContent).toBe('0');

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		expect(dialog.isConnected).toBe(true);
		expect(document.activeElement).toBe(template);
		await fireEvent.keyDown(dialog, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull());
	});

	it('closes the expanded editor before cancelling its pending refinement', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(SnippetsSectionTestHost);
		const { dialog, template } = await openCreateForm();
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Expand snippet text' }));
		const editorDialog = screen.getByRole('dialog', { name: 'Snippet text' });
		await screen.findByRole('textbox', { name: 'Expanded snippet text' });
		await fireEvent.click(within(editorDialog).getByRole('button', { name: 'Refine prompt' }));
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await fireEvent.keyDown(editorDialog, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Snippet text' })).toBeNull());
		expect((options?.signal as AbortSignal).aborted).toBe(false);
		expect(dialog.isConnected).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel prompt refinement' }));
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		expect(dialog.isConnected).toBe(true);
	});

	it.each(['close button', 'backdrop'] as const)(
		'aborts refinement when the form closes from the %s',
		async (closeAction) => {
			const pending = deferredRefinement();
			vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
			render(SnippetsSectionTestHost);
			const { template } = await openCreateForm();
			await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
			await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
			await screen.findByRole('button', { name: 'Cancel prompt refinement' });
			const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

			if (closeAction === 'close button') {
				await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
			} else {
				const backdrop = Array.from(
					document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"]'),
				).at(-1);
				if (!backdrop) throw new Error('Expected a dialog backdrop');
				await new Promise((resolve) => setTimeout(resolve, 20));
				await fireEvent.pointerDown(backdrop, {
					button: 0,
					clientX: -1,
					clientY: -1,
					pointerType: 'mouse',
				});
			}

			await waitFor(() => expect((options?.signal as AbortSignal).aborted).toBe(true));
			expect(screen.queryByRole('dialog', { name: 'Add Snippet' })).toBeNull();
		},
	);

	it('aborts explicit form closure and cannot apply a result after reopening', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		render(SnippetsSectionTestHost);
		const first = await openCreateForm();
		await fireEvent.input(first.template, { target: { value: 'Review {{arguments}}' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await screen.findByRole('button', { name: 'Cancel prompt refinement' });
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect((options?.signal as AbortSignal).aborted).toBe(true);

		const second = await openCreateForm();
		await fireEvent.input(second.template, { target: { value: 'Keep this template' } });
		pending.resolve({ success: true, refinedPrompt: 'Wrong late result {{arguments}}' });
		await pending.promise;
		await Promise.resolve();
		expect(second.template.value).toBe('Keep this template');
		expect(screen.getByTestId('snippet-notifications').textContent).toBe('');
	});

	it('aborts refinement when the snippets surface unmounts', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const { rerender } = render(SnippetsSectionTestHost, { showSection: true });
		const { template } = await openCreateForm();
		await fireEvent.input(template, { target: { value: 'Review {{arguments}}' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
		await screen.findByRole('button', { name: 'Cancel prompt refinement' });
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await rerender({ showSection: false });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
	});
});
