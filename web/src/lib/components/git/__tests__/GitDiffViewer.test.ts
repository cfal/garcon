import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitFileReviewData } from '$lib/api/git';
import {
	makeLineSelectionKey,
	type GitDiffActionTarget,
} from '$lib/stores/git-workbench.svelte';
import GitDiffViewer from '../GitDiffViewer.svelte';

type StageLineHandler = (target: GitDiffActionTarget, diffLineIndex: number) => void;

function makeLargeInsertDiff(lineCount: number): GitFileReviewData {
	const lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
	return {
		path: 'src/generated.ts',
		mode: 'working',
		isBinary: false,
		truncated: false,
		rows: [
			{
				key: 'hunk:0:hunk-0',
				kind: 'hunk',
				hunkIndex: 0,
				hunkId: 'hunk-0',
				beforeLine: null,
				afterLine: null,
				text: `@@ -0,0 +1,${lineCount} @@`,
				diffLineIndex: -1,
			},
			...lines.map((line, index) => ({
				key: `line:${index}:add:${index + 1}`,
				kind: 'add' as const,
				hunkIndex: 0,
				hunkId: 'hunk-0',
				beforeLine: null,
				afterLine: index + 1,
				text: line,
				diffLineIndex: index,
			})),
		],
		hunks: [
			{
				id: 'hunk-0',
				header: `@@ -0,0 +1,${lineCount} @@`,
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: lineCount,
				rowStartIndex: 0,
				rowEndIndex: lineCount,
			},
		],
	};
}

function makeBinaryFile(): GitFileReviewData {
	return {
		path: 'assets/screenshot.png',
		mode: 'working',
		isBinary: true,
		truncated: false,
		rows: [],
		hunks: [],
	};
}

function renderViewer(
	diffMode: 'unified' | 'split',
	options: { operationPending?: boolean; onStageLine?: StageLineHandler } = {},
) {
	const onToggleLineSelection = vi.fn();
	const onStageLine = options.onStageLine ?? vi.fn<StageLineHandler>();
	render(GitDiffViewer, {
		filePath: 'src/generated.ts',
		reviewData: makeLargeInsertDiff(140),
		activeTab: 'unstaged',
		diffMode,
		fontSize: 12,
		contextLines: 5,
		selectedLineKeys: new Set<string>(),
		isLoading: false,
		operationPending: options.operationPending ?? false,
		onToggleLineSelection,
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine,
		onUnstageLine: vi.fn(),
		onAddComment: vi.fn(),
	});
	return { onToggleLineSelection, onStageLine };
}

describe('GitDiffViewer', () => {
	it('virtualizes unified rows while preserving line selection', async () => {
		const { onToggleLineSelection } = renderViewer('unified');

		const firstLine = await screen.findByText('+line 1');
		await fireEvent.click(firstLine);

		expect(onToggleLineSelection).toHaveBeenCalledWith(
			makeLineSelectionKey('src/generated.ts', 'unstaged', 'after', 0),
		);
		expect(screen.queryByText('+line 140')).toBeNull();
	});

	it('renders binary files as a compact row with path and badge', () => {
		render(GitDiffViewer, {
			filePath: 'assets/screenshot.png',
			reviewData: makeBinaryFile(),
			activeTab: 'unstaged',
			diffMode: 'unified',
			fontSize: 12,
			contextLines: 5,
			selectedLineKeys: new Set<string>(),
			isLoading: false,
			onToggleLineSelection: vi.fn(),
			onSelectLineRange: vi.fn(),
			onStageHunk: vi.fn(),
			onUnstageHunk: vi.fn(),
			onStageLine: vi.fn(),
			onUnstageLine: vi.fn(),
			onAddComment: vi.fn(),
		});

		expect(screen.getByText('assets/screenshot.png')).not.toBeNull();
		expect(screen.getByText('binary')).not.toBeNull();
		// No tall centered placeholder: the verbose unavailable message is gone.
		expect(screen.queryByText('Binary file -- cannot display diff')).toBeNull();
	});

	it('virtualizes split rows while preserving line selection', async () => {
		const { onToggleLineSelection } = renderViewer('split');

		const firstLine = await screen.findByText('+line 1');
		await fireEvent.click(firstLine);

		expect(onToggleLineSelection).toHaveBeenCalledWith(
			makeLineSelectionKey('src/generated.ts', 'unstaged', 'after', 0),
		);
		await waitFor(() => {
			expect(screen.queryByText('+line 140')).toBeNull();
		});
	});

	it('disables context-menu staging while an operation is pending', async () => {
		const onStageLine = vi.fn();
		renderViewer('unified', { operationPending: true, onStageLine });

		const firstLine = await screen.findByText('+line 1');
		await fireEvent.contextMenu(firstLine);

		const stageLine = await screen.findByRole('menuitem', { name: /stage line/i });
		expect((stageLine as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(stageLine);
		expect(onStageLine).not.toHaveBeenCalled();
	});
});
