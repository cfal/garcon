import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import type { QueueEntry, QueueState } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeEntry(index: number): QueueEntry {
	return {
		id: `q${index}`,
		content: `queued ${index}`,
		revision: 1,
		createdAt: '2026-02-27T00:00:00.000Z',
		updatedAt: '2026-02-27T00:00:00.000Z',
	};
}

function makeQueue(count: number, paused = false): QueueState {
	return {
		entries: Array.from({ length: count }, (_, index) => makeEntry(index)),
		dispatchingEntryId: null,
		recentlyDispatched: [],
		paused,
		version: 1,
		updatedAt: '2026-02-27T00:00:00.000Z',
	};
}

function renderControls(
	queue: QueueState,
	props: Partial<{
		canInterrupt: boolean;
		onInterrupt: () => void;
		onResume: () => void;
		onEdit: (entry: QueueEntry) => void;
		onOpenManager: () => void;
		onDelete: (entryId: string) => Promise<void>;
	}> = {},
) {
	return render(QueueControls, {
		queue,
		onEdit: vi.fn(),
		onOpenManager: vi.fn(),
		onDelete: vi.fn().mockResolvedValue(undefined),
		...props,
	});
}

describe('QueueControls', () => {
	it('hides the tray when there are no queued entries', () => {
		const { container } = renderControls(makeQueue(0, true), { onResume: vi.fn() });

		expect(container.textContent?.trim() || '').toBe('');
	});

	it('shows the resume action for a paused queue', () => {
		const onResume = vi.fn();
		renderControls(makeQueue(1, true), { onResume });

		expect(screen.getByRole('button', { name: m.chat_queue_send_now() })).toBeTruthy();
	});

	it('shows interrupt and send when the current turn can be interrupted', async () => {
		const onInterrupt = vi.fn();
		renderControls(makeQueue(1), { canInterrupt: true, onInterrupt });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() }));
		expect(onInterrupt).toHaveBeenCalledOnce();
	});

	it('renders only the FIFO head and preserves its newline formatting', () => {
		const queue = makeQueue(5);
		queue.entries[0] = { ...queue.entries[0], content: 'first line\nsecond line' };
		const { container } = renderControls(queue);

		expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			'first line\nsecond line',
		);
		expect(screen.queryByText('queued 1')).toBeNull();
		expect(screen.queryByText('queued 4')).toBeNull();
	});

	it('passes the captured head entry and ID to edit and delete actions', async () => {
		const queue = makeQueue(3);
		const onEdit = vi.fn();
		const onDelete = vi.fn().mockResolvedValue(undefined);
		renderControls(queue, { onEdit, onDelete });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_remove_from_queue() }));

		expect(onEdit).toHaveBeenCalledWith(queue.entries[0]);
		expect(onDelete).toHaveBeenCalledWith('q0');
	});

	it.each([2, 5, 100])('opens the manager with the total count for %i entries', async (count) => {
		const onOpenManager = vi.fn();
		renderControls(makeQueue(count), { onOpenManager });

		await fireEvent.click(
			screen.getByRole('button', {
				name: m.chat_queue_edit_queued_messages({ count }),
			}),
		);
		expect(onOpenManager).toHaveBeenCalledOnce();
	});

	it('does not render the manager action for a single entry', () => {
		renderControls(makeQueue(1));

		expect(
			screen.queryByRole('button', {
				name: m.chat_queue_edit_queued_messages({ count: 1 }),
			}),
		).toBeNull();
	});

	it('truncates only the inline preview', () => {
		const queue = makeQueue(1);
		queue.entries[0] = { ...queue.entries[0], content: 'x'.repeat(260) };
		const { container } = renderControls(queue);

		expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
			`${'x'.repeat(220)}...`,
		);
	});

	it('guards inline deletion while the request is pending', async () => {
		const pendingDelete = deferred<void>();
		const onDelete = vi.fn(() => pendingDelete.promise);
		renderControls(makeQueue(1), { onDelete });
		const deleteButton = screen.getByRole('button', { name: m.chat_queue_remove_from_queue() });

		await fireEvent.click(deleteButton);
		await fireEvent.click(deleteButton);

		expect(onDelete).toHaveBeenCalledOnce();
		expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
		pendingDelete.resolve();
		await waitFor(() => expect((deleteButton as HTMLButtonElement).disabled).toBe(false));
	});
});
