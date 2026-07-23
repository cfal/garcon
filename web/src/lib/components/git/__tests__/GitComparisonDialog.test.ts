import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitComparisonController } from '$lib/git/review/git-comparison.svelte.js';
import GitComparisonDialog from '../GitComparisonDialog.svelte';

function renderDialog(comparison = new GitComparisonController()) {
	const onCompare = vi.fn();
	const onSearchRefs = vi.fn();
	return {
		comparison,
		onCompare,
		onSearchRefs,
		...render(GitComparisonDialog, {
			comparison,
			refs: [
				{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch' },
				{ name: 'v1', ref: 'refs/tags/v1', kind: 'tag' },
			],
			isLoadingRefs: false,
			onSearchRefs,
			onCompare,
			onClose: vi.fn(),
		}),
	};
}

describe('GitComparisonDialog', () => {
	afterEach(cleanup);

	it('explains the complete Working Tree target and hides merge-base controls', () => {
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'HEAD', toKind: 'working-tree' });
		renderDialog(comparison);

		expect(screen.getByText(/staged, unstaged, untracked/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Since common ancestor' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Swap revisions' })).toBeNull();
	});

	it('supports explicit comparison modes and revision swapping', async () => {
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: 'main',
			toKind: 'revision',
			toRevision: 'feature',
		});
		renderDialog(comparison);

		await fireEvent.click(screen.getByRole('button', { name: 'Since common ancestor' }));
		expect(comparison.mode).toBe('merge-base');
		await fireEvent.click(screen.getByRole('button', { name: 'Swap revisions' }));
		expect(comparison.fromRevision).toBe('feature');
		expect(comparison.toRevision).toBe('main');
	});

	it('offers direct comparison when revisions have no common ancestor', async () => {
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: 'main',
			toKind: 'revision',
			toRevision: 'unrelated',
			mode: 'merge-base',
		});
		comparison.error = 'These revisions do not have a common ancestor.';
		comparison.errorStatus = 'no-merge-base';
		const { onCompare } = renderDialog(comparison);

		await fireEvent.click(screen.getByRole('button', { name: 'Use Direct' }));

		expect(comparison.mode).toBe('direct');
		expect(onCompare).toHaveBeenCalledOnce();
	});

	it('provides an ordered keyboard combobox while preserving free-form revisions', async () => {
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: '',
			toKind: 'revision',
			toRevision: 'v1',
		});
		const { onSearchRefs } = renderDialog(comparison);
		const from = screen.getByRole('combobox', { name: 'From' });

		await fireEvent.focus(from);
		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
			'main branch',
			'v1 tag',
		]);
		await fireEvent.keyDown(from, { key: 'ArrowDown' });
		await fireEvent.keyDown(from, { key: 'Enter' });
		expect(comparison.fromRevision).toBe('main');

		vi.useFakeTimers();
		try {
			await fireEvent.input(from, { target: { value: 'deadbeef' } });
			expect(comparison.fromRevision).toBe('deadbeef');
			expect(onSearchRefs).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(199);
			expect(onSearchRefs).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onSearchRefs).toHaveBeenLastCalledWith('deadbeef');
		} finally {
			vi.useRealTimers();
		}
	});
});
