import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import GitVirtualDiffRow from '../GitVirtualDiffRow.svelte';

function buildVirtualRows(
	options: Parameters<typeof buildGitVirtualReviewRowSource>[0],
) {
	const source = buildGitVirtualReviewRowSource(options);
	return source.rowsInRange(0, source.rowCount);
}

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

function buildRows(diffMode: 'unified' | 'split'): DiffContentRow[] {
	const patch =
		'diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n shared line\n';
	const body: GitReviewFileBody = {
		path: file.path,
		bodyFingerprint: file.bodyFingerprint,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: 4,
		patchBytes: patch.length,
		patch,
		patchIndex: createGitPatchIndex(patch),
	};
	return buildVirtualRows({
		summary: {
			documentId: 'document-1',
			project: '/project',
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
		contextLines: 5,
		interaction: {
			kind: 'workbench',
			activeTab: 'unstaged',
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after',
				line: 0,
				body: '',
				severity: 'note',
			},
			selectedLineKeys: new Set(),
		},
	}).filter((row): row is DiffContentRow => row.kind === 'unified-row' || row.kind === 'split-row');
}

function renderRowInteraction(): Extract<
	GitVirtualDiffRowProps['interaction'],
	{ kind: 'workbench' }
> {
	return {
		kind: 'workbench',
		showInlineCommentComposer: true,
		activeTab: 'unstaged',
		selectedLineKeys: new Set(),
		operationPending: false,
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
		onToggleLineSelection: vi.fn(),
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onAddComment: vi.fn(),
		onOpenChat: vi.fn(),
	};
}

function renderRow(row: DiffContentRow, overrides: Partial<GitVirtualDiffRowProps> = {}) {
	const props: GitVirtualDiffRowProps = {
		row,
		fontSize: 12,
		interaction: renderRowInteraction(),
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
		(row): row is SplitContentRow => row.kind === 'split-row' && row.view.left?.cell.kind === 'del',
	)!;
}

describe('GitVirtualDiffRow', () => {
	it('opens review from changed and context rows in unified mode', async () => {
		const onAddCommentForFile = vi.fn();
		const addedRow = findUnifiedRow('add');
		const contextRow = findUnifiedRow('context');

		const added = renderRow(addedRow, {
			interaction: { ...renderRowInteraction(), onAddComment: onAddCommentForFile },
		});
		await fireEvent.click(screen.getByText('+new line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 1);
		added.unmount();

		renderRow(contextRow, {
			interaction: { ...renderRowInteraction(), onAddComment: onAddCommentForFile },
		});
		await fireEvent.click(screen.getByText(/shared line/));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 2);
	});

	it('targets the before side from the old-line gutter in unified mode', async () => {
		const onAddCommentForFile = vi.fn();
		const contextRow = findUnifiedRow('context');
		const { container } = renderRow(contextRow, {
			interaction: { ...renderRowInteraction(), onAddComment: onAddCommentForFile },
		});
		const lineButtons = container.querySelectorAll<HTMLElement>(
			'[data-git-diff-review-row] > button',
		);

		await fireEvent.click(lineButtons[0]!);

		expect(onAddCommentForFile).toHaveBeenCalledWith('src/example.ts', 'before', 2);
	});

	it('keeps modifier-click line selection without opening review', async () => {
		const addedRow = findUnifiedRow('add');
		const onAddCommentForFile = vi.fn();
		const onToggleLineSelection = vi.fn();
		renderRow(addedRow, {
			interaction: {
				...renderRowInteraction(),
				onAddComment: onAddCommentForFile,
				onToggleLineSelection,
			},
		});

		await fireEvent.click(screen.getByText('+new line'), { ctrlKey: true });

		expect(onToggleLineSelection).toHaveBeenCalledWith(addedRow.view.selectionKey);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
	});

	it('isolates the unified stage button from review activation', async () => {
		const addedRow = findUnifiedRow('add');
		const onAddCommentForFile = vi.fn();
		const onStageLine = vi.fn();
		renderRow(addedRow, {
			interaction: {
				...renderRowInteraction(),
				onAddComment: onAddCommentForFile,
				onStageLine,
			},
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Stage line' }));

		expect(onStageLine).toHaveBeenCalledWith(addedRow.actionTarget, 1);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
	});

	it('renders the comment icon as a floating hover affordance', () => {
		const addedRow = findUnifiedRow('add');
		const { container } = renderRow(addedRow);

		const affordance = container.querySelector<HTMLElement>('[data-git-comment-affordance]');
		const reviewRow = container.querySelector<HTMLElement>('[data-git-diff-review-row]');
		expect(affordance).not.toBeNull();
		expect(affordance?.className).toContain('absolute');
		expect(affordance?.className).toContain('group-hover/diff-cell:opacity-100');
		expect(reviewRow?.className).toContain('diff-row-paint');
	});

	it('does not render the inline composer when the workbench uses its mobile modal', () => {
		const addedRow = findUnifiedRow('add');
		addedRow.view = { ...addedRow.view, showComposer: true };
		const interaction = renderRowInteraction();
		interaction.showInlineCommentComposer = false;
		interaction.composerState = {
			open: true,
			focusPending: true,
			filePath: addedRow.file.path,
			side: 'after',
			line: 1,
			body: '',
			severity: 'note',
		};

		const { container } = renderRow(addedRow, { interaction });

		expect(container.querySelector('[data-git-comment-composer]')).toBeNull();
	});

	it('opens the correct review side in split mode and isolates staging', async () => {
		const splitRow = findSplitChangeRow();
		const onAddCommentForFile = vi.fn();
		const onStageLine = vi.fn();
		const { container } = renderRow(splitRow, {
			interaction: {
				...renderRowInteraction(),
				onAddComment: onAddCommentForFile,
				onStageLine,
			},
		});

		await fireEvent.click(screen.getByText('-old line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'before', 1);
		await fireEvent.click(screen.getByText('+new line'));
		expect(onAddCommentForFile).toHaveBeenLastCalledWith('src/example.ts', 'after', 1);

		onAddCommentForFile.mockClear();
		await fireEvent.click(screen.getAllByRole('button', { name: 'Stage line' })[0]);
		expect(onStageLine).toHaveBeenCalledWith(splitRow.actionTarget, 0);
		expect(onAddCommentForFile).not.toHaveBeenCalled();
		expect(container.querySelectorAll('.diff-row-paint')).toHaveLength(3);
	});

	it('uses native buttons for keyboard-reachable review activation', () => {
		const addedRow = findUnifiedRow('add');
		const { container } = renderRow(addedRow);

		expect(screen.getByText('+new line').closest('button')).not.toBeNull();
		for (const button of container.querySelectorAll('button')) {
			expect(button.textContent?.trim() || button.getAttribute('aria-label')).toBeTruthy();
		}
	});
});
