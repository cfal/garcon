import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import type { GitFileReviewData } from '$lib/api/git';
import type { GitAllFilesCard as GitAllFilesCardModel } from '$lib/stores/git-workbench.svelte';
import GitAllFilesCard from '../GitAllFilesCard.svelte';

type GitAllFilesCardProps = ComponentProps<typeof GitAllFilesCard>;

function makePreviewData(path = 'src/a.ts'): GitFileReviewData {
	return {
		path,
		mode: 'working',
		profile: 'all-files-preview',
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
				text: '@@ -0,0 +1 @@',
				diffLineIndex: -1,
			},
			{
				key: 'line:0:add:1',
				kind: 'add',
				hunkIndex: 0,
				hunkId: 'hunk-0',
				beforeLine: null,
				afterLine: 1,
				text: 'hello',
				diffLineIndex: 0,
			},
		],
		hunks: [
			{
				id: 'hunk-0',
				header: '@@ -0,0 +1 @@',
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: 1,
				rowStartIndex: 0,
				rowEndIndex: 1,
			},
		],
	};
}

function makeCard(reviewData: GitFileReviewData, state: GitAllFilesCardModel['state']): GitAllFilesCardModel {
	return {
		filePath: reviewData.path,
		category: reviewData.category ?? 'normal',
		state,
		reviewData,
		rowCount: reviewData.rows.length,
		isLoadingFull: false,
		truncatedReason: reviewData.truncatedReason,
		error: reviewData.error,
	};
}

function renderCard(card: GitAllFilesCardModel, overrides: Partial<GitAllFilesCardProps> = {}) {
	const props: GitAllFilesCardProps = {
		card,
		activeTab: 'unstaged',
		diffMode: 'unified',
		contextLines: 5,
		fontSize: 12,
		selectedFile: null,
		selectedLineKeys: new Set<string>(),
		operationPending: false,
		comments: [],
		composerState: {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		},
		isViewed: false,
		onSelectFile: vi.fn(),
		onLoadFullFile: vi.fn(),
		onToggleCollapsed: vi.fn(),
		onToggleViewed: vi.fn(),
		onToggleLineSelection: vi.fn(),
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onAddComment: vi.fn(),
		onEditComment: vi.fn(),
		onRemoveComment: vi.fn(),
		...overrides,
	};
	render(GitAllFilesCard, props);
	return props;
}

describe('GitAllFilesCard', () => {
	it('renders bounded preview rows and keeps line staging wired', async () => {
		const onStageLine = vi.fn();
		renderCard(makeCard(makePreviewData(), 'preview'), { onStageLine });

		expect(await screen.findByText('+hello')).toBeTruthy();
		await fireEvent.click(screen.getByTitle('Stage line'));

		expect(onStageLine).toHaveBeenCalledWith(
			expect.objectContaining({ filePath: 'src/a.ts', tab: 'unstaged', mode: 'stage' }),
			0,
		);
	});

	it('renders binary files as compact placeholders', () => {
		const reviewData = {
			...makePreviewData('asset.bin'),
			profile: 'all-files-preview' as const,
			isBinary: true,
			truncated: true,
			limitReason: 'binary' as const,
			category: 'binary' as const,
			rows: [],
			hunks: [],
			truncatedReason: 'Binary diff is not available.',
		};

		renderCard(makeCard(reviewData, 'binary'));

		expect(screen.getByText('Binary file')).toBeTruthy();
		expect(screen.getByText('Binary diff is not available.')).toBeTruthy();
		expect(screen.queryByText('+hello')).toBeNull();
	});
});
