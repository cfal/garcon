import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitFileTree from '../GitFileTree.svelte';
import type { GitTreeNode } from '$lib/api/git';

describe('GitFileTree', () => {
	it('renders stage and unstage actions for a file with mixed index and working-tree changes', async () => {
		const onStageFile = vi.fn();
		const onUnstageFile = vi.fn();
		const node: GitTreeNode = {
			path: 'src/a.ts',
			name: 'a.ts',
			kind: 'file',
			indexStatus: 'M',
			workTreeStatus: 'M',
			staged: true,
			hasUnstaged: true,
			changeKind: 'modified',
		};

		render(GitFileTree, {
			tree: [node],
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: 1,
			alwaysShowActions: true,
			onSelectFile: vi.fn(),
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
			onStageFile,
			onUnstageFile,
		});

		await fireEvent.click(screen.getByTitle('Stage file'));
		await fireEvent.click(screen.getByTitle('Unstage file'));

		expect(onStageFile).toHaveBeenCalledWith('src/a.ts');
		expect(onUnstageFile).toHaveBeenCalledWith('src/a.ts');
	});

	it('renders hide-generated as an unchecked opt-in filter by default', async () => {
		const onHideGeneratedChange = vi.fn();
		const node: GitTreeNode = {
			path: 'src/generated/api.ts',
			name: 'api.ts',
			kind: 'file',
			staged: false,
			hasUnstaged: true,
			category: 'generated',
		};

		render(GitFileTree, {
			tree: [node],
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: 1,
			onSelectFile: vi.fn(),
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
			onHideGeneratedChange,
		});

		const checkbox = screen.getByLabelText('Hide generated') as HTMLInputElement;
		expect(checkbox.checked).toBe(false);

		await fireEvent.click(checkbox);

		expect(onHideGeneratedChange).toHaveBeenCalledWith(true);
	});
});
