import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import TicketCommentComposer from './TicketCommentComposerHost.svelte';
import * as refinementApi from '$lib/api/prompt-refinement.js';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';
import { ticketTestHarness, TICKET_STORE, syntheticTicket } from './ticket-test-harness';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte';

const controllers: TicketsController[] = [];
vi.mock('$lib/api/prompt-refinement.js', () => ({ refinePrompt: vi.fn() }));
vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
}));
afterEach(() => {
	cleanup();
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.mocked(refinementApi.refinePrompt).mockReset();
	resetPromptEditorStub();
});
describe('Ticket comment submission', () => {
	function mount() {
		const fixture = ticketTestHarness();
		controllers.push(fixture.controller);
		fixture.controller.drafts.setPartition({ storeId: TICKET_STORE, viewerKey: 'synthetic-viewer' });
		const draft = fixture.controller.drafts.open('comment', { ticket: syntheticTicket() })!;
		draft.setField('body', 'Synthetic progress');
		const view = render(TicketCommentComposer, { draft });
		return { ...fixture, draft, view };
	}

	it('expands comment text with live synchronization and restores selection', async () => {
		const { draft } = mount();
		const input = screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement;
		input.setSelectionRange(2, 5, 'backward');
		await fireEvent.click(screen.getByRole('button', { name: 'Expand comment editor' }));
		const dialog = within(await screen.findByRole('dialog', { name: 'Comment' }));
		await fireEvent.input(await dialog.findByRole('textbox', { name: 'Comment' }), {
			target: { value: 'Updated synthetic progress' },
		});
		expect(draft.field('body')).toBe('Updated synthetic progress');
		await fireEvent.click(dialog.getByRole('button', { name: 'Close expanded editor' }));
		await waitFor(() => expect(document.activeElement).toBe(input));
		expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
			2,
			5,
			'backward',
		]);
	});

	it.each([false, true])(
		'refines the unchanged comment and blocks every submit path (changed: %s)',
		async (changed) => {
			let resolve!: (result: RefinePromptResponse) => void;
			vi.mocked(refinementApi.refinePrompt).mockImplementation(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
			const { draft, api } = mount();
			const input = screen.getByRole('textbox', { name: 'Comment' });
			await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
			expect(refinementApi.refinePrompt).toHaveBeenCalledWith(
				{ draft: 'Synthetic progress', target: 'ticket-comment' },
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect((screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled).toBe(
				true,
			);
			await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
			await fireEvent.submit(input.closest('form')!);
			expect(api.mutate).not.toHaveBeenCalled();
			if (changed) draft.setField('body', 'Newer progress');
			resolve({ success: true, refinedPrompt: 'Refined progress' });
			await waitFor(() =>
				expect(
					(screen.getByRole('button', { name: 'Comment' }) as HTMLButtonElement).disabled,
				).toBe(false),
			);
			expect(draft.field('body')).toBe(changed ? 'Newer progress' : 'Refined progress');
			await fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
			expect(api.mutate.mock.lastCall?.[0].payload).toEqual({
				action: 'comment',
				ticketId: 'G-1',
				body: changed ? 'Newer progress' : 'Refined progress',
			});
		},
	);

	it.each(['cancel', 'hide', 'unmount'] as const)(
		'cancels comment refinement on %s and ignores a late result',
		async (action) => {
			let resolve!: (result: RefinePromptResponse) => void;
			vi.mocked(refinementApi.refinePrompt).mockImplementation(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
			const { draft, view } = mount();
			await fireEvent.click(screen.getByRole('button', { name: 'Refine prompt' }));
			const signal = vi.mocked(refinementApi.refinePrompt).mock.calls[0][1]!.signal!;
			if (action === 'unmount') view.unmount();
			else if (action === 'hide') await view.rerender({ draft, visible: false });
			else await fireEvent.click(screen.getByRole('button', { name: 'Cancel prompt refinement' }));
			expect(signal.aborted).toBe(true);
			resolve({ success: true, refinedPrompt: 'Late progress' });
			await tick();
			expect(draft.field('body')).toBe('Synthetic progress');
		},
	);

	it('does not invoke a destroyed composer’s owner after its request settles', async () => {
		const { controller, api } = ticketTestHarness();
		controllers.push(controller);
		controller.drafts.setPartition({ storeId: TICKET_STORE, viewerKey: 'synthetic-viewer' });
		const draft = controller.drafts.open('comment', { ticket: syntheticTicket() })!;
		const onSubmitted = vi.fn();
		const view = render(TicketCommentComposer, { draft, onSubmitted });
		draft.setField('body', 'Held comment');
		let release!: () => void;
		const mutate = api.mutate.getMockImplementation()!;
		api.mutate.mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return mutate(...args);
		});
		await fireEvent.submit(screen.getByRole('textbox').closest('form')!);
		view.unmount();
		release();
		await vi.waitFor(() => expect(draft.pending).toBe(false));
		expect(draft.dirty).toBe(false);
		expect(onSubmitted).not.toHaveBeenCalled();
	});

	it('shares the click/shortcut gate, keeps multiline Enter, excludes IME, and prevents duplicate submission', async () => {
		const { controller, api } = ticketTestHarness();
		controllers.push(controller);
		controller.drafts.setPartition({ storeId: TICKET_STORE, viewerKey: 'synthetic-viewer' });
		const draft = controller.drafts.open('comment', { ticket: syntheticTicket() })!;
		render(TicketCommentComposer, { draft });
		const input = screen.getByRole('textbox');
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.input(input, { target: { value: 'Synthetic\ncomment' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.compositionStart(input);
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
		await fireEvent.submit(input.closest('form')!);
		expect(api.mutate).not.toHaveBeenCalled();
		await fireEvent.compositionEnd(input);
		let release!: () => void;
		api.mutate.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => (release = resolve));
			return {
				success: true,
				storeId: TICKET_STORE,
				collectionRevision: 2,
				ticket: syntheticTicket(),
			};
		});
		await fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
		await fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
		expect(api.mutate).toHaveBeenCalledTimes(1);
		expect(draft.field('body')).toBe('Synthetic\ncomment');
		release();
		await tick();
	});
});
