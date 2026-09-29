import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitStashEntry } from '$lib/api/git.js';
import { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';
import GitPorcelainPanel from '../GitPorcelainPanel.svelte';

const project = { executorId: 'remote', projectPath: '/project' };

function createPorcelain(): GitPorcelainState {
	return new GitPorcelainState({
		selectedFile: () => null,
		refreshAfterMutation: async () => {},
		surfaceError: vi.fn(),
		ensureFreshForGitMutation: () => true,
		isCurrentTarget: () => true,
		runGitMutation: (_project, execute) => execute(),
	});
}

function makeStash(index: number, hash: string, message: string): GitStashEntry {
	return { index, ref: `stash@{${index}}`, hash, message, date: '2026-01-01 00:00:00 +0000' };
}

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
			{ ref: 'stash@{0}', hash: 'replacement' },
		);
	});
});

describe('GitPorcelainPanel stash list', () => {
	afterEach(cleanup);

	it('acts on each listed stash when several share a date or a commit', async () => {
		const porcelain = createPorcelain();
		porcelain.inspectorView = 'stash';
		porcelain.stashes = [
			makeStash(0, 'a'.repeat(40), 'Stored again'),
			makeStash(1, 'b'.repeat(40), 'Same second'),
			makeStash(2, 'a'.repeat(40), 'Original'),
		];
		vi.spyOn(porcelain, 'loadCurrentView').mockResolvedValue(undefined);
		const apply = vi.spyOn(porcelain, 'applyStash').mockResolvedValue(undefined);
		const pop = vi.spyOn(porcelain, 'popStash').mockResolvedValue(undefined);
		const drop = vi.spyOn(porcelain, 'dropStash').mockResolvedValue(undefined);
		render(GitPorcelainPanel, { project, selectedFile: null, porcelain });

		expect(screen.getAllByRole('button', { name: 'Apply' })).toHaveLength(3);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[1]!);
		expect(apply).toHaveBeenCalledWith(project, expect.objectContaining({ ref: 'stash@{1}', hash: 'b'.repeat(40) }));
		await fireEvent.click(screen.getAllByRole('button', { name: 'Pop' })[2]!);
		expect(pop).toHaveBeenCalledWith(project, expect.objectContaining({ ref: 'stash@{2}', hash: 'a'.repeat(40) }));

		await fireEvent.click(screen.getAllByRole('button', { name: 'Drop' })[2]!);
		expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1);
		expect(screen.getByText(/Drop stash@\{2\}\?/)).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(drop).toHaveBeenCalledWith(project, { ref: 'stash@{2}', hash: 'a'.repeat(40) });
	});
});
