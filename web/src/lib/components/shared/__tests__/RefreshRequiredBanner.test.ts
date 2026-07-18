import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import RefreshRequiredBanner from '../RefreshRequiredBanner.svelte';

describe('RefreshRequiredBanner', () => {
	it('shows an actionable message and refresh failure detail', async () => {
		const onRefresh = vi.fn();
		render(RefreshRequiredBanner, {
			message: 'Content changed.',
			refreshLabel: 'Refresh',
			isRefreshing: false,
			refreshError: 'Refresh failed: offline',
			onRefresh,
		});

		expect(screen.getByText('Content changed.')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain('offline');
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('disables the banner action while refresh is pending', () => {
		render(RefreshRequiredBanner, {
			message: 'Content changed.',
			refreshLabel: 'Refresh',
			isRefreshing: true,
			onRefresh: vi.fn(),
		});

		expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});
