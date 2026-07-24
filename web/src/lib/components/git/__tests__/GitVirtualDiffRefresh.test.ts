import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	GitVirtualFileHeaderRow,
	GitVirtualFileLimitRow,
	GitVirtualFilePlaceholderRow,
	GitVirtualReviewRow,
	GitVirtualUnifiedRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';

let measureCalls: number;
let scrollToIndexCalls: number[];

vi.mock('@tanstack/svelte-virtual', async () => {
	const { readable } = await import('svelte/store');
	const virtualItems = [0, 1, 2].map((index) => ({
		index,
		key: `file:${index}:header`,
		start: index * 42,
		size: 42,
		end: (index + 1) * 42,
	}));
	const virtualizer = {
		getVirtualItems: () => virtualItems,
		getTotalSize: () => 126,
		setOptions: () => undefined,
		measureElement: () => undefined,
		scrollToIndex: (index: number) => scrollToIndexCalls.push(index),
		measure: () => {
			measureCalls += 1;
		},
	};
	return { createVirtualizer: () => readable(virtualizer) };
});

import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

function makeHeaderRow(index: number, documentId = 'doc-a'): GitVirtualFileHeaderRow {
	const path = `file-${index}.ts`;
	return {
		kind: 'file-header',
		id: `${documentId}:file:${index}:header`,
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
		},
	};
}

function makePlaceholderRow(index: number, documentId = 'doc-a'): GitVirtualFilePlaceholderRow {
	const header = makeHeaderRow(index, documentId);
	return {
		kind: 'file-placeholder',
		id: `${documentId}:file:${index}:placeholder`,
		filePath: header.filePath,
		estimatedHeight: 96,
		file: header.file,
		loadState: 'unloaded',
	};
}

function makeUnifiedRow(index: number, documentId = 'doc-a'): GitVirtualUnifiedRow {
	const header = makeHeaderRow(index, documentId);
	return {
		kind: 'unified-row',
		id: `${documentId}:file:${index}:row`,
		filePath: header.filePath,
		estimatedHeight: 22,
		file: header.file,
		view: {
			key: `${documentId}:file:${index}:view`,
			row: {
				key: `${documentId}:file:${index}:rendered`,
				kind: 'add',
				beforeLine: null,
				afterLine: 1,
				beforeText: '',
				afterText: 'added line',
				hunkIndex: 0,
				diffLineIndex: 0,
			},
			isHunkHeader: false,
			isSelectable: false,
			selectionKey: null,
			bgClass: '',
			lineNumClass: '',
			textClass: '',
			textPrefix: '+',
			text: 'added line',
			showComposer: false,
			beforeContextTarget: null,
			afterContextTarget: null,
			rowContextTarget: null,
		},
		actionTarget: null,
		selectableLineKeys: () => [],
	};
}

function makeLimitRow(index: number, documentId = 'doc-a'): GitVirtualFileLimitRow {
	const header = makeHeaderRow(index, documentId);
	return {
		kind: 'file-limit',
		id: `${documentId}:file:${index}:limit:stale-document`,
		filePath: header.filePath,
		estimatedHeight: 112,
		file: header.file,
		title: 'Diff unavailable',
		message: 'Refresh the comparison.',
		reason: 'stale-document',
	};
}

function makeUnloadedRows(): GitVirtualReviewRow[] {
	return [0, 1, 2].flatMap((index) => [makeHeaderRow(index), makePlaceholderRow(index)]);
}

function fileIndexes(rows: GitVirtualReviewRow[]): Map<string, number> {
	return new Map(
		rows.flatMap((row, index) => (row.kind === 'file-header' ? [[row.filePath, index]] : [])),
	);
}

describe('Git virtual diff refresh', () => {
	beforeEach(() => {
		measureCalls = 0;
		scrollToIndexCalls = [];
	});

	it('keeps the virtualizer snapshot keys while the refreshed rows reconcile', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const replacementRows = [makeHeaderRow(2)];
		const props = {
			documentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(initialRows),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: null,
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			showInlineCommentComposer: true,
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
			commentFeedback: null,
			commentError: null,
			commentCopyText: null,
			onOpenChat: vi.fn(),
		};
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 300;
		await waitFor(() => expect(measureCalls).toBe(1));

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(replacementRows),
		});

		expect(screen.getByText('file-2.ts')).toBeTruthy();
		expect(viewport.scrollTop).toBe(300);
		expect(measureCalls).toBe(1);
	});

	it('repositions a requested file when preceding rows move its index', async () => {
		const initialRows = makeUnloadedRows();
		const props = {
			documentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(initialRows, fileIndexes(initialRows)),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: { filePath: 'file-2.ts', token: 1 },
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			showInlineCommentComposer: true,
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
			commentFeedback: null,
			commentError: null,
			commentCopyText: null,
			onOpenChat: vi.fn(),
		};
		const { rerender } = render(GitVirtualDiffSurface, { props });

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4]));

		const movedRows = [
			makeHeaderRow(0),
			makeUnifiedRow(0),
			makeUnifiedRow(0, 'doc-a-expanded'),
			makeHeaderRow(1),
			makePlaceholderRow(1),
			makeHeaderRow(2),
			makePlaceholderRow(2),
		];
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(movedRows, fileIndexes(movedRows)),
		});

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4, 5]));
	});

	it('repositions a requested file after its lazy body expands in place', async () => {
		const initialRows = makeUnloadedRows();
		const props = {
			documentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(initialRows, fileIndexes(initialRows)),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: { filePath: 'file-2.ts', token: 1 },
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			showInlineCommentComposer: true,
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
			commentFeedback: null,
			commentError: null,
			commentCopyText: null,
			onOpenChat: vi.fn(),
		};
		const { container, rerender } = render(GitVirtualDiffSurface, { props });

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4]));

		const expandedRows = [...initialRows.slice(0, -1), makeUnifiedRow(2)];
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(expandedRows, fileIndexes(expandedRows)),
		});

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4, 4]));

		const shiftedRows = [
			...expandedRows.slice(0, 2),
			makeUnifiedRow(0, 'preceding-file-expanded'),
			...expandedRows.slice(2),
		];
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(shiftedRows, fileIndexes(shiftedRows)),
		});

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4, 4, 5]));

		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(viewport).toBeTruthy();
		if (!viewport) return;
		await fireEvent.wheel(viewport);

		const shiftedAgainRows = [
			...shiftedRows.slice(0, 3),
			makeUnifiedRow(0, 'preceding-file-expanded-again'),
			...shiftedRows.slice(3),
		];
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(shiftedAgainRows, fileIndexes(shiftedAgainRows)),
		});

		expect(scrollToIndexCalls).toEqual([4, 4, 5]);
	});

	it('does not replay a serviced scroll when a pending file becomes stale', async () => {
		const initialRows = makeUnloadedRows();
		const props = {
			documentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(initialRows, fileIndexes(initialRows)),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: { filePath: 'file-2.ts', token: 1 },
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			showInlineCommentComposer: true,
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
			commentFeedback: null,
			commentError: null,
			commentCopyText: null,
			onOpenChat: vi.fn(),
		};
		const { rerender } = render(GitVirtualDiffSurface, { props });

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4]));
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource([
				...initialRows.slice(0, -1),
				makeLimitRow(2),
			]),
		});

		expect(scrollToIndexCalls).toEqual([4]);
	});

	it('resets scroll and measurements when the document identity changes', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const onVisibleRowsChange = vi.fn();
		const props = {
			documentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(initialRows),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: null,
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			showInlineCommentComposer: true,
			onVisibleRowsChange,
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
			commentFeedback: null,
			commentError: null,
			commentCopyText: null,
			onOpenChat: vi.fn(),
		};
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 300;
		await waitFor(() => expect(onVisibleRowsChange).toHaveBeenCalled());
		onVisibleRowsChange.mockClear();

		const replacementRows = [
			makeHeaderRow(0, 'doc-b'),
			makeHeaderRow(1, 'doc-b'),
			makeHeaderRow(2, 'doc-b'),
		];
		await rerender({
			...props,
			documentId: 'doc-b',
			source: arrayGitVirtualReviewRowSource(replacementRows),
		});

		expect(viewport.scrollTop).toBe(0);
		expect(measureCalls).toBeGreaterThanOrEqual(2);
		await waitFor(() => expect(onVisibleRowsChange).toHaveBeenCalled());
	});
});
