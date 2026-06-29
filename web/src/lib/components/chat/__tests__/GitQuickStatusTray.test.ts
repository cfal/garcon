import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitQuickStatusTray from '../GitQuickStatusTray.svelte';
import type { GitQuickSummaryReady } from '$lib/api/git.js';

function summary(overrides: Partial<GitQuickSummaryReady> = {}): GitQuickSummaryReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		branch: 'main',
		hasCommits: true,
		changedFiles: 2,
		trackedChangedFiles: 1,
		untrackedFiles: 1,
		stagedFiles: 1,
		unstagedFiles: 1,
		additions: 3,
		deletions: 1,
		fingerprintVersion: 1,
		fingerprint: 'v1:quick',
		...overrides,
	};
}

describe('GitQuickStatusTray', () => {
	it('renders a centered loading indicator before the first summary', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: null,
				isRefreshing: true,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByRole('status', { name: 'Loading...' })).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByTestId('quick-git-file-summary')).toBeNull();
	});

	it('renders dirty repo counts and runs commit action', async () => {
		const onCommit = vi.fn();
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary(),
				isRefreshing: false,
				onCommit,
			},
		});

		expect(screen.getByText('main')).toBeTruthy();
		expect(screen.getByText('+3')).toBeTruthy();
		expect(screen.getByText('/')).toBeTruthy();
		expect(screen.getByText('-1')).toBeTruthy();
		expect(screen.getByText('•')).toBeTruthy();
		expect(screen.getByText('1 unstaged, 1 staged, 1 untracked')).toBeTruthy();
		expect(screen.getByTestId('quick-git-file-summary').className).toContain(
			'min-[480px]:inline-flex',
		);

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(onCommit).toHaveBeenCalledOnce();
	});

	it('skips zero-value summary items', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					changedFiles: 45,
					trackedChangedFiles: 40,
					untrackedFiles: 5,
					stagedFiles: 0,
					unstagedFiles: 40,
					additions: 0,
					deletions: 0,
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('40 unstaged, 5 untracked')).toBeTruthy();
		expect(screen.queryByText('+0')).toBeNull();
		expect(screen.queryByText('-0')).toBeNull();
		expect(screen.queryByText('0 staged')).toBeNull();
		expect(screen.queryByText('•')).toBeNull();
	});

	it('renders clean repo branch and disables commit', () => {
		render(GitQuickStatusTray, {
			props: {
				isVisible: true,
				summary: summary({
					changedFiles: 0,
					trackedChangedFiles: 0,
					untrackedFiles: 0,
					stagedFiles: 0,
					unstagedFiles: 0,
					additions: 0,
					deletions: 0,
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('no changes')).toBeTruthy();
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});
});
