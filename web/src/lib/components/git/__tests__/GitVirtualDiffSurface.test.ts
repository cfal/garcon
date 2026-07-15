import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { GitVirtualFileHeaderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

type GitVirtualDiffSurfaceProps = ComponentProps<typeof GitVirtualDiffSurface>;

function makeHeaderRow(
	index: number,
	overrides: Partial<GitVirtualFileHeaderRow['file']> = {},
): GitVirtualFileHeaderRow {
	const path = `file-${index}.ts`;
	return {
		kind: 'file-header',
		id: `file:${index}:header`,
		filePath: path,
		estimatedHeight: 42,
		isFocused: false,
		file: {
			path,
			indexStatus: ' ',
			workTreeStatus: 'M',
			category: 'normal',
			additions: 1,
			deletions: 0,
			estimatedRows: 2,
			bodyState: 'unloaded',
			bodyFingerprint: `fingerprint:${path}`,
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
			...overrides,
		},
	};
}

function renderSurface(
	rows: GitVirtualReviewRow[],
	overrides: Partial<GitVirtualDiffSurfaceProps> = {},
) {
	const props = {
		rows,
		fileRowIndex: new Map(rows.map((row, index) => [row.filePath, index])),
		activeTab: 'unstaged' as const,
		fontSize: 12,
		selectedLineKeys: new Set<string>(),
		operationPending: false,
		scrollToRequest: null,
		composerState: {
			open: false,
			filePath: '',
			side: 'after' as const,
			line: 0,
			body: '',
			severity: 'note' as const,
		},
		onVisibleRowsChange: vi.fn(),
		onSelectFile: vi.fn(),
		onToggleLineSelection: vi.fn(),
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onStageFile: vi.fn(),
		onUnstageFile: vi.fn(),
		onAddCommentForFile: vi.fn(),
		onEditComment: vi.fn(),
		...overrides,
	};
	return {
		...render(GitVirtualDiffSurface, {
			props,
		}),
		props,
	};
}

describe('GitVirtualDiffSurface', () => {
	it('uses one virtual diff root and mounts a bounded row window for large documents', async () => {
		const rows = Array.from({ length: 10_000 }, (_, index) => makeHeaderRow(index));
		const { container } = renderSurface(rows);

		const root = container.querySelector('[data-git-virtual-diff-root]');
		expect(root).toBeTruthy();
		expect(container.querySelector('[data-git-all-files-scroll-root]')).toBeNull();

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
		});
		expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeLessThan(300);
	});

	it('reconciles a refreshed document against the virtualizer item snapshot', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const replacementRows = [makeHeaderRow(2)];
		const { container, props, rerender } = renderSurface(initialRows);

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]')).toHaveLength(3);
		});

		await rerender({
			...props,
			rows: replacementRows,
			fileRowIndex: new Map([['file-2.ts', 0]]),
		});

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]')).toHaveLength(1);
		});
		expect(screen.getByText('file-2.ts')).toBeTruthy();
	});

	it('stages the current file from the virtual file header in the unstaged tab', async () => {
		const onStageFile = vi.fn();
		renderSurface([makeHeaderRow(0)], { onStageFile });

		await fireEvent.click(screen.getByRole('button', { name: 'Stage file' }));

		expect(onStageFile).toHaveBeenCalledWith('file-0.ts');
	});

	it('unstages the current file from the virtual file header in the staged tab', async () => {
		const onUnstageFile = vi.fn();
		renderSurface([makeHeaderRow(0, { indexStatus: 'M', workTreeStatus: ' ' })], {
			activeTab: 'staged',
			onUnstageFile,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Unstage file' }));

		expect(onUnstageFile).toHaveBeenCalledWith('file-0.ts');
	});
});
