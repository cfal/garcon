import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitQuickSummaryReady } from '$lib/api/git.js';
import GitSummaryButton from '../GitSummaryButton.svelte';

const ready: GitQuickSummaryReady = {
	status: 'ready',
	project: '/project',
	branch: 'main',
	hasChanges: true,
	hasUntracked: false,
	diffStats: { additions: 42, deletions: 7 },
};

describe('GitSummaryButton', () => {
	afterEach(cleanup);

	it.each([
		[{ additions: 0, deletions: 0 }, 'Commit New files'],
		[{ additions: 42, deletions: 7 }, 'Commit +42 / -7'],
	] satisfies [GitQuickSummaryReady['diffStats'], string][])(
		'shows untracked files as text without changing the accessible name (%j)',
		async (diffStats, name) => {
			render(GitSummaryButton, {
				summary: { ...ready, hasUntracked: true, diffStats },
				isRefreshing: false,
				onCommit: vi.fn(),
			});
			const button = screen.getByRole('button', { name });
			const marker = screen.getByText('?');
			expect(marker.tagName).toBe('SPAN');
			expect(marker.getAttribute('aria-hidden')).toBe('true');
			expect(button.contains(marker)).toBe(true);
			button.focus();
			const tooltip = await screen.findByRole('tooltip');
			expect(tooltip.getAttribute('data-slot')).toBe('git-summary-tooltip');
			expect(tooltip.textContent).toContain('New files');
		},
	);

	it('omits the question mark when there are no untracked files', () => {
		render(GitSummaryButton, { summary: ready, isRefreshing: false, onCommit: vi.fn() });
		expect(screen.queryByText('?')).toBeNull();
	});

	it('keeps cached totals on refresh and exposes errors on hover or keyboard focus', async () => {
		const onCommit = vi.fn();
		const { container } = render(GitSummaryButton, {
			summary: { ...ready, hasUntracked: true },
			isRefreshing: true,
			lastError: 'git status timed out',
			onCommit,
		});
		const button = screen.getByRole('button', { name: /^Commit/ });
		expect(button.textContent).toContain('+42');
		expect(button.textContent).toContain('-7');
		expect(container.querySelector('.animate-spin')).toBeNull();
		await fireEvent.focus(button);
		const tooltip = await screen.findByRole('tooltip');
		expect(tooltip?.textContent).toContain('New files');
		expect(tooltip?.textContent).toContain('git status timed out');
		await fireEvent.keyDown(button, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		await fireEvent.click(button);
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it.each([
		['untracked', { hasUntracked: true, diffStats: { additions: 0, deletions: 0 } }, 'New files'],
		['binary', { diffStats: { additions: 0, deletions: 0 } }, 'Changes'],
		['unavailable totals', { diffStats: null }, 'Changes'],
	] satisfies [string, Partial<GitQuickSummaryReady>, string][])(
		'renders %s without pretending there are line changes',
		(_name, overrides, label) => {
			render(GitSummaryButton, {
				summary: { ...ready, ...overrides },
				isRefreshing: false,
				onCommit: vi.fn(),
			});
			const button = screen.getByRole('button', { name: /^Commit/ });
			expect(screen.getByRole('button', { name: new RegExp(`^Commit.*${label}$`) })).toBe(button);
			expect(button.getAttribute('aria-label')).toBeNull();
			expect(button.textContent).not.toContain('+0');
		},
	);

	it.each([null, 'Git operation capacity is exhausted'])(
		'opens Commit without a summary (%s)',
		async (lastError) => {
			const onCommit = vi.fn();
			render(GitSummaryButton, { summary: null, isRefreshing: !lastError, lastError, onCommit });
			const button = screen.getByRole('button', { name: /^Commit/ });
			expect((button as HTMLButtonElement).disabled).toBe(false);
			await fireEvent.click(button);
			expect(onCommit).toHaveBeenCalledOnce();
		},
	);
});
