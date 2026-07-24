import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitCommitFileStatus } from '$lib/api/git.js';
import GitChangedFileTree from '../GitChangedFileTree.svelte';

function changedFile(
	path: string,
	status: GitCommitFileStatus = 'modified',
	additions = 1,
	deletions = 1,
) {
	return {
		path,
		status,
		rawStatus: status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M',
		category: 'normal' as const,
		additions,
		deletions,
		estimatedRows: additions + deletions,
		bodyState: 'unloaded' as const,
		bodyFingerprint: `fp-${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function renderTree(
	files = [
		changedFile('src/lib/added.ts', 'added', 12, 0),
		changedFile('src/lib/deleted.ts', 'deleted', 0, 8),
		changedFile('README.md'),
	],
) {
	const onSelectFile = vi.fn();
	const result = render(GitChangedFileTree, {
		files,
		fileFilter: '',
		focusedFilePath: null,
		onFileFilterChange: vi.fn(),
		onSelectFile,
	});
	return { ...result, onSelectFile };
}

describe('GitChangedFileTree', () => {
	afterEach(cleanup);

	it('renders compact folders and status-prefixed non-monospace filenames without line counts', () => {
		const { container } = renderTree();

		expect(screen.getByRole('treeitem', { name: 'src/lib' })).toBeTruthy();
		const addedRow = container.querySelector<HTMLElement>(
			'[data-git-file-tree-file][title="src/lib/added.ts"]',
		);
		expect(addedRow).toBeTruthy();
		expect(addedRow?.textContent).toContain('A');
		expect(addedRow?.textContent).toContain('added.ts');
		expect(addedRow?.classList.contains('font-mono')).toBe(false);
		expect(addedRow?.querySelector('svg')).toBeNull();
		expect(screen.getByRole('treeitem', { name: 'Added, added.ts' })).toBe(addedRow);
		expect(container.textContent).not.toContain('+12');
		expect(container.textContent).not.toContain('-8');
	});

	it('collapses folders and selects files without entering directories', async () => {
		const { container, onSelectFile } = renderTree();
		const directory = screen.getByRole('treeitem', { name: 'src/lib' });

		await fireEvent.click(directory);
		await waitFor(() =>
			expect(
				container.querySelector('[data-git-file-tree-file][title="src/lib/added.ts"]'),
			).toBeNull(),
		);
		expect(onSelectFile).not.toHaveBeenCalled();

		await fireEvent.click(directory);
		const addedRow = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(
				'[data-git-file-tree-file][title="src/lib/added.ts"]',
			);
			expect(row).toBeTruthy();
			return row!;
		});
		await fireEvent.click(addedRow);
		expect(onSelectFile).toHaveBeenCalledWith('src/lib/added.ts');
	});

	it('supports tree keyboard navigation and disclosure', async () => {
		const { container } = renderTree();
		const directory = screen.getByRole('treeitem', { name: 'src/lib' });
		const treeRoot = screen.getByRole('tree', { name: 'Files' });
		treeRoot.focus();

		await fireEvent.keyDown(treeRoot, { key: 'ArrowLeft' });
		expect(directory.getAttribute('aria-expanded')).toBe('false');

		await fireEvent.keyDown(treeRoot, { key: 'ArrowRight' });
		expect(directory.getAttribute('aria-expanded')).toBe('true');

		await fireEvent.keyDown(treeRoot, { key: 'ArrowRight' });
		await waitFor(() => {
			const addedRow = container.querySelector<HTMLElement>(
				'[data-git-file-tree-file][title="src/lib/added.ts"]',
			);
			expect(addedRow?.hasAttribute('data-git-tree-row-active')).toBe(true);
			expect(treeRoot.getAttribute('aria-activedescendant')).toBe(addedRow?.id);
		});
		expect(document.activeElement).toBe(treeRoot);
	});

	it('expands stale collapsed ancestors when the file filter changes', async () => {
		const files = [
			changedFile('src/lib/added.ts', 'added'),
			changedFile('src/lib/deleted.ts', 'deleted'),
		];
		const props = {
			files,
			fileFilter: '',
			focusedFilePath: null,
			onFileFilterChange: vi.fn(),
			onSelectFile: vi.fn(),
		};
		const { container, rerender } = render(GitChangedFileTree, props);

		await fireEvent.click(screen.getByRole('treeitem', { name: 'src/lib' }));
		expect(
			container.querySelector('[data-git-file-tree-file][title="src/lib/added.ts"]'),
		).toBeNull();

		await rerender({
			...props,
			files: [files[0]!],
			fileFilter: 'added.ts',
		});

		await waitFor(() =>
			expect(
				container.querySelector('[data-git-file-tree-file][title="src/lib/added.ts"]'),
			).toBeTruthy(),
		);
	});

	it('shows a neutral empty state when the document has no changed files', () => {
		renderTree([]);

		expect(screen.getByText('No changes detected')).toBeTruthy();
		expect(screen.queryByText('No changed files match the filter.')).toBeNull();
	});

	it('keeps the mounted rows bounded and keyboard focus stable for large comparisons', async () => {
		const files = Array.from({ length: 5_000 }, (_, index) => changedFile(`src/file-${index}.ts`));

		const { container } = renderTree(files);
		const treeRoot = screen.getByRole('tree', { name: 'Files' });
		treeRoot.focus();
		await fireEvent.keyDown(treeRoot, { key: 'End' });

		expect(container.querySelectorAll('[data-git-file-list-row]').length).toBeLessThan(50);
		expect(document.activeElement).toBe(treeRoot);
	});
});
