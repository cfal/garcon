import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueuedInputsDialogTestHost from './QueuedInputsDialogTestHost.svelte';
import type {
	ChatQueueState,
	QueueEntry,
	QueuePause,
	RecoveredInputContinuation,
} from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';

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
		dispatchingEntryId: null,
		recentlyDispatched: [],
		pause: null,
		...overrides,
	};
}

function manualPause(id = 'pause-1'): QueuePause {
	return { id, kind: 'manual', pausedAt: '2026-07-16T00:00:00.000Z' };
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

function continuation(): RecoveredInputContinuation {
	return {
		id: '19e6da82-7978-4cb1-b481-b71142fca0c4',
		installedAt: '2026-07-18T00:00:00.000Z',
	};
}

function renderDialog(
	initialQueue: ChatQueueState,
	initialContinuation: RecoveredInputContinuation | null = null,
) {
	const onCreate = vi.fn().mockResolvedValue(undefined);
	const onReplace = vi.fn().mockResolvedValue(undefined);
	const onDelete = vi.fn().mockResolvedValue(undefined);
	const onPause = vi.fn().mockResolvedValue(undefined);
	const onResume = vi.fn().mockResolvedValue(undefined);
	const onContinue = vi.fn().mockResolvedValue(undefined);
	const result = render(QueuedInputsDialogTestHost, {
		initialQueue,
		initialContinuation,
		onCreate,
		onReplace,
		onDelete,
		onPause,
		onResume,
		onContinue,
	});
	return { ...result, onCreate, onReplace, onDelete, onPause, onResume, onContinue };
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

		component.setQueue(queue([entry(0), entry(1), entry(2)]));
		await waitFor(() => expect(screen.getByText('Queued message 2')).toBeTruthy());

		component.setQueue(queue([entry(1), entry(2)]));
		await waitFor(() => expect(screen.queryByText('Queued message 0')).toBeNull());

		component.setQueue(queue([]));
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
			}),
		);

		await waitFor(() => expect(screen.getByText(m.chat_queue_already_sent())).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe('Recovered local draft');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() }));
		expect(onCreate).toHaveBeenCalledWith('Recovered local draft');
	});

	it('locks a departed draft while queue-as-new is pending', async () => {
		const pendingCreate = deferred<void>();
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		onCreate.mockReturnValueOnce(pendingCreate.promise);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Captured departed draft' } });
		component.setQueue(
			queue([], {
				recentlyDispatched: [{ entryId: 'entry-0', dispatchedAt: '2026-07-16T00:01:00.000Z' }],
			}),
		);
		const queueAsNew = await screen.findByRole('button', {
			name: m.chat_queue_queue_draft_as_new(),
		});
		await fireEvent.click(queueAsNew);

		await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
		expect((textarea as HTMLTextAreaElement).disabled).toBe(true);

		pendingCreate.resolve();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('prevents a new-ID retry when queue-as-new remains ambiguous', async () => {
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		onCreate.mockRejectedValueOnce(new CommandOutcomeUnknownError());
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Possibly queued draft' } });
		component.setQueue(queue([]));

		await fireEvent.click(await screen.findByRole('button', {
			name: m.chat_queue_queue_draft_as_new(),
		}));

		await waitFor(() => expect(screen.getByText(m.chat_notice_queue_outcome_unconfirmed())).toBeTruthy());
		expect(onCreate).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeNull();
		expect((textarea as HTMLTextAreaElement).value).toBe('Possibly queued draft');
	});

	it('shows a revision conflict without overwriting the draft and can reload latest', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'My draft' } });

		component.setQueue(queue([entry(0, 2, 'Edited elsewhere')]));

		await waitFor(() => expect(screen.getByText(m.chat_queue_changed_elsewhere())).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe('My draft');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_reload_latest() }));
		expect((textarea as HTMLTextAreaElement).value).toBe('Edited elsewhere');
	});

	it('deletes the selected stable ID after an earlier row disappears', async () => {
		const { component, onDelete } = renderDialog(queue([entry(0), entry(1), entry(2)]));
		component.setQueue(queue([entry(1), entry(2)]));
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

	it('keeps the active draft when another row edit is attempted', async () => {
		renderDialog(queue([entry(0), entry(1)]));
		const editButtons = screen.getAllByRole('button', { name: m.chat_queue_edit_message() });

		await fireEvent.click(editButtons[0]);
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Unsaved first draft' } });
		expect((editButtons[1] as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(editButtons[1]);

		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect((textarea as HTMLTextAreaElement).value).toBe('Unsaved first draft');
	});

	it('locks the editor while a replacement is pending', async () => {
		const pendingSave = deferred<void>();
		const { onReplace } = renderDialog(queue([entry(0)]));
		onReplace.mockReturnValueOnce(pendingSave.promise);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Captured replacement' } });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_save_edit() }));

		await waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
		expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
		expect(
			(screen.getByRole('button', { name: m.chat_queue_discard() }) as HTMLButtonElement).disabled,
		).toBe(true);

		pendingSave.resolve();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
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
		component.setQueue(queue([], { dispatchingEntryId: 'entry-0' }));

		await waitFor(() => expect(screen.getByText(m.chat_queue_agent_processing())).toBeTruthy());
		expect(screen.queryByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeNull();

		component.setQueue(
			queue([], {
				recentlyDispatched: [{ entryId: 'entry-0', dispatchedAt: '2026-07-16T00:01:00.000Z' }],
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
		component.setQueue(queue([entry(1)]));

		await waitFor(() => expect(screen.getByText(m.chat_queue_no_longer_queued())).toBeTruthy());
		const remainingEdit = screen.getByRole('button', { name: m.chat_queue_edit_message() });
		expect((remainingEdit as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_discard() }));

		await waitFor(() => {
			expect(document.activeElement).toBe(document.querySelector('[data-queue-list-heading]'));
		});
	});

	it('shows live paused state and resumes from inside the dialog', async () => {
		const { component, onResume } = renderDialog(queue([entry(0)], { pause: manualPause() }));
		expect(screen.getByText(m.chat_queue_paused())).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_resume() }));
		expect(onResume).toHaveBeenCalledWith('pause-1');

		component.setQueue(queue([entry(0)], { pause: null }));
		await waitFor(() => expect(screen.queryByText(m.chat_queue_paused())).toBeNull());
	});

	it('pauses an unpaused queue from inside the dialog', async () => {
		const { onPause } = renderDialog(queue([entry(0)]));

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_pause() }));

		expect(onPause).toHaveBeenCalledOnce();
	});

	it.each([
		['queued-turn-failed', m.chat_queue_pause_failed_detail()],
		['recovered-inflight', m.chat_queue_pause_recovered_detail()],
		['completion-uncertain', m.chat_queue_pause_completion_uncertain_detail()],
		['unknown', m.chat_queue_pause_unknown_detail()],
	] as const)('renders the %s automatic pause reason', (kind, detail) => {
		const pause: QueuePause =
			kind === 'unknown'
				? { id: 'pause-1', kind, entryId: 'entry-0', pausedAt: null }
				: {
						id: 'pause-1',
						kind,
						entryId: 'entry-0',
						pausedAt: '2026-07-16T00:00:00.000Z',
					};
		renderDialog(queue([entry(0)], { pause }));

		expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy();
		expect(screen.getByText(detail)).toBeTruthy();
	});

	it('continues recovered input independently from a real queue pause', async () => {
		const recovered = continuation();
		const { component, onContinue, onResume } = renderDialog(
			queue([entry(0)], { pause: manualPause() }),
			recovered,
		);

		expect(screen.getByText(m.chat_queue_recovered_input_continuation_detail())).toBeTruthy();
		expect(screen.getByRole('button', { name: m.chat_queue_continue() })).toBeTruthy();
		expect(screen.getByRole('button', { name: m.chat_queue_resume() })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_continue() }));
		expect(onContinue).toHaveBeenCalledWith(recovered.id);
		expect(onResume).not.toHaveBeenCalled();

		component.setContinuation(null);
		await waitFor(() => {
			expect(screen.queryByText(m.chat_queue_recovered_input_continuation_detail())).toBeNull();
		});
		expect(screen.getByRole('button', { name: m.chat_queue_resume() })).toBeTruthy();
	});

	it('keeps a live superseding pause when an earlier resume is still pending', async () => {
		const pendingResume = deferred<void>();
		const { component, onResume } = renderDialog(
			queue([entry(0)], {
				pause: manualPause('pause-old'),
			}),
		);
		onResume.mockReturnValueOnce(pendingResume.promise);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_resume() }));

		component.setQueue(
			queue([entry(0)], {
				pause: {
					id: 'pause-new',
					kind: 'queued-turn-failed',
					entryId: 'entry-0',
					pausedAt: '2026-07-16T00:01:00.000Z',
				},
			}),
		);
		await waitFor(() => expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy());

		pendingResume.reject(new Error('The queue pause changed before it could be resumed'));
		await waitFor(() =>
			expect(screen.getByText('The queue pause changed before it could be resumed')).toBeTruthy(),
		);
		expect(onResume).toHaveBeenCalledWith('pause-old');
		expect(screen.getByText(m.chat_queue_pause_failed_detail())).toBeTruthy();
	});

	it('explains when the entry associated with an automatic pause was removed', () => {
		renderDialog(
			queue([entry(1)], {
				pause: {
					id: 'pause-1',
					kind: 'completion-uncertain',
					entryId: 'entry-0',
					pausedAt: '2026-07-16T00:00:00.000Z',
				},
			}),
		);

		expect(screen.getByText(m.chat_queue_pause_affected_removed())).toBeTruthy();
	});

	it('does not leak a late resume failure into a reopened dialog', async () => {
		const pendingResume = deferred<void>();
		const { component, onResume } = renderDialog(queue([entry(0)], { pause: manualPause() }));
		onResume.mockReturnValueOnce(pendingResume.promise);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_resume() }));
		await waitFor(() => expect(onResume).toHaveBeenCalledOnce());

		component.closeDialog();
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		component.openDialog();
		await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
		const reopenedResume = screen.getByRole('button', { name: m.chat_queue_resume() });
		expect((reopenedResume as HTMLButtonElement).disabled).toBe(false);

		pendingResume.reject(new Error('old dialog failed'));
		await waitFor(() => expect(screen.queryByText('old dialog failed')).toBeNull());
		expect((reopenedResume as HTMLButtonElement).disabled).toBe(false);
	});
});
