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
		untrackedAdditions: 2,
		untrackedAdditionsCapped: false,
		fingerprintVersion: 1,
		fingerprint: 'v1:quick',
		...overrides,
	};
}

describe('GitQuickStatusTray', () => {
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
		expect(screen.getByText('2 files')).toBeTruthy();
		expect(screen.getByText('1 untracked')).toBeTruthy();
		expect(screen.getByText('+5')).toBeTruthy();
		expect(screen.getByText('-1')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
		expect(onCommit).toHaveBeenCalledOnce();
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
					untrackedAdditions: 0,
				}),
				isRefreshing: false,
				onCommit: vi.fn(),
			},
		});

		expect(screen.getByText('clean')).toBeTruthy();
		expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});
});
