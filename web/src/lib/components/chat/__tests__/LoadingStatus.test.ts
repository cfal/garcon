import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoadingStatus from '../LoadingStatus.svelte';

describe('LoadingStatus', () => {
	afterEach(() => {
		cleanup();
	});

	it('keeps the tray height stable when stopping hides the stop action', async () => {
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
});
