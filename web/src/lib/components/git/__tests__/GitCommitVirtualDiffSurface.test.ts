import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import GitCommitVirtualDiffSurface from '../GitCommitVirtualDiffSurface.svelte';

const file = {
	path: 'a.ts',
		indexStatus: 'M' as const,
		workTreeStatus: ' ' as const,
	category: 'normal' as const,
	additions: 1,
	deletions: 0,
	estimatedRows: 2,
	bodyState: 'loaded' as const,
	bodyFingerprint: 'fp-a',
	isGenerated: false,
	isBinary: false,
	isTooLarge: false,
};

const rows: GitVirtualReviewRow[] = [
	{
		kind: 'file-header',
		id: 'file:a.ts:header',
		filePath: 'a.ts',
		estimatedHeight: 42,
		file,
		isFocused: false,
	},
	{
		kind: 'unified-row',
		id: 'file:a.ts:row:add',
		filePath: 'a.ts',
		estimatedHeight: 22,
		file,
		actionTarget: {
			filePath: 'a.ts',
			tab: 'staged',
			mode: 'unstage',
			contextLines: 5,
		},
		selectableLineKeys: ['line:a'],
		view: {
			key: 'add',
			row: {
				key: 'add',
				kind: 'add',
				beforeLine: null,
				afterLine: 1,
				beforeText: '',
				afterText: 'added line',
				hunkId: 'h0',
				hunkIndex: 0,
				diffLineIndex: 0,
			},
			isHunkHeader: false,
			isSelectable: false,
			selectionKey: null,
			bgClass: 'bg-diff-add',
			lineNumClass: 'text-diff-add-line-num',
			textClass: 'text-diff-add-fg',
			textPrefix: '+',
			text: 'added line',
			comments: [],
			showComposer: false,
			beforeContextTarget: null,
			afterContextTarget: null,
			rowContextTarget: null,
		},
	},
];

describe('GitCommitVirtualDiffSurface', () => {
	it('renders commit diffs through one virtual root without worktree actions', async () => {
		const { container } = render(GitCommitVirtualDiffSurface, {
			props: {
				rows,
				fileRowIndex: new Map([['a.ts', 0]]),
				fontSize: 12,
				scrollToRequest: null,
				onVisibleRowsChange: vi.fn(),
				onSelectFile: vi.fn(),
			},
		});

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
		});

		expect(container.querySelectorAll('[data-git-virtual-diff-root]')).toHaveLength(1);
		expect(screen.queryByRole('button', { name: /stage/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /unstage/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /comment/i })).toBeNull();
		expect(screen.getByText('+added line')).toBeTruthy();
	});
});
