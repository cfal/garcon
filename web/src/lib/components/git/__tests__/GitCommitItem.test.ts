import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitCommitItem from '../GitCommitItem.svelte';
import type { GitCommit } from '$lib/api/git';

const { copyTextToClipboard } = vi.hoisted(() => ({
	copyTextToClipboard: vi.fn(),
}));

vi.mock('$lib/utils/clipboard', () => ({
	copyTextToClipboard,
}));

describe('GitCommitItem', () => {
	const commit: GitCommit = {
		hash: 'abc123def456',
		message: 'feat: add history row actions',
		author: 'Alex',
		email: 'alex@example.com',
		date: '2026-03-02',
		stats: '',
	};

	it('copies full hash when shortened hash is clicked without toggling row expansion', async () => {
		copyTextToClipboard.mockResolvedValue(true);
		const onToggleExpanded = vi.fn();

		render(GitCommitItem, {
			commit,
			isExpanded: false,
			diff: undefined,
			isMobile: false,
			wrapText: false,
			onToggleExpanded,
		});

		await fireEvent.click(screen.getByTitle('Copy commit hash'));

		expect(copyTextToClipboard).toHaveBeenCalledWith('abc123def456');
		expect(onToggleExpanded).not.toHaveBeenCalled();
		expect(screen.getByTitle('Copied')).toBeTruthy();
	});

	it('toggles expansion when the row button is clicked', async () => {
		copyTextToClipboard.mockResolvedValue(true);
		const onToggleExpanded = vi.fn();

		render(GitCommitItem, {
			commit,
			isExpanded: false,
			diff: undefined,
			isMobile: false,
			wrapText: false,
			onToggleExpanded,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Toggle commit details' }));

		expect(onToggleExpanded).toHaveBeenCalledWith('abc123def456');
	});
});
