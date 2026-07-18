import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitVirtualFileHeaderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';

let scrollToIndexCalls: Array<[number, { align: string }]>;

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
		scrollToIndex: (index: number, options: { align: string }) => {
			scrollToIndexCalls.push([index, options]);
		},
	};
	return { createVirtualizer: () => readable(virtualizer) };
});

import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

function makeHeaderRow(index: number): GitVirtualFileHeaderRow {
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
		},
	};
}

describe('Git virtual diff refresh', () => {
	beforeEach(() => {
		scrollToIndexCalls = [];
	});

	it('keeps the virtualizer snapshot keys while the refreshed rows reconcile', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const replacementRows = [makeHeaderRow(2)];
		const props = {
			rows: initialRows,
			fileRowIndex: new Map(initialRows.map((row, index) => [row.filePath, index])),
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
		};
		const { rerender } = render(GitVirtualDiffSurface, { props });

		await rerender({
			...props,
			rows: replacementRows,
			fileRowIndex: new Map([['file-2.ts', 0]]),
		});

		expect(screen.getByText('file-2.ts')).toBeTruthy();
	});

	it('repositions a requested file when preceding rows move its index', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const props = {
			rows: initialRows,
			fileRowIndex: new Map(initialRows.map((row, index) => [row.filePath, index])),
			activeTab: 'unstaged' as const,
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: { filePath: 'file-2.ts', token: 1 },
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
		};
		const { rerender } = render(GitVirtualDiffSurface, { props });

		await waitFor(() => {
			expect(scrollToIndexCalls).toContainEqual([2, { align: 'start' }]);
		});
		scrollToIndexCalls = [];

		const movedRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(3), makeHeaderRow(2)];
		await rerender({
			...props,
			rows: movedRows,
			fileRowIndex: new Map(movedRows.map((row, index) => [row.filePath, index])),
		});

		await waitFor(() => {
			expect(scrollToIndexCalls).toContainEqual([3, { align: 'start' }]);
		});
	});
});
