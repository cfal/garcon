import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { PartialKeys, VirtualizerOptions } from '@tanstack/svelte-virtual';
import type { ComponentProps } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	GitVirtualFileHeaderRow,
	GitVirtualFileLimitRow,
	GitVirtualFilePlaceholderRow,
	GitVirtualReviewRow,
	GitVirtualUnifiedRow,
	GitVirtualCollectionLimitRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import { measureVirtualRow } from '../git-virtual-row-measurement.js';

type TestInitialVirtualizerOptions = PartialKeys<
	VirtualizerOptions<HTMLElement, HTMLDivElement>,
	'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>;
type TestRefreshedVirtualizerOptions = Partial<VirtualizerOptions<HTMLElement, HTMLDivElement>>;

let initialVirtualizerOptions: TestInitialVirtualizerOptions | null;
let refreshedVirtualizerOptions: TestRefreshedVirtualizerOptions | null;
let measureCalls: number;
let setOptionsCalls: number;
let scrollToIndexCalls: number[];
let publishVisibleRange: (startIndex: number, endIndex?: number) => void;

vi.mock('@tanstack/svelte-virtual', async () => {
	const { writable } = await import('svelte/store');
	return {
		createVirtualizer: (options: TestInitialVirtualizerOptions) => {
			initialVirtualizerOptions = options;
			const virtualItems = [0, 1, 2].map((index) => ({
				index,
				key: `file:${index}:header`,
				start: index * 42,
				size: 42,
				end: (index + 1) * 42,
			}));
			const virtualizer = {
				range: { startIndex: 0, endIndex: 2 },
				getVirtualItems: () => virtualItems,
				getTotalSize: () => 126,
				setOptions: (next: TestRefreshedVirtualizerOptions) => {
					setOptionsCalls += 1;
					refreshedVirtualizerOptions = next;
				},
				measureElement: () => undefined,
				scrollToIndex: (index: number) => scrollToIndexCalls.push(index),
				measure: () => {
					measureCalls += 1;
				},
			};
			const store = writable(virtualizer);
			publishVisibleRange = (startIndex, endIndex = startIndex) => {
				virtualizer.range = { startIndex, endIndex };
				store.set(virtualizer);
			};
			return store;
		},
	};
});

import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

type GitVirtualDiffSurfaceProps = ComponentProps<typeof GitVirtualDiffSurface>;

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

function makeCollectionLimitRow(documentId = 'doc-a'): GitVirtualCollectionLimitRow {
	return {
		kind: 'collection-limit',
		id: `${documentId}:collection-limit`,
		filePath: '',
		estimatedHeight: 112,
		title: 'Additional files omitted',
		message: 'Narrow the comparison to load more files.',
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

function makeSurfaceProps(
	rows: GitVirtualReviewRow[],
	overrides: Partial<GitVirtualDiffSurfaceProps> = {},
): GitVirtualDiffSurfaceProps {
	return {
		layoutIdentity: 'layout-a',
		reviewDocumentId: 'doc-a',
		source: arrayGitVirtualReviewRowSource(rows, fileIndexes(rows)),
		activeTab: 'unstaged',
		fontSize: 12,
		selectedLineKeys: new Set<string>(),
		operationPending: false,
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
		showInlineCommentComposer: true,
		onBodyDemand: vi.fn(),
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
		...overrides,
	};
}

describe('Git virtual diff refresh', () => {
	beforeEach(() => {
		initialVirtualizerOptions = null;
		refreshedVirtualizerOptions = null;
		measureCalls = 0;
		setOptionsCalls = 0;
		scrollToIndexCalls = [];
	});

	it('keeps shared measurement options while refreshed rows reconcile', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const replacementRows = [makeHeaderRow(2)];
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
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
			onBodyDemand: vi.fn(),
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
		expect(initialVirtualizerOptions?.measureElement).toBe(measureVirtualRow);
		await waitFor(() => {
			expect(refreshedVirtualizerOptions?.measureElement).toBe(measureVirtualRow);
		});
		await waitFor(() => expect(measureCalls).toBe(1));

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(replacementRows),
		});

		expect(screen.getByText('file-2.ts')).toBeTruthy();
		expect(viewport.scrollTop).toBe(300);
		expect(measureCalls).toBe(1);
		const rowWindow = container.querySelector<HTMLElement>('[data-git-virtual-row-window]');
		expect(rowWindow).toBeTruthy();
		if (!rowWindow) return;
		const mountedRows = Array.from(rowWindow.children);
		expect(mountedRows).toHaveLength(1);
		expect(mountedRows[0]?.parentElement).toBe(rowWindow);
	});

	it('repositions a requested file when preceding rows move its index', async () => {
		const initialRows = makeUnloadedRows();
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
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
			onBodyDemand: vi.fn(),
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
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
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
			onBodyDemand: vi.fn(),
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
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
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
			onBodyDemand: vi.fn(),
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
			source: arrayGitVirtualReviewRowSource([...initialRows.slice(0, -1), makeLimitRow(2)]),
		});

		expect(scrollToIndexCalls).toEqual([4]);
	});

	it('defers an inactive navigation request until the viewport becomes active', async () => {
		const rows = makeUnloadedRows();
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
			active: false,
			source: arrayGitVirtualReviewRowSource(rows, fileIndexes(rows)),
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
			onBodyDemand: vi.fn(),
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

		await waitFor(() => expect(measureCalls).toBe(1));
		expect(scrollToIndexCalls).toEqual([]);
		expect(props.onBodyDemand).not.toHaveBeenCalled();

		await rerender({ ...props, active: true });

		await waitFor(() => expect(scrollToIndexCalls).toEqual([4]));
		expect(props.onBodyDemand).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'navigation', documentId: 'doc-a' }),
		);
	});

	it('keeps measurement callbacks stable for presentation-only source rebuilds', async () => {
		const rows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(rows),
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
			onBodyDemand: vi.fn(),
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
		await waitFor(() => expect(refreshedVirtualizerOptions?.estimateSize).toBeTruthy());
		const estimateSize = refreshedVirtualizerOptions?.estimateSize;
		const getItemKey = refreshedVirtualizerOptions?.getItemKey;
		const initialSetOptionsCalls = setOptionsCalls;

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(
				rows.map((row, index) => ({ ...row, isFocused: index === 0 })),
			),
		});

		expect(refreshedVirtualizerOptions?.estimateSize).toBe(estimateSize);
		expect(refreshedVirtualizerOptions?.getItemKey).toBe(getItemKey);
		expect(setOptionsCalls).toBe(initialSetOptionsCalls);
		expect(measureCalls).toBe(1);
	});

	it('restores scroll after presentation-only rows update the rendered DOM', async () => {
		const rows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const props = makeSurfaceProps(rows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 60;
		let shifted = false;
		const observer = new MutationObserver(() => {
			if (shifted || !container.querySelector('.cm-code-keyword')) return;
			shifted = true;
			viewport.scrollTop = 34;
		});
		observer.observe(viewport, { childList: true, subtree: true });

		const highlightedRows = rows.map((row) =>
			row.kind === 'unified-row'
				? {
						...row,
						view: {
							...row.view,
							segments: [
								{ text: 'added ', className: null },
								{ text: 'line', className: 'cm-code-keyword' },
							],
						},
					}
				: row,
		);

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(highlightedRows, fileIndexes(highlightedRows)),
		});

		await waitFor(() => expect(shifted).toBe(true));
		await waitFor(() => expect(viewport.scrollTop).toBe(60));
		observer.disconnect();
	});

	it('does not restore presentation scroll over a newer user scroll', async () => {
		const rows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const props = makeSurfaceProps(rows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 60;
		let userScrolled = false;
		const observer = new MutationObserver(() => {
			if (userScrolled || !container.querySelector('.cm-code-keyword')) return;
			userScrolled = true;
			viewport.dispatchEvent(new WheelEvent('wheel'));
			viewport.scrollTop = 90;
		});
		observer.observe(viewport, { childList: true, subtree: true });

		const highlightedRows = rows.map((row) =>
			row.kind === 'unified-row'
				? {
						...row,
						view: {
							...row.view,
							segments: [{ text: 'added line', className: 'cm-code-keyword' }],
						},
					}
				: row,
		);

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(highlightedRows, fileIndexes(highlightedRows)),
		});

		await waitFor(() => expect(userScrolled).toBe(true));
		await waitFor(() => expect(viewport.scrollTop).toBe(90));
		observer.disconnect();
	});

	it('lets a layout reset win over presentation scroll restoration', async () => {
		const rows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const props = makeSurfaceProps(rows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 300;
		const replacementRows = rows.map((row) =>
			row.kind === 'file-header' ? { ...row, isFocused: true } : row,
		);

		await rerender({
			...props,
			layoutIdentity: 'layout-b',
			source: arrayGitVirtualReviewRowSource(replacementRows, fileIndexes(replacementRows)),
		});

		await waitFor(() => expect(viewport.scrollTop).toBe(0));
	});

	it('republishes a new review document without resetting the layout scroll', async () => {
		const rows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const onBodyDemand = vi.fn();
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
			source: arrayGitVirtualReviewRowSource(rows),
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
			onBodyDemand,
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
		await waitFor(() => expect(onBodyDemand).toHaveBeenCalled());
		onBodyDemand.mockClear();

		await rerender({ ...props, reviewDocumentId: 'doc-b' });

		await waitFor(() =>
			expect(onBodyDemand).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'viewport', documentId: 'doc-b' }),
			),
		);
		expect(viewport.scrollTop).toBe(300);
		expect(measureCalls).toBe(1);
	});

	it('recomputes the pinned file after a placeholder expands and moves later headers', async () => {
		const initialRows = [
			makeHeaderRow(0),
			makePlaceholderRow(0),
			makeHeaderRow(1),
			makePlaceholderRow(1),
		];
		const props = makeSurfaceProps(initialRows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });

		publishVisibleRange(1);
		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-0.ts'),
		);

		const expandedRows = [
			makeHeaderRow(0),
			makeUnifiedRow(0),
			makeUnifiedRow(0, 'doc-a-expanded'),
			makeHeaderRow(1),
			makeUnifiedRow(1),
		];
		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(expandedRows, fileIndexes(expandedRows)),
		});
		publishVisibleRange(4);

		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-1.ts'),
		);
	});

	it('replaces a pinned header from the current source without resetting stable layout geometry', async () => {
		const initialRows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const props = makeSurfaceProps(initialRows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 300;
		publishVisibleRange(1);
		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-0.ts'),
		);

		const replacementRows = [makeHeaderRow(9), makeUnifiedRow(9), makeHeaderRow(10)];
		await rerender({
			...props,
			reviewDocumentId: 'doc-b',
			source: arrayGitVirtualReviewRowSource(replacementRows, fileIndexes(replacementRows)),
		});

		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-9.ts'),
		);
		expect(viewport.scrollTop).toBe(300);
		expect(measureCalls).toBe(1);
	});

	it('removes the pinned copy when navigation returns the real header to the visible range', async () => {
		const rows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const props = makeSurfaceProps(rows);
		const { container, rerender } = render(GitVirtualDiffSurface, { props });
		publishVisibleRange(1);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeTruthy(),
		);

		await rerender({
			...props,
			scrollToRequest: { filePath: 'file-0.ts', token: 1 },
		});
		await waitFor(() => expect(scrollToIndexCalls).toEqual([0]));
		publishVisibleRange(0);

		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull(),
		);
	});

	it('does not carry a file header over a collection-level limit row', async () => {
		const rows = [makeHeaderRow(0), makeUnifiedRow(0), makeCollectionLimitRow()];
		const props = makeSurfaceProps(rows);
		const { container } = render(GitVirtualDiffSurface, { props });
		publishVisibleRange(1);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeTruthy(),
		);

		publishVisibleRange(2);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull(),
		);
	});

	it('resets scroll and measurements when the layout identity changes', async () => {
		const initialRows = [makeHeaderRow(0), makeUnifiedRow(0), makeHeaderRow(1)];
		const onBodyDemand = vi.fn();
		const props = {
			layoutIdentity: 'layout-a',
			reviewDocumentId: 'doc-a',
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
			onBodyDemand,
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
		publishVisibleRange(1);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeTruthy(),
		);
		await waitFor(() => expect(onBodyDemand).toHaveBeenCalled());
		onBodyDemand.mockClear();

		const replacementRows = [makeHeaderRow(0, 'doc-b'), makeUnifiedRow(0, 'doc-b')];
		await rerender({
			...props,
			layoutIdentity: 'layout-b',
			reviewDocumentId: 'doc-b',
			source: arrayGitVirtualReviewRowSource(replacementRows),
		});
		publishVisibleRange(0);

		expect(viewport.scrollTop).toBe(0);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull(),
		);
		expect(measureCalls).toBeGreaterThanOrEqual(2);
		await waitFor(() => expect(onBodyDemand).toHaveBeenCalled());
	});
});
