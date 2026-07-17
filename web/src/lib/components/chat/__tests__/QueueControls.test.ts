import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import type { QueueEntry, QueuePause, QueueState } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
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

function manualPause(id = 'pause-1'): QueuePause {
	return { id, kind: 'manual', pausedAt: '2026-02-27T00:00:00.000Z' };
}

function makeQueue(count: number, pause: QueuePause | null = null): QueueState {
	return {
		entries: Array.from({ length: count }, (_, index) => makeEntry(index)),
		dispatchingEntryId: null,
		recentlyDispatched: [],
		pause: count > 0 ? pause : null,
		version: 1,
		updatedAt: '2026-02-27T00:00:00.000Z',
	};
}

function renderControls(
	queue: QueueState,
	props: Partial<{
		canInterrupt: boolean;
		onInterrupt: () => void | Promise<void>;
		onPause: () => Promise<void>;
		onResume: (pauseId: string) => Promise<void>;
		onQueueControlError: (action: 'pause' | 'resume', error: unknown) => void;
		onEdit: (entry: QueueEntry) => void;
		onOpenManager: () => void;
		onDelete: (entryId: string) => Promise<void>;
	}> = {},
) {
	return render(QueueControls, {
		queue,
		onPause: vi.fn().mockResolvedValue(undefined),
		onResume: vi.fn().mockResolvedValue(undefined),
		onQueueControlError: vi.fn(),
		onEdit: vi.fn(),
		onOpenManager: vi.fn(),
		onDelete: vi.fn().mockResolvedValue(undefined),
		...props,
	});
}

describe('QueueControls', () => {
	it('hides the tray when there are no queued entries', () => {
		const { container } = renderControls(makeQueue(0, manualPause()));

		expect(container.textContent?.trim() || '').toBe('');
	});

	it('shows the resume action for a paused queue', () => {
		const onResume = vi.fn();
		renderControls(makeQueue(1, manualPause()), { onResume });

		expect(screen.getByRole('button', { name: m.chat_queue_resume() })).toBeTruthy();
		expect(screen.queryByRole('button', { name: m.chat_queue_pause() })).toBeNull();
	});

	it('shows pause for an unpaused single-entry queue', async () => {
		const onPause = vi.fn().mockResolvedValue(undefined);
		renderControls(makeQueue(1), { onPause });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_pause() }));
		expect(onPause).toHaveBeenCalledOnce();
	});

	it('shows interrupt and send when the current turn can be interrupted', async () => {
		const onInterrupt = vi.fn();
		renderControls(makeQueue(1), { canInterrupt: true, onInterrupt });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() }));
		expect(onInterrupt).toHaveBeenCalledOnce();
	});

	it.each([
		{ pause: manualPause(), name: m.chat_queue_resume(), prop: 'onResume' as const },
		{ pause: null, name: m.chat_queue_pause(), prop: 'onPause' as const },
		{
			pause: null,
			name: m.chat_queue_interrupt_and_send(),
			prop: 'onInterrupt' as const,
		},
	])('guards $prop while its request is pending', async ({ pause, name, prop }) => {
		const pendingMutation = deferred<void>();
		const mutation = vi.fn(() => pendingMutation.promise);
		renderControls(makeQueue(1, pause), {
			canInterrupt: !pause,
			[prop]: mutation,
		});
		const button = screen.getByRole('button', { name });

		await fireEvent.click(button);
		await fireEvent.click(button);

		expect(mutation).toHaveBeenCalledOnce();
		expect((button as HTMLButtonElement).disabled).toBe(true);
		pendingMutation.resolve();
		await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
	});

	it('resumes with the rendered pause ID and hides interrupt while paused', async () => {
		const onResume = vi.fn().mockResolvedValue(undefined);
		renderControls(makeQueue(1, manualPause('pause-captured')), {
			canInterrupt: true,
			onInterrupt: vi.fn(),
			onResume,
		});

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_resume() }));
		expect(onResume).toHaveBeenCalledWith('pause-captured');
		expect(screen.queryByRole('button', { name: m.chat_queue_interrupt_and_send() })).toBeNull();
	});

	it('renders automatic pauses as needing attention', () => {
		renderControls(makeQueue(1, {
			id: 'pause-failed',
			kind: 'queued-turn-failed',
			entryId: 'q0',
			pausedAt: '2026-02-27T00:00:00.000Z',
		}));

		expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy();
	});

	it.each(['pause', 'resume'] as const)(
		'catches a rejected %s callback and restores the control',
		async (action) => {
			const pending = deferred<void>();
			const onQueueControlError = vi.fn();
			const props = action === 'pause'
				? { onPause: vi.fn(() => pending.promise) }
				: { onResume: vi.fn(() => pending.promise) };
			renderControls(makeQueue(1, action === 'resume' ? manualPause() : null), {
				...props,
				onQueueControlError,
			});
			const button = screen.getByRole('button', {
				name: action === 'pause' ? m.chat_queue_pause() : m.chat_queue_resume(),
			});

			await fireEvent.click(button);
			pending.reject(new Error(`${action} failed`));

			await waitFor(() => expect(onQueueControlError).toHaveBeenCalledWith(
				action,
				expect.objectContaining({ message: `${action} failed` }),
			));
			expect((button as HTMLButtonElement).disabled).toBe(false);
		},
	);

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
