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

function makeQueueWithIds(ids: string[], pause: QueuePause | null = null): QueueState {
	return {
		...makeQueue(ids.length, pause),
		entries: ids.map((id, index) => ({
			...makeEntry(index),
			id,
			content: `queued ${id}`,
		})),
	};
}

function renderControls(
	queue: QueueState,
	props: Partial<{
		chatId: string | null;
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
		chatId: 'chat-1',
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
		renderControls(
			makeQueue(1, {
				id: 'pause-failed',
				kind: 'queued-turn-failed',
				entryId: 'q0',
				pausedAt: '2026-02-27T00:00:00.000Z',
			}),
		);

		expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy();
	});

	it.each(['pause', 'resume'] as const)(
		'catches a rejected %s callback and restores the control',
		async (action) => {
			const pending = deferred<void>();
			const onQueueControlError = vi.fn();
			const props =
				action === 'pause'
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

			await waitFor(() =>
				expect(onQueueControlError).toHaveBeenCalledWith(
					action,
					expect.objectContaining({ message: `${action} failed` }),
				),
			);
			expect((button as HTMLButtonElement).disabled).toBe(false);
		},
	);

	it('starts a multi-entry browser at the FIFO head', () => {
		renderControls(makeQueueWithIds(['q0', 'q1', 'q2']));

		expect(screen.getByRole('region', { name: m.chat_queue_dialog_title() })).toBeTruthy();
		expect(screen.getByText('queued q0')).toBeTruthy();
		expect(screen.queryByText('queued q1')).toBeNull();
		expect(screen.getByText(m.chat_queue_message_position({ current: 1, total: 3 }))).toBeTruthy();
		expect(
			(
				screen.getByRole('button', {
					name: m.chat_queue_previous_message(),
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole('button', {
					name: m.chat_queue_next_message(),
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it('renders a single-entry count without browse or manager controls', () => {
		renderControls(makeQueue(1));

		expect(screen.getByText(m.chat_queue_single_message())).toBeTruthy();
		expect(screen.queryByRole('button', { name: m.chat_queue_previous_message() })).toBeNull();
		expect(screen.queryByRole('button', { name: m.chat_queue_next_message() })).toBeNull();
		expect(screen.queryByRole('button', { name: m.chat_queue_edit_queue() })).toBeNull();
		expect(screen.queryByText('Queued input')).toBeNull();
	});

	it('browses in FIFO order without wrapping', async () => {
		renderControls(makeQueueWithIds(['q0', 'q1', 'q2']));
		const previous = screen.getByRole('button', { name: m.chat_queue_previous_message() });
		const next = screen.getByRole('button', { name: m.chat_queue_next_message() });

		await fireEvent.click(next);
		expect(screen.getByText('queued q1')).toBeTruthy();
		expect(screen.getByText(m.chat_queue_message_position({ current: 2, total: 3 }))).toBeTruthy();
		expect((previous as HTMLButtonElement).disabled).toBe(false);
		expect((next as HTMLButtonElement).disabled).toBe(false);

		await fireEvent.click(next);
		expect(screen.getByText('queued q2')).toBeTruthy();
		expect((next as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.click(previous);
		expect(screen.getByText('queued q1')).toBeTruthy();
	});

	it('uses the displayed stable ID for entry actions while browse remains local', async () => {
		const queue = makeQueueWithIds(['q0', 'q1', 'q2']);
		const onEdit = vi.fn();
		const onDelete = vi.fn().mockResolvedValue(undefined);
		const onOpenManager = vi.fn();
		const onPause = vi.fn().mockResolvedValue(undefined);
		const onResume = vi.fn().mockResolvedValue(undefined);
		const onInterrupt = vi.fn();
		renderControls(queue, {
			canInterrupt: true,
			onEdit,
			onDelete,
			onOpenManager,
			onPause,
			onResume,
			onInterrupt,
		});

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_next_message() }));
		expect(onEdit).not.toHaveBeenCalled();
		expect(onDelete).not.toHaveBeenCalled();
		expect(onOpenManager).not.toHaveBeenCalled();
		expect(onPause).not.toHaveBeenCalled();
		expect(onResume).not.toHaveBeenCalled();
		expect(onInterrupt).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_message() }));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_remove_from_queue() }));

		expect(onEdit).toHaveBeenCalledWith(queue.entries[1]);
		expect(onDelete).toHaveBeenCalledWith('q1');
	});

	it('tracks the displayed entry by ID across live snapshots', async () => {
		const view = renderControls(makeQueueWithIds(['q0', 'q1', 'q2']), {
			canInterrupt: true,
			onInterrupt: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_next_message() }));
		await view.rerender({ queue: makeQueueWithIds(['q0', 'q1', 'q2', 'q3']) });
		expect(screen.getByText('queued q1')).toBeTruthy();
		expect(screen.getByText(m.chat_queue_message_position({ current: 2, total: 4 }))).toBeTruthy();

		await view.rerender({ queue: makeQueueWithIds(['q1', 'q2', 'q3']) });
		expect(screen.getByText('queued q1')).toBeTruthy();
		expect(screen.getByText(m.chat_queue_message_position({ current: 1, total: 3 }))).toBeTruthy();
		expect(screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() })).toBeTruthy();

		await view.rerender({ queue: makeQueueWithIds(['q2', 'q3']) });
		expect(screen.getByText('queued q2')).toBeTruthy();
		expect(screen.getByText(m.chat_queue_message_position({ current: 1, total: 2 }))).toBeTruthy();
	});

	it('starts at the new chat head when a retained component switches chats', async () => {
		const view = renderControls(makeQueueWithIds(['q0', 'q1']));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_next_message() }));
		expect(screen.getByText('queued q1')).toBeTruthy();

		await view.rerender({
			chatId: 'chat-2',
			queue: makeQueueWithIds(['other-0', 'other-1']),
		});

		expect(screen.getByText('queued other-0')).toBeTruthy();
		expect(screen.getByText(m.chat_queue_message_position({ current: 1, total: 2 }))).toBeTruthy();
	});

	it.each([2, 5, 100])('uses stable manager copy for %i entries', async (count) => {
		const onOpenManager = vi.fn();
		renderControls(makeQueue(count), { onOpenManager });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_edit_queue() }));
		expect(onOpenManager).toHaveBeenCalledOnce();
	});

	it('keeps complete content in a fixed two-line CSS clamp', () => {
		const queue = makeQueue(1);
		const content = `${'x'.repeat(260)}\nsecond line`;
		queue.entries[0] = { ...queue.entries[0], content };
		const { container } = renderControls(queue);
		const preview = container.querySelector('[data-queue-preview]');

		expect(preview?.textContent?.trim()).toBe(content);
		expect(preview?.classList.contains('line-clamp-2')).toBe(true);
		expect(preview?.classList.contains('h-10')).toBe(true);
		expect(preview?.classList.contains('whitespace-pre-wrap')).toBe(true);
		expect(preview?.classList.contains('break-words')).toBe(true);
	});

	it('shows a neutral interrupt action only while viewing the FIFO head', async () => {
		const onInterrupt = vi.fn();
		renderControls(makeQueueWithIds(['q0', 'q1']), { canInterrupt: true, onInterrupt });

		const interrupt = screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() });
		const editQueue = screen.getByRole('button', { name: m.chat_queue_edit_queue() });
		const pauseQueue = screen.getByRole('button', { name: m.chat_queue_pause() });
		expect(interrupt.classList.contains('bg-queue-action-bg')).toBe(false);
		expect(interrupt.classList.contains('hover:bg-queue-action-hover-bg')).toBe(false);
		expect([...(interrupt.parentElement?.querySelectorAll('button') ?? [])]).toEqual([
			interrupt,
			editQueue,
			pauseQueue,
		]);

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_next_message() }));
		expect(screen.queryByRole('button', { name: m.chat_queue_interrupt_and_send() })).toBeNull();
		expect([...(editQueue.parentElement?.querySelectorAll('button') ?? [])]).toEqual([
			editQueue,
			pauseQueue,
		]);

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_previous_message() }));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() }));
		expect(onInterrupt).toHaveBeenCalledOnce();
	});

	it('keeps pending deletion state scoped to each browsed entry ID', async () => {
		const firstDelete = deferred<void>();
		const secondDelete = deferred<void>();
		const onDelete = vi.fn((entryId: string) =>
			entryId === 'q0' ? firstDelete.promise : secondDelete.promise,
		);
		renderControls(makeQueueWithIds(['q0', 'q1']), { onDelete });

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_remove_from_queue() }));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_next_message() }));
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_remove_from_queue() }));

		expect(onDelete).toHaveBeenNthCalledWith(1, 'q0');
		expect(onDelete).toHaveBeenNthCalledWith(2, 'q1');
		expect(
			(
				screen.getByRole('button', {
					name: m.chat_queue_remove_from_queue(),
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);

		secondDelete.resolve();
		await waitFor(() =>
			expect(
				(
					screen.getByRole('button', {
						name: m.chat_queue_remove_from_queue(),
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
		);

		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_previous_message() }));
		expect(
			(
				screen.getByRole('button', {
					name: m.chat_queue_remove_from_queue(),
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		firstDelete.resolve();
		await waitFor(() =>
			expect(
				(
					screen.getByRole('button', {
						name: m.chat_queue_remove_from_queue(),
					}) as HTMLButtonElement
				).disabled,
			).toBe(false),
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
