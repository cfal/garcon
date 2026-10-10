import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QueuedInputEditorDialogTestHost from './QueuedInputEditorDialogTestHost.svelte';
import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';

function entry(index: number, revision = 1, content = `Queued message ${index}`): QueueEntry {
	return {
		id: `entry-${index}`,
		content,
		kind: 'turn',
		attachments: [],
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function renderDialog(initialQueue: ChatQueueState) {
	const onCreate = vi.fn().mockResolvedValue(undefined);
	const onReplace = vi.fn().mockResolvedValue(undefined);
	const onDelete = vi.fn().mockResolvedValue(undefined);
	const onMove = vi.fn().mockResolvedValue(undefined);
	const onPause = vi.fn().mockResolvedValue(undefined);
	const onResume = vi.fn().mockResolvedValue(undefined);
	const result = render(QueuedInputEditorDialogTestHost, {
		initialQueue,
		onCreate,
		onReplace,
		onDelete,
		onMove,
		onPause,
		onResume,
	});
	return { ...result, onCreate, onReplace, onDelete, onMove, onPause, onResume };
}

async function editMessage(index = 0) {
	const trigger = screen.getAllByRole('button', { name: m.chat_queue_edit_message() })[index];
	trigger.focus();
	await fireEvent.click(trigger);
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = '';
	vi.unstubAllGlobals();
});

describe('QueuedInputEditorDialog', () => {
	it('returns to the composer when the last queued message departs', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await editMessage();
		component.setQueue(queue([]));
		await screen.findByText(m.chat_queue_no_longer_queued());
		await fireEvent.click(screen.getByRole('button', { name: m.common_cancel() }));
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Composer' })),
		);
	});
	it('keeps focus and selection when an edited message departs and returns to the queue on cancel', async () => {
		const { component } = renderDialog(queue([entry(0), entry(1)]));
		await editMessage();
		const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
		await fireEvent.input(textarea, { target: { value: 'Keep this selected draft' } });
		textarea.focus();
		textarea.setSelectionRange(5, 9, 'backward');
		component.setQueue(queue([entry(1)]));
		await screen.findByText(m.chat_queue_no_longer_queued());
		expect(screen.getByRole('textbox')).toBe(textarea);
		expect(document.activeElement).toBe(textarea);
		expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([
			5,
			9,
			'backward',
		]);
		await fireEvent.click(screen.getByRole('button', { name: m.common_cancel() }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(document.querySelector('[data-queue-status-summary]')),
		);
	});

	it('replaces a conflict using the latest revision and closes after saving', async () => {
		const { component, onReplace } = renderDialog(queue([entry(0)]));
		await editMessage();
		await fireEvent.input(screen.getByRole('textbox'), {
			target: { value: 'Preserved local edit' },
		});
		component.setQueue(queue([entry(0, 2, 'Remote edit')]));
		await screen.findByText(m.chat_queue_changed_elsewhere());
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_replace_latest() }));
		expect(onReplace).toHaveBeenCalledWith('entry-0', 'Preserved local edit', 2);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
	it('preserves a departed draft and queues it as a new entry', async () => {
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Recovered local draft' } });

		component.setQueue(
			queue([], {
				recentlyDispatched: [
					{
						entryId: 'entry-0',
						revision: 1,
						dispatchedAt: '2026-07-16T00:01:00.000Z',
					},
				],
			}),
		);

		await waitFor(() => expect(screen.getByText(m.chat_queue_already_sent())).toBeTruthy());
		const recoveryTextarea = screen.getByRole('textbox', {
			name: m.chat_queue_edit_message(),
		}) as HTMLTextAreaElement;
		expect(recoveryTextarea.value).toBe('Recovered local draft');
		expect(recoveryTextarea).toBe(textarea);
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() }));
		expect(onCreate).toHaveBeenCalledWith('Recovered local draft');
	});

	it('says a departed attachment draft queues as new without its attachments', async () => {
		const attachments = [{ name: 'screen.png', mimeType: 'image/png' }];
		const { component, onCreate } = renderDialog(queue([{ ...entry(0), attachments }]));
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Recovered caption' } });
		expect(screen.queryByText(m.chat_queue_draft_attachments_omitted())).toBeNull();

		component.setQueue(queue([]));

		await waitFor(() => expect(screen.getByText(m.chat_queue_no_longer_queued())).toBeTruthy());
		expect(screen.getByText(m.chat_queue_draft_attachments_omitted())).toBeTruthy();
		expect(screen.queryByRole('list', { name: m.chat_queue_attachments({ count: 1 }) })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() }));
		expect(onCreate).toHaveBeenCalledWith('Recovered caption');
	});

	it('locks a departed draft while queue-as-new is pending', async () => {
		const pendingCreate = deferred<void>();
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		onCreate.mockReturnValueOnce(pendingCreate.promise);
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Captured departed draft' } });
		component.setQueue(
			queue([], {
				recentlyDispatched: [
					{
						entryId: 'entry-0',
						revision: 1,
						dispatchedAt: '2026-07-16T00:01:00.000Z',
					},
				],
			}),
		);
		const queueAsNew = await screen.findByRole('button', {
			name: m.chat_queue_queue_draft_as_new(),
		});
		await fireEvent.click(queueAsNew);

		await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
		const pendingTextarea = screen.getByRole('textbox', {
			name: m.chat_queue_edit_message(),
		}) as HTMLTextAreaElement;
		expect(pendingTextarea.disabled).toBe(true);

		pendingCreate.resolve();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('prevents a new-ID retry when queue-as-new remains ambiguous', async () => {
		const { component, onCreate } = renderDialog(queue([entry(0)]));
		onCreate.mockRejectedValueOnce(new CommandOutcomeUnknownError());
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Possibly queued draft' } });
		component.setQueue(queue([]));

		await fireEvent.click(
			await screen.findByRole('button', {
				name: m.chat_queue_queue_draft_as_new(),
			}),
		);

		await waitFor(() =>
			expect(screen.getByText(m.chat_notice_queue_outcome_unconfirmed())).toBeTruthy(),
		);
		expect(onCreate).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeNull();
		const ambiguousTextarea = screen.getByRole('textbox', {
			name: m.chat_queue_edit_message(),
		}) as HTMLTextAreaElement;
		expect(ambiguousTextarea.value).toBe('Possibly queued draft');
	});

	it('shows a revision conflict without overwriting the draft and can reload latest', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'My draft' } });

		component.setQueue(queue([entry(0, 2, 'Edited elsewhere')]));

		await waitFor(() => expect(screen.getByText(m.chat_queue_changed_elsewhere())).toBeTruthy());
		expect((textarea as HTMLTextAreaElement).value).toBe('My draft');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_reload_latest() }));
		expect((textarea as HTMLTextAreaElement).value).toBe('Edited elsewhere');
	});

	it('keeps the queue editor large enough to avoid iPhone focus zoom', async () => {
		renderDialog(queue([entry(0)]));
		await editMessage();

		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		expect(textarea.classList.contains('text-base')).toBe(true);
		expect(textarea.classList.contains('text-sm')).toBe(false);
		expect(textarea.classList.contains('sm:pointer-fine:text-sm')).toBe(true);
	});

	it('shares the save predicate between the button and keyboard shortcut', async () => {
		const { onReplace } = renderDialog(queue([entry(0)]));
		await editMessage();
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

	it('shows queued attachments and saves an attachment entry with empty text', async () => {
		const attachments = [
			{ name: 'screen.png', mimeType: 'image/png' },
			{ name: 'trace.pdf', mimeType: 'application/pdf' },
		];
		const { onReplace } = renderDialog(queue([{ ...entry(0), attachments }]));
		await editMessage();
		const dialog = screen.getByRole('dialog');
		const list = within(dialog).getByRole('list', {
			name: m.chat_queue_attachments({ count: 2 }),
		});
		expect(within(list).getByText('screen.png')).toBeTruthy();
		expect(within(list).getByText('trace.pdf')).toBeTruthy();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		const save = screen.getByRole('button', { name: m.chat_queue_save_edit() });
		expect(
			within(dialog).getAllByRole('list', { name: m.chat_queue_attachments({ count: 2 }) }),
		).toHaveLength(1);

		await fireEvent.input(textarea, { target: { value: '' } });
		expect((save as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		await waitFor(() => {
			expect(onReplace).toHaveBeenCalledWith('entry-0', '', 1);
		});
	});

	it('locks the editor while a replacement is pending', async () => {
		const pendingSave = deferred<void>();
		const { onReplace } = renderDialog(queue([entry(0)]));
		onReplace.mockReturnValueOnce(pendingSave.promise);
		await editMessage();
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Captured replacement' } });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_save_edit() }));

		await waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
		expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
		expect(
			(screen.getByRole('button', { name: m.common_cancel() }) as HTMLButtonElement).disabled,
		).toBe(true);

		pendingSave.resolve();
		await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
	});

	it('blocks an open sibling editor while another queued entry is steering', async () => {
		const { component, onReplace } = renderDialog(queue([entry(0), entry(1)]));
		await editMessage(1);
		const textarea = screen.getByRole('textbox', { name: m.chat_queue_edit_message() });
		await fireEvent.input(textarea, { target: { value: 'Sibling draft' } });
		textarea.focus();

		component.setQueue(queue([entry(0), entry(1)], { steeringEntryId: 'entry-0' }));

		await waitFor(() => expect((textarea as HTMLTextAreaElement).readOnly).toBe(true));
		expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
		expect(document.activeElement).toBe(textarea);
		expect(textarea.getAttribute('aria-describedby')).toContain('queued-input-status');
		expect(screen.getByText(m.chat_queue_other_message_steering())).toBeTruthy();
		const save = screen.getByRole('button', { name: m.chat_queue_save_edit() });
		expect((save as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onReplace).not.toHaveBeenCalled();

		component.setQueue(queue([entry(0), entry(1)]));
		await waitFor(() => expect((textarea as HTMLTextAreaElement).readOnly).toBe(false));
		expect((save as HTMLButtonElement).disabled).toBe(false);
	});

	it('ignores a late save result after a newer editor session begins', async () => {
		const pendingSave = deferred<void>();
		const { component, onReplace } = renderDialog(queue([entry(0), entry(1)]));
		onReplace.mockReturnValueOnce(pendingSave.promise);
		await editMessage(0);
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
		await editMessage();
		const textarea = screen.getByRole('textbox');
		await fireEvent.input(textarea, { target: { value: '  indented\n' } });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_save_edit() }));

		await waitFor(() => {
			expect(onReplace).toHaveBeenCalledWith('entry-0', '  indented\n', 1);
		});
	});

	it('offers a dequeued queue draft as a new message', async () => {
		const { component } = renderDialog(queue([entry(0)]));
		await editMessage();
		component.setQueue(
			queue([], {
				recentlyDispatched: [
					{
						entryId: 'entry-0',
						revision: 1,
						dispatchedAt: '2026-07-16T00:01:00.000Z',
					},
				],
			}),
		);
		await waitFor(() => {
			expect(screen.getByRole('button', { name: m.chat_queue_queue_draft_as_new() })).toBeTruthy();
		});
	});
});
