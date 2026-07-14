import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitRenderedDiffRow, GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git';
import {
	buildVirtualRows,
	type GitVirtualReviewRow,
} from '$lib/stores/git/git-virtual-review-document.svelte';
import GitVirtualDiffRow from '../GitVirtualDiffRow.svelte';

type DiffContentRow = Extract<GitVirtualReviewRow, { kind: 'unified-row' | 'split-row' }>;
type UnifiedContentRow = Extract<GitVirtualReviewRow, { kind: 'unified-row' }>;
type SplitContentRow = Extract<GitVirtualReviewRow, { kind: 'split-row' }>;
type GitVirtualDiffRowProps = ComponentProps<typeof GitVirtualDiffRow>;

const file: GitReviewFileSummary = {
	path: 'src/example.ts',
	indexStatus: ' ',
	workTreeStatus: 'M',
	category: 'normal',
	additions: 1,
	deletions: 1,
	estimatedRows: 4,
	bodyState: 'loaded',
	bodyFingerprint: 'fingerprint:src/example.ts',
	isGenerated: false,
	isBinary: false,
	isTooLarge: false,
};

const renderedRows: GitRenderedDiffRow[] = [
	{
		key: 'hunk:0:hunk-0',
		kind: 'hunk',
		hunkIndex: 0,
		hunkId: 'hunk-0',
		beforeLine: null,
		afterLine: null,
		text: '@@ -1,2 +1,2 @@',
		diffLineIndex: -1,
	},
	{
		key: 'line:0:del:1',
		kind: 'del',
		hunkIndex: 0,
		hunkId: 'hunk-0',
		beforeLine: 1,
		afterLine: null,
		text: 'old line',
		diffLineIndex: 0,
	},
	{
		key: 'line:1:add:1',
		kind: 'add',
		hunkIndex: 0,
		hunkId: 'hunk-0',
		beforeLine: null,
		afterLine: 1,
		text: 'new line',
		diffLineIndex: 1,
	},
	{
		key: 'line:2:context:2',
		kind: 'context',
		hunkIndex: 0,
		hunkId: 'hunk-0',
		beforeLine: 2,
		afterLine: 2,
		text: 'shared line',
		diffLineIndex: 2,
	},
];

function buildRows(diffMode: 'unified' | 'split'): DiffContentRow[] {
	const body: GitReviewFileBody = {
		path: file.path,
		bodyFingerprint: file.bodyFingerprint,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		rows: renderedRows,
		hunks: [],
	};
	return buildVirtualRows({
		summary: {
			documentId: 'document-1',
			project: '/project',
			mode: 'working',
			context: 5,
			files: [file],
			limits: {
				maxSummaryFiles: 100,
				maxBodyBatchFiles: 20,
				maxLoadedRows: 10_000,
				maxLoadedPatchBytes: 1_000_000,
				maxFileRows: 1_000,
				maxFilePatchBytes: 100_000,
				maxLineBytes: 10_000,
				maxContextLines: 20,
				bodyConcurrency: 2,
			},
		},
		visibleFilePaths: [file.path],
		fileBodies: { [file.path]: body },
		loadingBodies: new Set(),
		focusedFilePath: file.path,
		diffMode,
		activeTab: 'unstaged',
		contextLines: 5,
		commentsByFile: {},
		composerState: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		selectedLineKeys: new Set(),
	}).filter((row): row is DiffContentRow => row.kind === 'unified-row' || row.kind === 'split-row');
}

function renderRow(
	row: DiffContentRow,
	overrides: Partial<GitVirtualDiffRowProps> = {},
) {
	const props: GitVirtualDiffRowProps = {
		row,
		activeTab: 'unstaged',
		fontSize: 12,
		selectedLineKeys: new Set(),
		operationPending: false,
		composerState: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		editingCommentId: null,
		editBody: '',
		onStartEdit: vi.fn(),
		onCancelEdit: vi.fn(),
		onEditBodyChange: vi.fn(),
		onSaveEdit: vi.fn(),
		onRemoveComment: vi.fn(),
		onToggleLineSelection: vi.fn(),
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onAddCommentForFile: vi.fn(),
		...overrides,
	};
	return { ...render(GitVirtualDiffRow, { props }), props };
}

function findUnifiedRow(kind: 'add' | 'context'): UnifiedContentRow {
	return buildRows('unified').find(
		(row): row is UnifiedContentRow => row.kind === 'unified-row' && row.view.row.kind === kind,
	)!;
}

function findSplitChangeRow(): SplitContentRow {
	return buildRows('split').find(
		(row): row is SplitContentRow =>
			row.kind === 'split-row' && row.view.left?.cell.kind === 'del',
	)!;
}

describe('GitVirtualDiffRow', () => {
	it('opens review from changed and context rows in unified mode', async () => {
		const onAddCommentForFile = vi.fn();
		const addedRow = findUnifiedRow('add');
		const contextRow = findUnifiedRow('context');

		const added = renderRow(addedRow, { onAddCommentForFile });
		await fireEvent.click(screen.getByText('+new line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 1);
		added.unmount();

		renderRow(contextRow, { onAddCommentForFile });
		await fireEvent.click(screen.getByText(/shared line/));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 2);
	});

	it('keeps modifier-click line selection without opening review', async () => {
		const addedRow = findUnifiedRow('add');
		const onAddCommentForFile = vi.fn();
		const onToggleLineSelection = vi.fn();
		renderRow(addedRow, { onAddCommentForFile, onToggleLineSelection });

		await fireEvent.click(screen.getByText('+new line'), { ctrlKey: true });

		expect(onToggleLineSelection).toHaveBeenCalledWith(addedRow.view.selectionKey);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
	});

	it('isolates the unified stage button from review activation', async () => {
		const addedRow = findUnifiedRow('add');
		const onAddCommentForFile = vi.fn();
		const onStageLine = vi.fn();
		renderRow(addedRow, { onAddCommentForFile, onStageLine });

		await fireEvent.click(screen.getByRole('button', { name: 'Stage line' }));

		expect(onStageLine).toHaveBeenCalledWith(addedRow.actionTarget, 1);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
	});

	it('renders the comment icon as a floating hover affordance', () => {
		const addedRow = findUnifiedRow('add');
		const { container } = renderRow(addedRow);

		const affordance = container.querySelector<HTMLElement>('[data-git-comment-affordance]');
		expect(affordance).not.toBeNull();
		expect(affordance?.className).toContain('absolute');
		expect(affordance?.className).toContain('group-hover/diff-cell:opacity-100');
		expect(container.querySelector('[data-git-diff-review-row]')).not.toBeNull();
	});

	it('opens the correct review side in split mode and isolates staging', async () => {
		const splitRow = findSplitChangeRow();
		const onAddCommentForFile = vi.fn();
		const onStageLine = vi.fn();
		renderRow(splitRow, { onAddCommentForFile, onStageLine });

		await fireEvent.click(screen.getByText('-old line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'before', 1);
		await fireEvent.click(screen.getByText('+new line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 1);

		onAddCommentForFile.mockClear();
		await fireEvent.click(screen.getAllByRole('button', { name: 'Stage line' })[0]);
		expect(onStageLine).toHaveBeenCalledWith(splitRow.actionTarget, 0);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
	});

	it('uses native buttons for keyboard-reachable review activation', () => {
		const addedRow = findUnifiedRow('add');
		renderRow(addedRow);

		expect(screen.getByText('+new line').closest('button')).not.toBeNull();
	});
});
