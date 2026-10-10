import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { tick } from 'svelte';
import QueueControls from '../QueueControls.svelte';
import { QueuedInputListController } from '../QueuedInputListController.svelte.js';
import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
import * as m from '$lib/paraglide/messages.js';

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function makeQueue(ids = ['q0', 'q1', 'q2']): ChatQueueState {
	return {
		entries: ids.map((id) => ({
			id,
			content: `queued ${id}`,
			kind: 'turn',
			attachments: [],
			revision: 1,
			createdAt: '2026-10-10T00:00:00.000Z',
			updatedAt: '2026-10-10T00:00:00.000Z',
		})),
		steeringEntryId: null,
		recentlyDispatched: [],
		pause: null,
		reorderRevision: 7,
	};
}

function renderControls(
	queue = makeQueue(),
	props: Partial<ComponentProps<typeof QueueControls>> = {},
) {
	return render(QueueControls, {
		chatId: 'chat-1',
		queue,
		onPause: vi.fn().mockResolvedValue(undefined),
		onResume: vi.fn().mockResolvedValue(undefined),
		onQueueControlError: vi.fn(),
		onEdit: vi.fn(),
		onDelete: vi.fn().mockResolvedValue(undefined),
		onMove: vi.fn().mockResolvedValue(undefined),
		...props,
	});
}

function row(id: string) {
	const element = document.querySelector<HTMLElement>(`[data-queue-entry-id="${id}"]`);
	if (!element) throw new Error(`Missing row ${id}`);
	return within(element);
}

async function openMenu(id: string) {
	await fireEvent.click(row(id).getByRole('button', { name: m.chat_queue_actions() }));
	return screen.findByRole('menu');
}

describe('inline queue', () => {
	it('keeps moved rows mounted before virtual geometry catches up to the queue order', () => {
		const controller = new QueuedInputListController();
		const { entries } = makeQueue();
		try {
			controller.update('chat-1', entries);
			const snapshot = controller.virtual.snapshot;
			const reordered = [entries[1], entries[0], entries[2]];
			const currentEntries = new Map(reordered.map((entry) => [entry.id, entry]));
			expect(controller.items(snapshot, currentEntries).map(({ entry }) => entry.id)).toEqual([
				'q0',
				'q1',
				'q2',
			]);
		} finally {
			controller.virtual.destroy();
		}
	});

	it('reorders through the focused grip without adding menu ordering actions', async () => {
		const pending = deferred();
		const onMove = vi.fn(() => pending.promise);
		const queue = makeQueue();
		const view = renderControls(queue, { onMove });
		const grip = row('q0').getByRole('button', { name: m.chat_queue_drag_handle({ position: 1 }) });
		grip.focus();
		await fireEvent.click(grip);
		expect(grip.getAttribute('aria-pressed')).toBe('true');
		await fireEvent.keyDown(grip, { key: 'ArrowUp' });
		expect(onMove).not.toHaveBeenCalled();
		await fireEvent.keyDown(grip, { key: 'ArrowDown' });
		await fireEvent.keyDown(grip, { key: 'ArrowDown' });
		expect(onMove).toHaveBeenCalledExactlyOnceWith(queue.entries[0], queue.entries[1], 'after', 7);
		expect(grip.getAttribute('aria-disabled')).toBe('true');
		await view.rerender({
			queue: {
				...queue,
				entries: [queue.entries[1], queue.entries[0], queue.entries[2]],
				reorderRevision: 8,
			},
		});
		pending.resolve();
		await waitFor(() => expect(grip.getAttribute('aria-disabled')).toBe('false'));
		await waitFor(() => expect(document.activeElement).toBe(grip));
		expect(grip.getAttribute('aria-pressed')).toBe('true');
		await fireEvent.keyDown(grip, { key: 'Escape' });
		expect(grip.getAttribute('aria-pressed')).toBe('false');
		await fireEvent.keyDown(grip, { key: 'ArrowDown' });
		expect(onMove).toHaveBeenCalledOnce();
	});

	it('bounds mounted rows while preserving the full queue count and FIFO order', () => {
		renderControls(makeQueue(Array.from({ length: 1_000 }, (_, index) => `q${index}`)));
		const mountedRows = document.querySelectorAll('[data-queue-entry-id]');
		expect(mountedRows.length).toBeGreaterThan(0);
		expect(mountedRows.length).toBeLessThan(30);
		expect(screen.getByText(m.chat_queue_pending_count({ count: 1_000 }))).toBeTruthy();
		expect(screen.queryByRole('button', { name: m.chat_queue_edit_queue() })).toBeNull();
		expect(screen.queryByRole('button', { name: m.chat_queue_next_message() })).toBeNull();
		expect(
			[...document.querySelectorAll('[data-queue-entry-id]')].map((item) =>
				item.getAttribute('data-queue-entry-id'),
			),
		).toEqual(Array.from({ length: mountedRows.length }, (_, index) => `q${index}`));
	});

	it('hides an empty queue', () => {
		const { container } = renderControls(makeQueue([]));
		expect(container.querySelector('[data-queue-status-summary]')).toBeNull();
	});

	it.each([
		['queued-turn-failed', m.chat_queue_pause_failed_detail()],
		['completion-uncertain', m.chat_queue_pause_completion_uncertain_detail()],
		['unknown', m.chat_queue_pause_unknown_detail()],
	] as const)('explains the %s automatic pause in the chat', (kind, detail) => {
		const paused = makeQueue();
		paused.pause =
			kind === 'unknown'
				? { id: 'pause-1', kind, entryId: 'departed', pausedAt: null }
				: { id: 'pause-1', kind, entryId: 'departed', pausedAt: '2026-10-10T00:00:00.000Z' };
		renderControls(paused);
		expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy();
		expect(screen.getByText(detail, { exact: false })).toBeTruthy();
		expect(screen.getByText(m.chat_queue_pause_affected_removed(), { exact: false })).toBeTruthy();
	});

	it('explains an active-turn failure without claiming a queued entry departed', () => {
		const queue = makeQueue();
		queue.pause = {
			id: 'pause-1',
			kind: 'turn-failed',
			turnId: 'turn-1',
			pausedAt: '2026-10-10T00:00:00.000Z',
		};
		renderControls(queue);
		expect(screen.getByText(m.chat_queue_needs_attention())).toBeTruthy();
		expect(screen.getByText(m.chat_queue_pause_turn_failed_detail())).toBeTruthy();
		expect(screen.queryByText(m.chat_queue_pause_affected_removed(), { exact: false })).toBeNull();
	});

	it('starts each chat at its queue head without resetting same-chat snapshots', async () => {
		const view = renderControls(makeQueue(Array.from({ length: 20 }, (_, index) => `q${index}`)));
		await tick();
		const list = view.container.querySelector<HTMLElement>('[data-queue-list]');
		if (!list) throw new Error('Missing queue list');
		const sizer = list.querySelector('ol');
		if (!sizer) throw new Error('Missing queue sizer');
		Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
		Object.defineProperty(list, 'scrollHeight', {
			get: () => Number.parseFloat(sizer.style.height),
			configurable: true,
		});
		vi.spyOn(sizer, 'getBoundingClientRect').mockImplementation(
			() => new DOMRect(0, -list.scrollTop, 100, Number.parseFloat(sizer.style.height)),
		);
		list.scrollTop = 400;
		await view.rerender({
			queue: makeQueue(Array.from({ length: 21 }, (_, index) => `q${index}`)),
		});
		expect(list.scrollTop).toBe(400);
		await view.rerender({
			chatId: 'chat-2',
			queue: makeQueue(Array.from({ length: 20 }, (_, index) => `b${index}`)),
		});
		expect(list.scrollTop).toBe(0);
	});

	it('expands full content without changing order or mutating entries', async () => {
		const queue = makeQueue();
		queue.entries[0].content = 'First line\nSecond line with full details';
		const view = renderControls(queue);
		const preview = row('q0').getByText(/First line/);
		expect(preview.classList.contains('truncate')).toBe(true);
		await fireEvent.click(
			row('q0').getByRole('button', { name: m.chat_queue_toggle_message({ position: 1 }) }),
		);
		expect(preview.classList.contains('whitespace-pre-wrap')).toBe(true);
		expect(
			row('q0').getByRole('button', { name: m.chat_queue_collapse_message({ position: 1 }) }),
		).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_expand_all() }));
		expect(
			row('q1')
				.getByRole('button', { name: m.chat_queue_collapse_message({ position: 2 }) })
				.getAttribute('aria-expanded'),
		).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_collapse_all() }));
		expect(
			row('q0')
				.getByRole('button', { name: m.chat_queue_toggle_message({ position: 1 }) })
				.getAttribute('aria-expanded'),
		).toBe('false');
		await view.rerender({ chatId: 'chat-2', queue: makeQueue(['b0']) });
		expect(
			screen.getByRole('button', { name: m.chat_queue_expand_all() }).getAttribute('aria-expanded'),
		).toBe('false');
	});

	it('edits directly and removes the selected stable entry from its menu', async () => {
		const onEdit = vi.fn();
		const onDelete = vi.fn().mockResolvedValue(undefined);
		const queue = makeQueue();
		renderControls(queue, { onEdit, onDelete });
		await fireEvent.click(row('q1').getByRole('button', { name: m.chat_queue_edit_message() }));
		await openMenu('q2');
		await fireEvent.click(screen.getByRole('menuitem', { name: m.chat_queue_remove_from_queue() }));
		expect(onEdit).toHaveBeenCalledWith(queue.entries[1]);
		expect(onDelete).toHaveBeenCalledWith('q2');
	});

	it('offers Steer on every queued message and keeps Send now in the head overflow', async () => {
		const onInterrupt = vi.fn();
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const queue = makeQueue();
		renderControls(queue, { canInterrupt: true, canSteer: true, onInterrupt, onSteer });
		expect(screen.queryByRole('button', { name: m.chat_queue_interrupt_and_send() })).toBeNull();
		expect(row('q0').getByRole('button', { name: m.chat_queue_steer() })).toBeTruthy();
		expect(screen.getAllByRole('button', { name: m.chat_queue_steer() })).toHaveLength(3);
		await fireEvent.click(row('q1').getByRole('button', { name: m.chat_queue_steer() }));
		expect(onSteer).toHaveBeenCalledWith(queue.entries[1], 7);
		await waitFor(() =>
			expect(
				row('q0').getByRole('button', { name: m.chat_queue_actions() }).hasAttribute('disabled'),
			).toBe(false),
		);
		await openMenu('q0');
		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.chat_queue_interrupt_and_send() }),
		);
		expect(onInterrupt).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		await openMenu('q1');
		expect(screen.queryByRole('menuitem', { name: m.chat_queue_interrupt_and_send() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.chat_queue_edit_message() })).toBeNull();
	});

	it('omits all ordering actions from the inline queue menu', async () => {
		renderControls();
		await openMenu('q1');
		expect(
			screen.queryByRole('menuitem', { name: m.chat_queue_move_down({ position: 2 }) }),
		).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Move to top' })).toBeNull();
		expect(
			screen.queryByRole('menuitem', { name: m.chat_queue_move_up({ position: 2 }) }),
		).toBeNull();
	});

	it('disables steering with attachments and preserves attachment-only previews', () => {
		const queue = makeQueue(['q0']);
		queue.entries[0].content = '';
		queue.entries[0].attachments = [{ name: 'synthetic.png', mimeType: 'image/png' }];
		renderControls(queue, { canSteer: true, onSteer: vi.fn() });
		const steer = row('q0').getByRole('button', { name: m.chat_queue_steer() });
		expect(steer.hasAttribute('disabled')).toBe(true);
		expect(steer.getAttribute('title')).toBe(m.chat_queue_steer_attachments_unavailable());
		expect(screen.getByText('synthetic.png')).toBeTruthy();
	});

	it('keeps pending steers visible without offering another steering request', () => {
		const queue = makeQueue(['q0']);
		queue.entries[0].kind = 'steer';
		renderControls(queue, { canSteer: true, onSteer: vi.fn() });
		expect(screen.queryByRole('button', { name: m.chat_queue_steer() })).toBeNull();
		expect(screen.getByText(m.chat_queue_pending_steer())).toBeTruthy();
	});

	it('blocks all mutations during authoritative steering', async () => {
		const queue = makeQueue();
		queue.steeringEntryId = 'q0';
		renderControls(queue, { canSteer: true, onSteer: vi.fn() });
		expect(
			row('q0').getByRole('button', { name: m.chat_queue_steer() }).getAttribute('aria-busy'),
		).toBe('true');
		for (const button of screen.getAllByRole('button')) {
			if (button.getAttribute('aria-expanded') !== null) continue;
			if (button.hasAttribute('data-queue-drag-id')) {
				expect(button.getAttribute('aria-disabled')).toBe('true');
				await fireEvent.click(button);
				expect(button.getAttribute('aria-pressed')).toBe('false');
				continue;
			}
			expect(button.hasAttribute('disabled')).toBe(true);
		}
	});

	it('keeps pending operations scoped to their chat and prevents duplicate delivery', async () => {
		const pending = deferred();
		const onSteer = vi.fn((entry: QueueEntry) =>
			entry.id === 'q0' ? pending.promise : Promise.resolve(),
		);
		const view = renderControls(makeQueue(['q0']), { canSteer: true, onSteer });
		const steer = row('q0').getByRole('button', { name: m.chat_queue_steer() });
		steer.focus();
		await fireEvent.click(steer);
		await fireEvent.click(steer);
		expect(onSteer).toHaveBeenCalledOnce();
		await view.rerender({ chatId: 'chat-2', queue: makeQueue(['b0']) });
		await fireEvent.click(row('b0').getByRole('button', { name: m.chat_queue_steer() }));
		expect(onSteer).toHaveBeenCalledTimes(2);
		await view.rerender({ chatId: 'chat-1', queue: makeQueue(['q0', 'q1']) });
		expect(
			row('q0').getByRole('button', { name: m.chat_queue_steer() }).getAttribute('aria-busy'),
		).toBe('true');
		await view.rerender({ queue: makeQueue(['q1']) });
		const nextSteer = row('q1').getByRole('button', { name: m.chat_queue_steer() });
		expect(nextSteer.hasAttribute('disabled')).toBe(true);
		expect(document.activeElement).not.toBe(nextSteer);
		pending.resolve();
		await waitFor(() => expect(nextSteer.hasAttribute('disabled')).toBe(false));
	});

	it('guards deletion until it settles', async () => {
		const pending = deferred();
		const onDelete = vi.fn(() => pending.promise);
		renderControls(makeQueue(), { onDelete });
		await openMenu('q1');
		const remove = screen.getByRole('menuitem', { name: m.chat_queue_remove_from_queue() });
		await fireEvent.click(remove);
		await fireEvent.click(remove);
		expect(onDelete).toHaveBeenCalledOnce();
		expect(
			row('q1').getByRole('button', { name: m.chat_queue_actions() }).hasAttribute('disabled'),
		).toBe(true);
		pending.resolve();
		await waitFor(() =>
			expect(
				row('q1').getByRole('button', { name: m.chat_queue_actions() }).hasAttribute('disabled'),
			).toBe(false),
		);
	});

	it('reports a late pause failure to the originating chat', async () => {
		const pending = deferred();
		const onQueueControlError = vi.fn();
		const view = renderControls(makeQueue(), {
			onPause: () => pending.promise,
			onQueueControlError,
		});
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_pause() }));
		await view.rerender({ chatId: 'chat-2', queue: makeQueue(['b0']) });
		pending.reject(new Error('pause failed'));
		await waitFor(() =>
			expect(onQueueControlError).toHaveBeenCalledWith(
				'chat-1',
				'pause',
				expect.objectContaining({ message: 'pause failed' }),
			),
		);
	});

	it('resumes the captured pause and hides Send now while paused', async () => {
		const queue = makeQueue();
		queue.pause = { id: 'pause-1', kind: 'manual', pausedAt: '2026-10-10T00:00:00.000Z' };
		const onResume = vi.fn().mockResolvedValue(undefined);
		renderControls(queue, { onResume, canInterrupt: true, onInterrupt: vi.fn() });
		await openMenu('q0');
		expect(screen.queryByRole('menuitem', { name: m.chat_queue_interrupt_and_send() })).toBeNull();
		await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		await fireEvent.click(screen.getByRole('button', { name: m.chat_queue_resume() }));
		expect(onResume).toHaveBeenCalledWith('pause-1');
	});
});
