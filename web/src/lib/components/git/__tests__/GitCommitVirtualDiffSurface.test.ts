import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import { installGitVirtualDiffTestLayout } from './git-virtual-diff-test-layout.js';
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
		actionTarget: null,
		selectableLineKeys: () => [],
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
			showComposer: false,
			beforeContextTarget: null,
			afterContextTarget: {
				side: 'after',
				line: 1,
				hunkIndex: 0,
				diffLineIndex: 0,
				rowKind: 'add',
			},
			rowContextTarget: {
				side: 'after',
				line: 1,
				hunkIndex: 0,
				diffLineIndex: 0,
				rowKind: 'add',
			},
		},
	},
];

describe('GitCommitVirtualDiffSurface', () => {
	beforeEach(() => {
		installGitVirtualDiffTestLayout({ viewportHeight: 720 });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders commit diffs through one virtual root without worktree actions', async () => {
		const onAddComment = vi.fn();
		const { container } = render(GitCommitVirtualDiffSurface, {
			props: {
				documentId: 'doc',
				source: arrayGitVirtualReviewRowSource(rows),
				fontSize: 12,
				scrollToRequest: null,
				composerState: {
					open: false,
					focusPending: false,
					filePath: '',
					side: 'after',
					line: 0,
					body: '',
					severity: 'note',
				},
				commentFeedback: null,
				commentError: null,
				commentCopyText: null,
				onBodyDemand: vi.fn(),
				onSelectFile: vi.fn(),
				onAddComment,
				onComposerBodyChange: vi.fn(),
				onComposerSeverityChange: vi.fn(),
				onComposerSubmit: vi.fn(),
				onComposerClose: vi.fn(),
				onComposerFocusHandled: vi.fn(),
				onOpenChat: vi.fn(),
				emptyMessage: 'No changes in this commit.',
			},
		});

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
		});

		expect(container.querySelectorAll('[data-git-virtual-diff-root]')).toHaveLength(1);
		expect(screen.queryByRole('button', { name: /stage/i })).toBeNull();
		expect(screen.queryByRole('button', { name: /unstage/i })).toBeNull();
		expect(screen.getByText('+added line')).toBeTruthy();
		await screen.getByText('+added line').click();
		expect(onAddComment).toHaveBeenCalledWith('a.ts', 'after', 1);
	});

	it('pins the complete commit header variant and preserves file selection', async () => {
		const renamedFile = {
			...file,
			path: 'src/new.ts',
			originalPath: 'src/old.ts',
			indexStatus: 'R' as const,
			category: 'generated' as const,
			additions: 12,
			deletions: 4,
			statsKnown: false,
		};
		const header = {
			kind: 'file-header' as const,
			id: 'file:src/new.ts:header',
			filePath: renamedFile.path,
			estimatedHeight: 42,
			file: renamedFile,
			isFocused: true,
		};
		const longRows: GitVirtualReviewRow[] = [
			header,
			...Array.from({ length: 40 }, (_, index) => ({
				kind: 'file-placeholder' as const,
				id: `file:src/new.ts:body:${index}`,
				filePath: renamedFile.path,
				estimatedHeight: 42,
				file: renamedFile,
				loadState: 'loading' as const,
			})),
		];
		const onSelectFile = vi.fn();
		const { container } = render(GitCommitVirtualDiffSurface, {
			props: {
				documentId: 'doc',
				source: arrayGitVirtualReviewRowSource(longRows),
				fontSize: 12,
				scrollToRequest: null,
				composerState: {
					open: false,
					focusPending: false,
					filePath: '',
					side: 'after',
					line: 0,
					body: '',
					severity: 'note',
				},
				commentFeedback: null,
				commentError: null,
				commentCopyText: null,
				onBodyDemand: vi.fn(),
				onSelectFile,
				onAddComment: vi.fn(),
				onComposerBodyChange: vi.fn(),
				onComposerSeverityChange: vi.fn(),
				onComposerSubmit: vi.fn(),
				onComposerClose: vi.fn(),
				onComposerFocusHandled: vi.fn(),
				onOpenChat: vi.fn(),
				emptyMessage: 'No changes in this commit.',
			},
		});
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 42;
		await fireEvent.scroll(viewport);
		const pinned = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-git-pinned-file-header]');
			expect(element?.dataset.filePath).toBe('src/new.ts');
			return element!;
		});

		expect(within(pinned).getByText('from src/old.ts')).toBeTruthy();
		expect(within(pinned).getByText('Renamed')).toBeTruthy();
		expect(within(pinned).getByText('generated')).toBeTruthy();
		expect(within(pinned).getByText('+?')).toBeTruthy();
		expect(within(pinned).getByText('-?')).toBeTruthy();
		const pathButton = within(pinned).getByRole('button', {
			name: /src\/new\.ts from src\/old\.ts/,
		});
		await fireEvent.click(pathButton);
		expect(onSelectFile).toHaveBeenCalledOnce();
		expect(onSelectFile).toHaveBeenCalledWith('src/new.ts');
	});
});
