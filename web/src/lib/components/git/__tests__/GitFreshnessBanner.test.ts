import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitFreshnessBanner from '../GitFreshnessBanner.svelte';

describe('GitFreshnessBanner', () => {
	it('shows the stale message and refreshes on click', async () => {
		const onRefresh = vi.fn();

		render(GitFreshnessBanner, {
			props: {
				isRefreshing: false,
				onRefresh,
			},
		});

		expect(screen.getByText('Refresh to see new changes.')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('disables refresh while a refresh is already running', () => {
		render(GitFreshnessBanner, {
			props: {
				isRefreshing: true,
				onRefresh: vi.fn(),
			},
		});

		expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});
