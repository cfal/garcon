import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import * as refinementApi from '$lib/api/prompt-refinement.js';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';
import IssuesTestHost from './IssuesTestHost.svelte';
import { issueTestHarness } from './issue-test-harness';
import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte';

vi.mock('$lib/api/prompt-refinement.js', () => ({ refinePrompt: vi.fn() }));
vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
}));

const controllers: IssuesController[] = [];
afterEach(() => {
	cleanup();
	controllers.splice(0).forEach((controller) => controller.dispose());
	resetPromptEditorStub();
	vi.mocked(refinementApi.refinePrompt).mockReset();
});

async function edit() {
	const fixture = issueTestHarness();
	controllers.push(fixture.controller);
	fixture.controller.setPresentationVisible(true);
	await fixture.controller.refresh();
	const view = render(IssuesTestHost, { controller: fixture.controller });
	await fireEvent.click(screen.getByRole('button', { name: 'Open G-1' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
	return {
		...fixture,
		view,
		textarea: screen.getByLabelText('Description') as HTMLTextAreaElement,
	};
}

it('shares the expanded editor with live draft text and restores the compact selection', async () => {
	const { controller, textarea } = await edit();
	textarea.setSelectionRange(2, 5, 'backward');
	await fireEvent.click(screen.getByRole('button', { name: 'Expand description editor' }));
	const dialog = within(await screen.findByRole('dialog', { name: 'Description' }));
	await fireEvent.input(await dialog.findByRole('textbox', { name: 'Description' }), {
		target: { value: 'A clearer synthetic description.' },
	});
	expect(controller.detail.fieldsDraft?.field('description')).toBe(
		'A clearer synthetic description.',
	);
	await fireEvent.click(dialog.getByRole('button', { name: 'Close expanded editor' }));
	await waitFor(() => expect(document.activeElement).toBe(textarea));
	expect(textarea.selectionStart).toBe(2);
	expect(textarea.selectionEnd).toBe(5);
	expect(textarea.selectionDirection).toBe('backward');
});

it.each([false, true])(
	'refines only the unchanged draft and blocks both save paths (%s)',
	async (changed) => {
		let resolve!: (result: RefinePromptResponse) => void;
		vi.mocked(refinementApi.refinePrompt).mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const { controller, api, textarea } = await edit();
		const draft = controller.detail.fieldsDraft!;
		await fireEvent.click(
			within(textarea.closest('form')!).getByRole('button', { name: 'Refine prompt' }),
		);
		expect(refinementApi.refinePrompt).toHaveBeenCalledWith(
			{ draft: 'Synthetic description', target: 'issue-description' },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(
			(screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		await fireEvent.submit(textarea.closest('form')!);
		expect(api.mutate).not.toHaveBeenCalled();
		if (changed) draft.setField('description', 'Newer synthetic description');
		resolve({ success: true, refinedPrompt: 'Refined synthetic description' });
		await waitFor(() =>
			expect(
				(screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled,
			).toBe(false),
		);
		expect(draft.field('description')).toBe(
			changed ? 'Newer synthetic description' : 'Refined synthetic description',
		);
	},
);

it('cancels refinement on unmount and ignores a late response', async () => {
	let resolve!: (result: RefinePromptResponse) => void;
	vi.mocked(refinementApi.refinePrompt).mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const { controller, view, textarea } = await edit();
	const draft = controller.detail.fieldsDraft!;
	await fireEvent.click(
		within(textarea.closest('form')!).getByRole('button', { name: 'Refine prompt' }),
	);
	const signal = vi.mocked(refinementApi.refinePrompt).mock.calls[0][1]!.signal!;
	view.unmount();
	expect(signal.aborted).toBe(true);
	resolve({ success: true, refinedPrompt: 'Late description' });
	await Promise.resolve();
	expect(draft.field('description')).toBe('Synthetic description');
});
