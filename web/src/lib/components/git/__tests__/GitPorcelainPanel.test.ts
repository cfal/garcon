import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';
import GitPorcelainPanel from '../GitPorcelainPanel.svelte';

describe('GitPorcelainPanel confirmations', () => {
	afterEach(cleanup);

	it('retires a stash confirmation when its load is cancelled without remounting', async () => {
		const porcelain = new GitPorcelainState({
			selectedFile: () => null,
			refreshAfterMutation: async () => {},
			surfaceError: vi.fn(),
			ensureFreshForGitMutation: () => true,
			isCurrentTarget: () => true,
			runGitMutation: (_project, execute) => execute(),
		});
		porcelain.inspectorView = 'stash';
		porcelain.stashes = [
			{
				index: 0,
				ref: 'stash@{0}',
				hash: 'original',
				message: 'Original stash',
				date: '2026-01-01',
			},
		];
		vi.spyOn(porcelain, 'loadCurrentView').mockResolvedValue(undefined);
		const drop = vi.spyOn(porcelain, 'dropStash').mockResolvedValue(undefined);
		render(GitPorcelainPanel, {
			project: { executorId: 'remote', projectPath: '/project' },
			selectedFile: null,
			porcelain,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
		const oldConfirm = screen.getByRole('button', { name: 'Confirm' });

		porcelain.cancelActiveLoad();
		porcelain.stashes = [
			{
				index: 0,
				ref: 'stash@{0}',
				hash: 'replacement',
				message: 'Replacement stash',
				date: '2026-01-02',
			},
		];
		await fireEvent.click(oldConfirm);
		await tick();
		expect(drop).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(drop).toHaveBeenCalledWith(
			{ executorId: 'remote', projectPath: '/project' },
			'stash@{0}',
		);
	});
});
