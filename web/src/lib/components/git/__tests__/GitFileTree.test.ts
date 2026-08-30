import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitFileTree from '../GitFileTree.svelte';
import type { GitTreeNode } from '$lib/api/git';
import { GIT_WORKBENCH_TREE_ROW_HEIGHT } from '$lib/git/workbench/git-workbench-tree-rows.js';

function configureVirtualTreeViewport(container: HTMLElement, height = 120): HTMLElement {
	const viewport = container.querySelector<HTMLElement>('[data-git-workbench-file-tree]');
	const sizer = container.querySelector<HTMLElement>('[data-git-workbench-file-tree-sizer]');
	if (!viewport || !sizer) throw new Error('Expected virtual Git file tree elements');

	Object.defineProperties(viewport, {
		clientHeight: { configurable: true, value: height },
		scrollHeight: {
			configurable: true,
			get: () => Number.parseFloat(sizer.style.height) || 0,
		},
	});
	viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, height);
	sizer.getBoundingClientRect = () =>
		new DOMRect(0, -viewport.scrollTop, 300, Number.parseFloat(sizer.style.height) || 0);
	return viewport;
}

function renderedRowStart(row: HTMLElement): number {
	const match = /^translateY\(([-\d.]+)px\)$/.exec(row.style.transform);
	if (!match) throw new Error(`Expected translated virtual row, received: ${row.style.transform}`);
	return Number(match[1]);
}

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

		const props = {
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
		};
		const { rerender } = render(GitFileTree, props);

		await fireEvent.click(screen.getByTitle('Stage file'));
		await fireEvent.click(screen.getByTitle('Unstage file'));

		expect(onStageFile).toHaveBeenCalledWith('src/a.ts');
		expect(onUnstageFile).toHaveBeenCalledWith('src/a.ts');

		await rerender({
			...props,
			isStageFilePending: () => true,
			isUnstageFilePending: () => true,
		});

		expect((screen.getByTitle('Stage file') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTitle('Unstage file') as HTMLButtonElement).disabled).toBe(true);
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

	it('renders the active-tab filter label and reports toggle changes', async () => {
		const onHideOtherTabFilesChange = vi.fn();
		const node: GitTreeNode = {
			path: 'src/app.ts',
			name: 'app.ts',
			kind: 'file',
			staged: true,
			hasUnstaged: false,
		};

		render(GitFileTree, {
			tree: [node],
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: 1,
			hideOtherTabFiles: true,
			hideOtherTabFilesLabel: 'Hide unstaged',
			onSelectFile: vi.fn(),
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
			onHideOtherTabFilesChange,
		});

		const checkbox = screen.getByLabelText('Hide unstaged') as HTMLInputElement;
		expect(checkbox.checked).toBe(true);

		await fireEvent.click(checkbox);

		expect(onHideOtherTabFilesChange).toHaveBeenCalledWith(false);
	});

	it('keeps directory selection separate from disclosure and directory actions', async () => {
		const onSelectFile = vi.fn();
		const onSelectDirectory = vi.fn();
		const onToggleDir = vi.fn();
		const onStageDir = vi.fn();
		const onUnstageDir = vi.fn();
		const tree: GitTreeNode[] = [
			{
				path: 'src',
				name: 'src',
				kind: 'directory',
				staged: true,
				hasUnstaged: true,
				children: [
					{
						path: 'src/a.ts',
						name: 'a.ts',
						kind: 'file',
						staged: true,
						hasUnstaged: true,
					},
				],
			},
		];

		const props = {
			tree,
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: 1,
			alwaysShowActions: true,
			onSelectFile,
			onSelectDirectory,
			onToggleDir,
			onSearchChange: vi.fn(),
			onStageDir,
			onUnstageDir,
		};
		const { rerender } = render(GitFileTree, props);

		const directoryRow = screen.getByRole('treeitem', { name: 'src' });
		await fireEvent.click(within(directoryRow).getByRole('button', { name: 'Collapse' }));
		await fireEvent.click(within(directoryRow).getByRole('button', { name: 'src' }));
		await fireEvent.click(within(directoryRow).getByTitle('Stage directory'));
		await fireEvent.click(within(directoryRow).getByTitle('Unstage directory'));

		expect(onToggleDir).toHaveBeenCalledWith('src');
		expect(onSelectDirectory).toHaveBeenCalledWith('src');
		expect(onStageDir).toHaveBeenCalledWith('src');
		expect(onUnstageDir).toHaveBeenCalledWith('src');

		await rerender({
			...props,
			isStageDirPending: () => true,
			isUnstageDirPending: () => true,
		});

		expect((screen.getByTitle('Stage directory') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTitle('Unstage directory') as HTMLButtonElement).disabled).toBe(true);

		onToggleDir.mockClear();
		const treeRoot = screen.getByRole('tree', { name: 'Files' });
		treeRoot.focus();
		await fireEvent.keyDown(treeRoot, { key: 'ArrowRight' });
		expect(
			screen.getByRole('treeitem', { name: 'a.ts' }).hasAttribute('data-git-tree-row-active'),
		).toBe(true);
		await fireEvent.keyDown(treeRoot, { key: 'Enter' });
		await fireEvent.keyDown(treeRoot, { key: 'ArrowLeft' });
		await fireEvent.keyDown(treeRoot, { key: 'ArrowLeft' });

		expect(onSelectFile).toHaveBeenCalledWith('src/a.ts');
		expect(onToggleDir).toHaveBeenCalledWith('src');
	});

	it('moves tree focus when keyboard navigation starts from a row action', async () => {
		const onStageFile = vi.fn();
		const tree: GitTreeNode[] = ['a.ts', 'b.ts'].map((name) => ({
			path: `src/${name}`,
			name,
			kind: 'file',
			staged: false,
			hasUnstaged: true,
		}));

		render(GitFileTree, {
			tree,
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: tree.length,
			alwaysShowActions: true,
			onSelectFile: vi.fn(),
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
			onStageFile,
		});

		const firstRow = screen.getByRole('treeitem', { name: 'a.ts' });
		const firstStageAction = within(firstRow).getByTitle('Stage file');
		const treeRoot = screen.getByRole('tree', { name: 'Files' });
		firstStageAction.focus();

		await fireEvent.keyDown(firstStageAction, { key: 'ArrowDown' });

		await waitFor(() => {
			expect(document.activeElement).toBe(treeRoot);
			expect(
				screen.getByRole('treeitem', { name: 'b.ts' }).hasAttribute('data-git-tree-row-active'),
			).toBe(true);
		});
		expect(onStageFile).not.toHaveBeenCalled();
	});

	it('preserves the top-visible row when a directory above the viewport collapses', async () => {
		const filesPerDirectory = 100;
		const files = (directory: string) =>
			Array.from({ length: filesPerDirectory }, (_, index): GitTreeNode => ({
				path: `${directory}/file-${index}.ts`,
				name: `file-${index}.ts`,
				kind: 'file',
				staged: false,
				hasUnstaged: true,
			}));
		const tree: GitTreeNode[] = ['before', 'after'].map((directory) => ({
			path: directory,
			name: directory,
			kind: 'directory',
			staged: false,
			hasUnstaged: true,
			children: files(directory),
		}));
		const props = {
			tree,
			selectedFile: null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: filesPerDirectory * 2,
			onSelectFile: vi.fn(),
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
		};
		const { container, rerender } = render(GitFileTree, props);
		const viewport = configureVirtualTreeViewport(container);
		const anchorFileIndex = 20;
		const anchorPath = `after/file-${anchorFileIndex}.ts`;
		const anchorIndex = filesPerDirectory + anchorFileIndex + 2;
		const offsetWithinRow = 7;
		viewport.scrollTop = anchorIndex * GIT_WORKBENCH_TREE_ROW_HEIGHT + offsetWithinRow;
		await fireEvent.scroll(viewport);

		const initialOffset = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(
				`[data-git-file-tree-file][title="${anchorPath}"]`,
			);
			expect(row).toBeTruthy();
			return renderedRowStart(row!) - viewport.scrollTop;
		});
		expect(initialOffset).toBe(-offsetWithinRow);

		await rerender({ ...props, collapsedDirs: new Set(['before']) });

		await waitFor(() => {
			const row = container.querySelector<HTMLElement>(
				`[data-git-file-tree-file][title="${anchorPath}"]`,
			);
			expect(row).toBeTruthy();
			expect(renderedRowStart(row!) - viewport.scrollTop).toBe(initialOffset);
		});
		expect(viewport.scrollTop).toBe(
			(anchorIndex - filesPerDirectory) * GIT_WORKBENCH_TREE_ROW_HEIGHT + offsetWithinRow,
		);
	});

	it('keeps mounted rows bounded and preserves actions after virtual navigation', async () => {
		const onSelectFile = vi.fn();
		const onStageFile = vi.fn();
		const children = Array.from({ length: 5_000 }, (_, index): GitTreeNode => ({
			path: `src/file-${index}.ts`,
			name: `file-${index}.ts`,
			kind: 'file',
			staged: false,
			hasUnstaged: true,
			changeKind: 'untracked',
		}));
		const tree: GitTreeNode[] = [
			{
				path: 'src',
				name: 'src',
				kind: 'directory',
				staged: false,
				hasUnstaged: true,
				children,
			},
		];
		const props = {
			tree,
			selectedFile: null as string | null,
			collapsedDirs: new Set<string>(),
			treeSearchQuery: '',
			totalChangedFiles: children.length,
			alwaysShowActions: true,
			onSelectFile,
			onToggleDir: vi.fn(),
			onSearchChange: vi.fn(),
			onStageFile,
		};
		const { container, rerender } = render(GitFileTree, props);
		const treeRoot = configureVirtualTreeViewport(container);
		await waitFor(() =>
			expect(
				container.querySelectorAll('[data-git-workbench-file-tree-row]').length,
			).toBeGreaterThan(0),
		);

		await rerender({ ...props, selectedFile: 'src/file-4999.ts' });
		await waitFor(() =>
			expect(
				container
					.querySelector('[data-git-file-tree-file][title="src/file-4999.ts"]')
					?.getAttribute('aria-selected'),
			).toBe('true'),
		);

		const filteredTree: GitTreeNode[] = [{ ...tree[0], children: [children[0]] }];
		await rerender({
			...props,
			tree: filteredTree,
			selectedFile: 'src/file-4999.ts',
			treeSearchQuery: 'file-0',
		});
		await waitFor(() =>
			expect(
				container.querySelector('[data-git-file-tree-file][title="src/file-4999.ts"]'),
			).toBeNull(),
		);
		treeRoot.scrollTop = 0;
		await fireEvent.scroll(treeRoot);

		await rerender({ ...props, selectedFile: 'src/file-4999.ts' });
		await waitFor(() =>
			expect(
				container
					.querySelector('[data-git-file-tree-file][title="src/file-4999.ts"]')
					?.getAttribute('aria-selected'),
			).toBe('true'),
		);

		treeRoot.focus();
		await fireEvent.keyDown(treeRoot, { key: 'Home' });
		await waitFor(() =>
			expect(container.querySelector<HTMLElement>('[data-git-tree-row-active]')?.title).toBe('src'),
		);
		await fireEvent.keyDown(treeRoot, { key: 'End' });

		const activeRow = await waitFor(() => {
			const row = container.querySelector<HTMLElement>('[data-git-tree-row-active]');
			expect(row?.title).toBe('src/file-4999.ts');
			return row!;
		});
		expect(container.querySelectorAll('[data-git-workbench-file-tree-row]').length).toBeLessThan(
			40,
		);
		expect(treeRoot.getAttribute('aria-activedescendant')).toBe(activeRow.id);
		expect(document.activeElement).toBe(treeRoot);

		await fireEvent.keyDown(treeRoot, { key: 'Enter' });
		const stageAction = within(activeRow).getByTitle('Stage file');
		await fireEvent.click(stageAction);

		expect(onSelectFile).toHaveBeenCalledWith('src/file-4999.ts');
		expect(onStageFile).toHaveBeenCalledWith('src/file-4999.ts');

		stageAction.focus();
		treeRoot.scrollTop = 0;
		await fireEvent.scroll(treeRoot);

		const restoredActiveRow = await waitFor(() => {
			expect(document.activeElement).toBe(treeRoot);
			const row = container.querySelector<HTMLElement>('[data-git-tree-row-active]');
			expect(row).toBeTruthy();
			expect(treeRoot.getAttribute('aria-activedescendant')).toBe(row?.id);
			return row!;
		});
		expect(restoredActiveRow).not.toBe(activeRow);
	});
});
