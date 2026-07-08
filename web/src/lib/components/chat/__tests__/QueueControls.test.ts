import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import * as m from '$lib/paraglide/messages.js';

describe('QueueControls', () => {
	it('hides controls when queue is paused with no pending entries', () => {
		const { container } = render(QueueControls, {
			queue: { entries: [], paused: true },
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: m.chat_queue_send_now() })).toBeNull();
		expect(container.textContent?.trim() || '').toBe('');
	});

	it('shows send queued when paused and queue has entries', () => {
		render(QueueControls, {
			queue: {
				paused: true,
				entries: [
					{
						id: 'q1',
						content: 'queued message',
						status: 'queued',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
				],
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.getByRole('button', { name: m.chat_queue_send_now() })).toBeTruthy();
	});

	it('shows interrupt and send when current turn can be interrupted', async () => {
		const onInterrupt = vi.fn();
		render(QueueControls, {
			queue: {
				paused: false,
				entries: [
					{
						id: 'q1',
						content: 'queued message',
						status: 'queued',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
				],
			},
			canInterrupt: true,
			onInterrupt,
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		const button = screen.getByRole('button', { name: m.chat_queue_interrupt_and_send() });
		expect(button).toBeTruthy();
		await fireEvent.click(button);
		expect(onInterrupt).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('button', { name: m.chat_queue_pause() })).toBeNull();
	});

	it('preserves newline formatting inside a queued entry', () => {
		const multiline = 'first line\nsecond line';
		const { container } = render(QueueControls, {
			queue: {
				paused: false,
				entries: [
					{
						id: 'q1',
						content: multiline,
						status: 'queued',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
				],
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		const content = container.querySelector('.whitespace-pre-wrap');
		expect(content).toBeTruthy();
		expect(content?.textContent).toBe(multiline);
	});

	it('caps visible queued entries and shows the hidden count', () => {
		render(QueueControls, {
			queue: {
				paused: false,
				entries: Array.from({ length: 5 }, (_, index) => ({
					id: `q${index}`,
					content: `queued ${index}`,
					status: 'queued' as const,
					createdAt: '2026-02-27T00:00:00.000Z',
				})),
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.getByText('queued 0')).toBeTruthy();
		expect(screen.getByText('queued 2')).toBeTruthy();
		expect(screen.queryByText('queued 3')).toBeNull();
		expect(screen.getByText(m.chat_queue_more_pending({ count: 2 }))).toBeTruthy();
	});

	it('truncates long queued previews', () => {
		const longText = 'x'.repeat(220);
		const { container } = render(QueueControls, {
			queue: {
				paused: false,
				entries: [
					{
						id: 'q1',
						content: longText,
						status: 'queued',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
				],
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		const content = container.querySelector('.whitespace-pre-wrap');
		expect(content?.textContent).toBe(`${'x'.repeat(180)}...`);
	});

	it('hides sending entries since they already appear in the transcript', () => {
		const { container } = render(QueueControls, {
			queue: {
				paused: false,
				entries: [
					{
						id: 'q1',
						content: 'dispatching now',
						status: 'sending',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
				],
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		// The panel collapses entirely when only sending entries remain, so the
		// stale "0 queued" row never appears.
		expect(container.textContent?.trim() || '').toBe('');
		expect(screen.queryByText('dispatching now')).toBeNull();
	});

	it('counts and renders only queued entries when sending and queued mix', () => {
		render(QueueControls, {
			queue: {
				paused: false,
				entries: [
					{
						id: 's1',
						content: 'currently sending',
						status: 'sending',
						createdAt: '2026-02-27T00:00:00.000Z',
					},
					{
						id: 'q1',
						content: 'still waiting',
						status: 'queued',
						createdAt: '2026-02-27T00:00:01.000Z',
					},
				],
			},
			onResume: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.getByText(m.chat_queue_pending_count({ count: 1 }))).toBeTruthy();
		expect(screen.getByText('still waiting')).toBeTruthy();
		expect(screen.queryByText('currently sending')).toBeNull();
	});
});
