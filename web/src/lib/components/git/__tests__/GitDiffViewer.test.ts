import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitFileReviewData } from '$lib/api/git';
import { makeLineSelectionKey } from '$lib/stores/git-workbench.svelte';
import GitDiffViewer from '../GitDiffViewer.svelte';

function makeLargeInsertDiff(lineCount: number): GitFileReviewData {
	const lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
	return {
		path: 'src/generated.ts',
		isBinary: false,
		truncated: false,
		contentBefore: '',
		contentAfter: lines.join('\n'),
		diffOps: lines.map((_, index) => ({
			type: 'insert' as const,
			before: [1, 0] as [number, number],
			after: [index + 1, index + 1] as [number, number],
		})),
		hunks: [
			{
				id: 'hunk-1',
				header: `@@ -0,0 +1,${lineCount} @@`,
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: lineCount,
				lineStartIndex: 0,
				lineEndIndex: lineCount - 1,
			},
		],
	};
}

function makeBinaryFile(): GitFileReviewData {
	return {
		path: 'assets/screenshot.png',
		isBinary: true,
		truncated: false,
		contentBefore: '',
		contentAfter: '',
		diffOps: [],
		hunks: [],
	};
}

function renderViewer(diffMode: 'unified' | 'split') {
	const onToggleLineSelection = vi.fn();
	render(GitDiffViewer, {
		filePath: 'src/generated.ts',
		reviewData: makeLargeInsertDiff(140),
		activeTab: 'unstaged',
		diffMode,
		fontSize: 12,
		contextLines: 5,
		selectedLineKeys: new Set<string>(),
		isLoading: false,
		onToggleLineSelection,
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onAddComment: vi.fn(),
	});
	return { onToggleLineSelection };
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
});
