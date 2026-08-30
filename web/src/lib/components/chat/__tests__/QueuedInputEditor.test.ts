import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefinePromptResponse } from '$shared/prompt-refinement';
import * as refinementApi from '$lib/api/prompt-refinement.js';
import { resetPromptEditorStub } from '$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte';
import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';
import QueuedInputsDialogTestHost from './QueuedInputsDialogTestHost.svelte';

vi.mock('$lib/api/prompt-refinement.js', () => ({
	refinePrompt: vi.fn(),
}));

vi.mock('$lib/components/prompt-editor/PromptEditor.svelte', async () => ({
	default: (await import('$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'))
		.default,
}));

function entry(index: number, revision = 1, content = `Queued message ${index}`): QueueEntry {
	return {
		id: `entry-${index}`,
		content,
		revision,
		createdAt: '2026-07-16T00:00:00.000Z',
		updatedAt: '2026-07-16T00:00:00.000Z',
	};
}

function queue(entries: QueueEntry[], overrides: Partial<ChatQueueState> = {}): ChatQueueState {
	return {
		entries,
		steeringEntryId: null,
		recentlyDispatched: [],
		pause: null,
		reorderRevision: 0,
		...overrides,
	};
}

function deferredRefinement() {
	let resolve!: (value: RefinePromptResponse) => void;
	const promise = new Promise<RefinePromptResponse>((done) => (resolve = done));
	return { promise, resolve };
}

const noopAction = () => Promise.resolve();

function renderHost(initialQueue: ChatQueueState) {
	return render(QueuedInputsDialogTestHost, {
		initialQueue,
		onCreate: vi.fn(noopAction),
		onReplace: vi.fn(noopAction),
		onDelete: vi.fn(noopAction),
		onMove: vi.fn(noopAction),
		onPause: vi.fn(noopAction),
		onResume: vi.fn(noopAction),
	});
}

async function beginEditing(index = 0): Promise<HTMLTextAreaElement> {
	await fireEvent.click(
		(await screen.findAllByRole('button', { name: m.chat_queue_edit_message() }))[index],
	);
	const textarea = (await screen.findByRole('textbox', {
		name: m.chat_queue_edit_message(),
	})) as HTMLTextAreaElement;
	await waitFor(() => expect(document.activeElement).toBe(textarea));
	return textarea;
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = '';
	resetPromptEditorStub();
	vi.mocked(refinementApi.refinePrompt).mockReset();
});

describe('QueuedInputEditor composer affordances', () => {
	it('edits inline in place of the row without duplicating its content', async () => {
		renderHost(queue([entry(0), entry(1)]));
		const textarea = await beginEditing(0);

		expect(screen.queryByText('Queued message 0')).toBeNull();
		expect(screen.getByText('Queued message 1')).toBeTruthy();
		expect(textarea.value).toBe('Queued message 0');
		expect(document.querySelector('[data-queue-move-id="entry-0"]')).toBeNull();
		expect(document.querySelector('[data-queue-edit-id="entry-0"]')).toBeNull();
		const remainingPencil = screen.getByRole('button', {
			name: m.chat_queue_edit_message(),
		}) as HTMLButtonElement;
		expect(remainingPencil.disabled).toBe(true);
		expect(document.querySelector('ol')?.contains(textarea)).toBe(true);
	});

	it('refines the queued draft through the prompt target', async () => {
		vi.mocked(refinementApi.refinePrompt).mockResolvedValueOnce({
			success: true,
			refinedPrompt: 'Refined queued message',
		});
		renderHost(queue([entry(0)]));
		const textarea = await beginEditing(0);

		await fireEvent.click(screen.getByRole('button', { name: m.prompt_refinement_refine() }));

		await waitFor(() => expect(textarea.value).toBe('Refined queued message'));
		expect(vi.mocked(refinementApi.refinePrompt).mock.calls[0]?.[0]).toEqual({
			draft: 'Queued message 0',
			target: 'prompt',
		});
		expect(screen.getByTestId('queue-notifications').textContent).toContain(
			m.prompt_refinement_refined(),
		);
		expect(document.activeElement).toBe(textarea);
		expect(textarea.selectionStart).toBe('Refined queued message'.length);
	});

	it('locks draft mutations while refinement is pending and cancels on Escape first', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		renderHost(queue([entry(0)]));
		const textarea = await beginEditing(0);
		const dialog = screen.getByRole('dialog');

		await fireEvent.click(screen.getByRole('button', { name: m.prompt_refinement_refine() }));
		await screen.findByRole('button', { name: m.prompt_refinement_cancel() });
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		expect(textarea.readOnly).toBe(true);
		expect(
			(screen.getByRole('button', { name: m.chat_queue_save_edit() }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: m.chat_queue_open_expanded_editor() }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(vi.mocked(refinementApi.refinePrompt)).toHaveBeenCalledOnce();

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		expect((options?.signal as AbortSignal).aborted).toBe(true);
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(document.activeElement).toBe(textarea);
		expect(textarea.readOnly).toBe(false);

		await fireEvent.keyDown(dialog, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('discards an editor with pending refinement by aborting the request', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		renderHost(queue([entry(0)]));
		await beginEditing(0);

		await fireEvent.click(screen.getByRole('button', { name: m.prompt_refinement_refine() }));
		await screen.findByRole('button', { name: m.prompt_refinement_cancel() });
		const [, options] = vi.mocked(refinementApi.refinePrompt).mock.calls[0];

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_discard() }));

		expect((options?.signal as AbortSignal).aborted).toBe(true);
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('ignores a refinement result after a newer editor session begins', async () => {
		const pending = deferredRefinement();
		vi.mocked(refinementApi.refinePrompt).mockReturnValueOnce(pending.promise);
		const { component } = renderHost(queue([entry(0), entry(1)]));
		await beginEditing(0);

		await fireEvent.click(screen.getByRole('button', { name: m.prompt_refinement_refine() }));
		component.beginEdit(entry(1));
		const nextTextarea = (await waitFor(() => {
			const textbox = screen.getByRole('textbox', {
				name: m.chat_queue_edit_message(),
			}) as HTMLTextAreaElement;
			expect(textbox.value).toBe('Queued message 1');
			return textbox;
		})) as HTMLTextAreaElement;

		pending.resolve({ success: true, refinedPrompt: 'Stale refined draft' });

		await waitFor(() =>
			expect(screen.getByTestId('queue-notifications').textContent).toContain(
				m.prompt_refinement_draft_changed(),
			),
		);
		expect(nextTextarea.value).toBe('Queued message 1');
	});

	it('blocks refinement while the edited entry is steering', async () => {
		const { component } = renderHost(queue([entry(0), entry(1)]));
		await beginEditing(1);

		component.setQueue(queue([entry(0), entry(1)], { steeringEntryId: 'entry-1' }));

		await waitFor(() => expect(screen.getByText(m.chat_queue_steering())).toBeTruthy());
		expect(
			(screen.getByRole('button', { name: m.prompt_refinement_refine() }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it('expands the draft into the shared editor and restores the compact field on close', async () => {
		renderHost(queue([entry(0)]));
		const textarea = await beginEditing(0);
		await fireEvent.input(textarea, { target: { value: 'Draft to expand' } });
		textarea.setSelectionRange(5, 9, 'backward');

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_open_expanded_editor() }));
		const editorDialog = await screen.findByRole('dialog', {
			name: m.chat_queue_expanded_editor_title(),
		});
		const expandedEditor = await within(editorDialog).findByRole('textbox', {
			name: m.chat_queue_expanded_editor_label(),
		});
		expect((expandedEditor as HTMLTextAreaElement).value).toBe('Draft to expand');

		const { emitLastPromptEditorTextChange } = await import(
			'$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'
		);
		emitLastPromptEditorTextChange('Draft expanded and edited');
		await waitFor(() => expect(textarea.value).toBe('Draft expanded and edited'));

		await fireEvent.click(
			within(editorDialog).getByRole('button', { name: m.prompt_editor_close() }),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole('dialog', { name: m.chat_queue_expanded_editor_title() }),
			).toBeNull(),
		);
		expect(document.activeElement).toBe(textarea);
		expect(textarea.selectionStart).toBe(5);
		expect(textarea.selectionEnd).toBe(9);
		expect(textarea.selectionDirection).toBe('backward');
	});

	it('keeps an expanded departed draft editable and syncs the recovery card', async () => {
		const { component } = renderHost(queue([entry(0), entry(1)]));
		const textarea = await beginEditing(0);

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_open_expanded_editor() }));
		const editorDialog = await screen.findByRole('dialog', {
			name: m.chat_queue_expanded_editor_title(),
		});
		await within(editorDialog).findByRole('textbox', {
			name: m.chat_queue_expanded_editor_label(),
		});

		component.setQueue(queue([entry(1)]));

		await waitFor(() => expect(screen.getByText(m.chat_queue_no_longer_queued())).toBeTruthy());
		const { emitLastPromptEditorTextChange } = await import(
			'$lib/components/prompt-editor/__tests__/PromptEditorStub.svelte'
		);
		emitLastPromptEditorTextChange('Recovered from the expanded editor');

		const recoveryTextarea = (await waitFor(() =>
			screen.getByRole('textbox', { name: m.chat_queue_edit_message() }),
		)) as HTMLTextAreaElement;
		expect(recoveryTextarea).not.toBe(textarea);
		expect(recoveryTextarea.value).toBe('Recovered from the expanded editor');
		expect(document.querySelector('ol')?.contains(recoveryTextarea)).toBe(false);
		expect(
			(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() }) as HTMLButtonElement)
				.disabled,
		).toBe(false);

		await fireEvent.click(
			within(editorDialog).getByRole('button', { name: m.prompt_editor_close() }),
		);
		await waitFor(() => expect(document.activeElement).toBe(recoveryTextarea));
	});

	it('refines from the expanded editor and keeps focus there', async () => {
		vi.mocked(refinementApi.refinePrompt).mockResolvedValueOnce({
			success: true,
			refinedPrompt: 'Refined from expanded',
		});
		renderHost(queue([entry(0)]));
		await beginEditing(0);

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_open_expanded_editor() }));
		const editorDialog = await screen.findByRole('dialog', {
			name: m.chat_queue_expanded_editor_title(),
		});
		const expandedEditor = (await within(editorDialog).findByRole('textbox', {
			name: m.chat_queue_expanded_editor_label(),
		})) as HTMLTextAreaElement;

		await fireEvent.click(
			within(editorDialog).getByRole('button', { name: m.prompt_refinement_refine() }),
		);

		await waitFor(() => expect(expandedEditor.value).toBe('Refined from expanded'));
		await waitFor(() => expect(document.activeElement).toBe(expandedEditor));
		const compactTextarea = screen.getByRole('textbox', {
			name: m.chat_queue_edit_message(),
		}) as HTMLTextAreaElement;
		expect(compactTextarea.value).toBe('Refined from expanded');
	});
});
