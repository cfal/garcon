import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueuedInputsDialogTestHost from './QueuedInputsDialogTestHost.svelte';
import type { QueueEntry, QueueState } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';

function entry(index: number, revision = 1, content = `Queued message ${index}`): QueueEntry {
	return {
		id: `entry-${index}`,
		content,
		revision,
		createdAt: '2026-07-16T00:00:00.000Z',
		updatedAt: '2026-07-16T00:00:00.000Z',
	};
}

function queue(entries: QueueEntry[], overrides: Partial<QueueState> = {}): QueueState {
	return {
		entries,
		dispatchingEntryId: null,
		recentlyDispatched: [],
		paused: false,
		version: 1,
		updatedAt: '2026-07-16T00:00:00.000Z',
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function renderDialog(initialQueue: QueueState) {
	const onCreate = vi.fn().mockResolvedValue(undefined);
	const onReplace = vi.fn().mockResolvedValue(undefined);
	const onDelete = vi.fn().mockResolvedValue(undefined);
	const onResume = vi.fn().mockResolvedValue(undefined);
	const result = render(QueuedInputsDialogTestHost, {
		initialQueue,
		onCreate,
		onReplace,
		onDelete,
		onResume,
	});
	return { ...result, onCreate, onReplace, onDelete, onResume };
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = '';
});

describe('QueuedInputsDialog', () => {
	it('renders every entry in FIFO order and handles a large queue', () => {
		renderDialog(queue(Array.from({ length: 100 }, (_, index) => entry(index))));

		const dialog = screen.getByRole('dialog');
		const visibleMessages = within(dialog).getAllByText(/Queued message \d+/);
		expect(visibleMessages).toHaveLength(100);
		expect(visibleMessages[0].textContent).toBe('Queued message 0');
		expect(visibleMessages.at(-1)?.textContent).toBe('Queued message 99');
	});

	it('updates live, removes popped rows, and stays open when the queue becomes empty', async () => {
		const { component } = renderDialog(queue([entry(0), entry(1)]));

		component.setQueue(queue([entry(0), entry(1), entry(2)], { version: 2 }));
		await waitFor(() => expect(screen.getByText('Queued message 2')).toBeTruthy());

		component.setQueue(queue([entry(1), entry(2)], { version: 3 }));
		await waitFor(() => expect(screen.queryByText('Queued message 0')).toBeNull());

		component.setQueue(queue([], { version: 4 }));
		await waitFor(() => expect(screen.getByText(m.chat_queue_empty())).toBeTruthy());
		expect(screen.getByRole('dialog')).toBeTruthy();
	});

	it('preserves a departed draft and queues it as a new entry', async () => {
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Recovered local draft' } });

		component.setQueue(
			queue([], {
				recentlyDispatched: [{ entryId: 'entry-0', dispatchedAt: '2026-07-16T00:01:00.000Z' }],
				version: 2,
			}),
		);

		await waitFor(() => expect(screen.getByText(m.chat_queue_already_sent())).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe('Recovered local draft');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() }));
		expect(onCreate).toHaveBeenCalledWith('Recovered local draft');
	});

	it('shows a revision conflict without overwriting the draft and can reload latest', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'My draft' } });

		component.setQueue(queue([entry(0, 2, 'Edited elsewhere')], { version: 2 }));

		await waitFor(() => expect(screen.getByText(m.chat_queue_changed_elsewhere())).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe('My draft');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_reload_latest() }));
		expect((textarea as HTMLTextAreaElement).value).toBe('Edited elsewhere');
	});

	it('deletes the selected stable ID after an earlier row disappears', async () => {
		const { component, onDelete } = renderDialog(queue([entry(0), entry(1), entry(2)]));
		component.setQueue(queue([entry(1), entry(2)], { version: 2 }));
		await waitFor(() => expect(screen.queryByText('Queued message 0')).toBeNull());

		const deleteButtons = screen.getAllByRole('button', {
			name: m.chat_queue_remove_from_queue(),
		});
		await fireEvent.click(deleteButtons[1]);

		expect(onDelete).toHaveBeenCalledWith('entry-2');
	});

	it('shares the save predicate between the button and keyboard shortcut', async () => {
		const { onReplace } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		const save = screen.getByRole('button', { name: m.chat_queue_save_edit() });

		await fireEvent.input(textarea, { target: { value: '   ' } });
		expect((save as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onReplace).not.toHaveBeenCalled();

		await fireEvent.input(textarea, { target: { value: 'Updated content' } });
		expect((save as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		await waitFor(() => {
			expect(onReplace).toHaveBeenCalledWith('entry-0', 'Updated content', 1);
		});
		await waitFor(() => {
			expect(document.activeElement).toBe(
				screen.getByRole('button', { name: m.chat_queue_edit_message() }),
			);
		});
	});

	it('focuses the textarea whenever a different row begins editing', async () => {
		renderDialog(queue([entry(0), entry(1)]));
		const editButtons = screen.getAllByRole('button', { name: m.chat_queue_edit_message() });

		await fireEvent.click(editButtons[0]);
		await fireEvent.click(editButtons[1]);

		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect((textarea as HTMLTextAreaElement).value).toBe('Queued message 1');
	});

	it('ignores a late save result after a newer editor session begins', async () => {
		const pendingSave = deferred<void>();
		const { component, onReplace } = renderDialog(queue([entry(0), entry(1)]));
		onReplace.mockReturnValueOnce(pendingSave.promise);
		await fireEvent.click(screen.getAllByRole('button', { name: m.chat_queue_edit_message() })[0]);
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'First draft' } });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_save_edit() }));

		component.beginEdit(entry(1));
		await waitFor(() => {
			expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Queued message 1');
		});
		pendingSave.resolve();

		await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy());
		expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Queued message 1');
	});

	it('preserves replacement whitespace while rejecting blank drafts', async () => {
		const { onReplace } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox');
		await fireEvent.input(textarea, { target: { value: '  indented\n' } });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_save_edit() }));

		await waitFor(() => {
			expect(onReplace).toHaveBeenCalledWith('entry-0', '  indented\n', 1);
		});
	});

	it('waits for dispatch completion before offering queue draft as new', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		component.setQueue(queue([], { dispatchingEntryId: 'entry-0', version: 2 }));

		await waitFor(() => expect(screen.getByText(m.chat_queue_agent_processing())).toBeTruthy());
		expect(screen.queryByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeNull();

		component.setQueue(
			queue([], {
				recentlyDispatched: [{ entryId: 'entry-0', dispatchedAt: '2026-07-16T00:01:00.000Z' }],
				version: 3,
			}),
		);
		await waitFor(() => {
			expect(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeTruthy();
		});
	});

	it('keeps a departed draft until discard and restores focus to the list heading', async () => {
		const { component } = renderDialog(queue([entry(0), entry(1)]));
		await fireEvent.click(screen.getAllByRole('button', { name: m.chat_queue_edit_message() })[0]);
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
		component.setQueue(queue([entry(1)], { version: 2 }));

		await waitFor(() => expect(screen.getByText(m.chat_queue_no_longer_queued())).toBeTruthy());
		const remainingEdit = screen.getByRole('button', { name: m.chat_queue_edit_message() });
		expect((remainingEdit as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_discard() }));

		await waitFor(() => {
			expect(document.activeElement).toBe(document.querySelector('[data-queue-list-heading]'));
		});
	});

	it('shows live paused state and resumes from inside the dialog', async () => {
		const { component, onResume } = renderDialog(queue([entry(0)], { paused: true }));
		expect(screen.getByText(m.chat_queue_paused())).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_send_now() }));
		expect(onResume).toHaveBeenCalledOnce();

		component.setQueue(queue([entry(0)], { paused: false, version: 2 }));
		await waitFor(() => expect(screen.queryByText(m.chat_queue_paused())).toBeNull());
	});
});
