import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import * as m from '$lib/paraglide/messages.js';

describe('QueueControls', () => {
	it('hides controls when queue is paused with no pending entries', () => {
		const { container } = render(QueueControls, {
			queue: { entries: [], paused: true },
			onResume: vi.fn(),
			onPause: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: m.chat_queue_resume() })).toBeNull();
		expect(container.textContent?.trim() || '').toBe('');
	});

	it('shows resume when paused and queue has entries', () => {
		render(QueueControls, {
			queue: {
				paused: true,
				entries: [{
					id: 'q1',
					content: 'queued message',
					status: 'queued',
					createdAt: '2026-02-27T00:00:00.000Z',
				}],
			},
			onResume: vi.fn(),
			onPause: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.getByRole('button', { name: m.chat_queue_resume() })).toBeTruthy();
	});

	it('shows pause when not paused and queue has entries', () => {
		render(QueueControls, {
			queue: {
				paused: false,
				entries: [{
					id: 'q1',
					content: 'queued message',
					status: 'queued',
					createdAt: '2026-02-27T00:00:00.000Z',
				}],
			},
			onResume: vi.fn(),
			onPause: vi.fn(),
			onDequeue: vi.fn(),
		});

		expect(screen.getByRole('button', { name: m.chat_queue_pause() })).toBeTruthy();
	});

	it('preserves newline formatting inside a queued entry', () => {
		const multiline = 'first line\nsecond line';
		const { container } = render(QueueControls, {
			queue: {
				paused: false,
				entries: [{
					id: 'q1',
					content: multiline,
					status: 'queued',
					createdAt: '2026-02-27T00:00:00.000Z',
				}],
			},
			onResume: vi.fn(),
			onPause: vi.fn(),
			onDequeue: vi.fn(),
		});

		const content = container.querySelector('.whitespace-pre-wrap');
		expect(content).toBeTruthy();
		expect(content?.textContent).toBe(multiline);
	});
});
