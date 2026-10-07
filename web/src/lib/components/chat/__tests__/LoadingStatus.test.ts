import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoadingStatus from '../LoadingStatus.svelte';

describe('LoadingStatus', () => {
	it('shows Codex stopping and keeps elapsed updates out of live announcements', () => {
		const { container } = render(LoadingStatus, {
			isVisible: true,
			status: { text: 'Stopping', tokens: 0, can_interrupt: false },
			onAbort: vi.fn(),
			timing: {
				timing: { startedAt: 1000, lastOutputAt: null, observedAt: 5000 },
				receivedAt: Date.now(),
			},
		});
		expect(screen.getByText('Stopping...')).toBeTruthy();
		const timing = container.querySelector('[data-processing-timing]');
		expect(timing?.textContent).toContain('Elapsed 4s');
		expect(timing?.getAttribute('aria-live')).toBe('off');
	});
	afterEach(() => {
		cleanup();
	});

	it('keeps the tray height stable when stopping hides the stop action', async () => {
		const { rerender } = render(LoadingStatus, {
			props: {
				isVisible: true,
				status: { text: 'Processing', tokens: 0, can_interrupt: true },
				onAbort: vi.fn(),
				spinnerSelectionKey: 'chat-1',
			},
		});

		expect(screen.getByRole('status').className).toContain('min-h-14');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

		await rerender({
			isVisible: true,
			status: { text: 'Stopping', tokens: 0, can_interrupt: false },
			onAbort: vi.fn(),
			spinnerSelectionKey: 'chat-1',
		});

		expect(screen.getByRole('status').className).toContain('min-h-14');
		expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
		expect(screen.getByText('Stopping...')).toBeTruthy();
	});

	it('keeps controls visible while disabling non-anchor announcements', () => {
		const { container } = render(LoadingStatus, {
			props: {
				isVisible: true,
				status: { text: 'Processing', tokens: 0, can_interrupt: true },
				onAbort: vi.fn(),
				spinnerSelectionKey: 'chat-1',
				announcementsEnabled: false,
			},
		});

		const tray = container.querySelector('[data-slot="chat-processing-status"]');
		expect(tray?.getAttribute('role')).toBeNull();
		expect(tray?.getAttribute('aria-live')).toBe('off');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});
});
