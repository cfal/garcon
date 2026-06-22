import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { GitVirtualReviewRow } from '$lib/stores/git-workbench.svelte';
import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

function makeHeaderRow(index: number): GitVirtualReviewRow {
	const path = `file-${index}.ts`;
	return {
		kind: 'file-header',
		id: `file:${index}:header`,
		filePath: path,
		estimatedHeight: 42,
		isViewed: false,
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

function renderSurface(rows: GitVirtualReviewRow[]) {
	return render(GitVirtualDiffSurface, {
		props: {
			rows,
			fileRowIndex: new Map(rows.map((row, index) => [row.filePath, index])),
			activeTab: 'unstaged',
			fontSize: 12,
			selectedLineKeys: new Set<string>(),
			operationPending: false,
			scrollToRequest: null,
			composerState: {
				open: false,
				filePath: '',
				side: 'after',
				line: 0,
				body: '',
				severity: 'note',
			},
			onVisibleRowsChange: vi.fn(),
			onSelectFile: vi.fn(),
			onToggleViewed: vi.fn(),
			onToggleLineSelection: vi.fn(),
			onSelectLineRange: vi.fn(),
			onStageHunk: vi.fn(),
			onUnstageHunk: vi.fn(),
			onStageLine: vi.fn(),
			onUnstageLine: vi.fn(),
			onAddCommentForFile: vi.fn(),
			onEditComment: vi.fn(),
		},
	});
}

describe('GitVirtualDiffSurface', () => {
	it('uses one virtual diff root and mounts a bounded row window for large documents', async () => {
		const rows = Array.from({ length: 10_000 }, (_, index) => makeHeaderRow(index));
		const { container } = renderSurface(rows);

		const root = container.querySelector('[data-git-virtual-diff-root]');
		expect(root).toBeTruthy();
		expect(container.querySelector('[data-git-all-files-scroll-root]')).toBeNull();

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
		});
		expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeLessThan(300);
	});
});
