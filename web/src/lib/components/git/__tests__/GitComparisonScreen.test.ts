import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
import GitComparisonScreen from '../GitComparisonScreen.svelte';

function renderScreen(comparison: GitComparisonController, isLoading: boolean): void {
	render(GitComparisonScreen, {
		comparison,
		isLoading,
		isMobile: false,
		fontSize: 12,
		onEdit: vi.fn(),
		onRefresh: vi.fn(),
		onOpenChat: vi.fn(),
	});
}

describe('GitComparisonScreen', () => {
	afterEach(cleanup);

	it('shows initialization as loading instead of a comparison error', () => {
		renderScreen(new GitComparisonController(), true);

		expect(screen.getByText('Loading comparison')).toBeTruthy();
		expect(screen.queryByText('Comparison could not be loaded.')).toBeNull();
	});

	it('preserves a real comparison failure after initialization', () => {
		const comparison = new GitComparisonController();
		comparison.error = 'Revision HEAD was not found.';

		renderScreen(comparison, false);

		expect(screen.getByText('Revision HEAD was not found.')).toBeTruthy();
		expect(screen.queryByText('Loading comparison')).toBeNull();
	});

	it('offers local back navigation without exposing the standalone Edit action', async () => {
		const comparison = new GitComparisonController();
		comparison.error = 'Revision older was not found.';
		const onBack = vi.fn();

		render(GitComparisonScreen, {
			comparison,
			isLoading: false,
			isMobile: false,
			fontSize: 12,
			onBack,
			onRefresh: vi.fn(),
			onOpenChat: vi.fn(),
		});

		expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
		await fireEvent.click(
			screen.getByRole('button', { name: 'Back to commit selection' }),
		);
		expect(onBack).toHaveBeenCalledOnce();
	});
});
