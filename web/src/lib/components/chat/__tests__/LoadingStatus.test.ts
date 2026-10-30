import { cleanup, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoadingStatus from '../LoadingStatus.svelte';

describe('LoadingStatus', () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('runs one spinner timer while visible and cleans it up on hide and unmount', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const { container, rerender, unmount } = render(LoadingStatus, {
			isVisible: false,
			status: null,
			agentId: 'claude',
			onAbort: null,
			spinnerSelectionKey: 'chat-1',
		});
		expect(vi.getTimerCount()).toBe(0);

		await rerender({ isVisible: true });
		expect(vi.getTimerCount()).toBe(1);
		const spinner = container.querySelector('.text-status-processing');
		const firstFrame = spinner?.textContent;
		await vi.advanceTimersByTimeAsync(120);
		await tick();
		expect(spinner?.textContent).not.toBe(firstFrame);

		await rerender({ spinnerSelectionKey: 'chat-2' });
		expect(vi.getTimerCount()).toBe(1);
		expect(spinner?.textContent).toBe(firstFrame);

		await rerender({ isVisible: false });
		expect(vi.getTimerCount()).toBe(0);
		await rerender({ isVisible: true });
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the status bar height stable when stopping hides the stop action', async () => {
		const { rerender } = render(LoadingStatus, {
			props: {
				isVisible: true,
				status: { text: 'Processing', tokens: 0, can_interrupt: true },
				agentId: 'claude',
				onAbort: vi.fn(),
				spinnerSelectionKey: 'chat-1',
			},
		});

		expect(screen.getByRole('status').className).toContain('min-h-14');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();

		await rerender({
			isVisible: true,
			status: { text: 'Stopping', tokens: 0, can_interrupt: false },
			agentId: 'claude',
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
				agentId: 'claude',
				onAbort: vi.fn(),
				spinnerSelectionKey: 'chat-1',
				announcementsEnabled: false,
			},
		});

		const bar = container.querySelector('[data-slot="chat-processing-status"]');
		expect(bar?.getAttribute('role')).toBeNull();
		expect(bar?.getAttribute('aria-live')).toBe('off');
		expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
	});
});
