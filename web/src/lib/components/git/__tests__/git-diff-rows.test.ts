import { describe, expect, it } from 'vitest';
import type { GitFileReviewData, GitReviewCommentDraft } from '$lib/api/git';
import { makeLineSelectionKey } from '$lib/stores/git-workbench.svelte';
import {
	buildCommentsByLineKey,
	buildSplitDiffRows,
	buildSplitDiffRowViews,
	buildUnifiedDiffRows,
	buildUnifiedDiffRowViews,
	getSelectableLineKeys,
	type GitDiffComposerDraft,
} from '../git-diff-rows';

function makeReviewData(): GitFileReviewData {
	return {
		path: 'src/app.ts',
		isBinary: false,
		truncated: false,
		contentBefore: ['const a = 1;', 'const b = 2;', 'console.log(a);'].join('\n'),
		contentAfter: ['const a = 1;', 'const b = 3;', 'const c = 4;', 'console.log(a);'].join(
			'\n',
		),
		diffOps: [
			{ type: 'equal', before: [1, 1], after: [1, 1] },
			{ type: 'delete', before: [2, 2], after: [2, 1] },
			{ type: 'insert', before: [3, 2], after: [2, 2] },
			{ type: 'insert', before: [3, 2], after: [3, 3] },
			{ type: 'equal', before: [3, 3], after: [4, 4] },
		],
		hunks: [
			{
				id: 'hunk-1',
				header: '@@ -1,3 +1,4 @@',
				oldStart: 1,
				oldLines: 3,
				newStart: 1,
				newLines: 4,
				lineStartIndex: 0,
				lineEndIndex: 4,
			},
		],
	};
}

function makeComment(id: string, side: 'before' | 'after', line: number): GitReviewCommentDraft {
	return {
		id,
		filePath: 'src/app.ts',
		side,
		line,
		body: `comment ${id}`,
		severity: 'note',
		createdAt: '2026-01-01T00:00:00.000Z',
	};
}

describe('git diff rows', () => {
	it('builds unified rows from review data with stable line keys', () => {
		const rows = buildUnifiedDiffRows(makeReviewData());

		expect(rows.map((row) => row.kind)).toEqual([
			'hunk-header',
			'context',
			'del',
			'add',
			'add',
			'context',
		]);
		expect(rows[2]).toMatchObject({
			beforeLine: 2,
			afterLine: null,
			beforeText: 'const b = 2;',
			diffLineIndex: 1,
		});
		expect(rows[3]).toMatchObject({
			beforeLine: null,
			afterLine: 2,
			afterText: 'const b = 3;',
			diffLineIndex: 2,
		});
		expect(rows[3].key).toBe('line:2:add:2');
	});

	it('pairs adjacent delete and add rows for split mode', () => {
		const splitRows = buildSplitDiffRows(buildUnifiedDiffRows(makeReviewData()));

		expect(splitRows).toHaveLength(5);
		expect(splitRows[0]).toMatchObject({ isHeader: true, headerText: '@@ -1,3 +1,4 @@' });
		expect(splitRows[2].left).toMatchObject({ kind: 'del', line: 2, text: 'const b = 2;' });
		expect(splitRows[2].right).toMatchObject({ kind: 'add', line: 2, text: 'const b = 3;' });
		expect(splitRows[3].left).toMatchObject({ kind: 'empty', line: null });
		expect(splitRows[3].right).toMatchObject({ kind: 'add', line: 3, text: 'const c = 4;' });
	});

	it('exposes selectable keys in visual order', () => {
		const rows = buildUnifiedDiffRows(makeReviewData());

		expect(getSelectableLineKeys(rows, 'src/app.ts', 'unstaged')).toEqual([
			makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1),
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2),
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 3),
		]);
	});

	it('decorates unified rows with comments, composer targets, and selection classes', () => {
		const rows = buildUnifiedDiffRows(makeReviewData());
		const commentsByLineKey = buildCommentsByLineKey([makeComment('a', 'after', 2)]);
		const selectedLineKeys = new Set([makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2)]);
		const composerTarget: GitDiffComposerDraft = {
			open: true,
			filePath: 'src/app.ts',
			side: 'after',
			line: 3,
			body: 'new note',
			severity: 'warning',
		};

		const views = buildUnifiedDiffRowViews({
			rows,
			filePath: 'src/app.ts',
			activeTab: 'unstaged',
			readOnly: false,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget,
		});

		expect(views[3].comments).toHaveLength(1);
		expect(views[3].bgClass).toBe('bg-interactive-accent/20');
		expect(views[4].showComposer).toBe(true);
		expect(views[4].bgClass).toBe('bg-interactive-accent/10');
	});

	it('decorates split cells with side-specific comments and selection targets', () => {
		const rows = buildSplitDiffRows(buildUnifiedDiffRows(makeReviewData()));
		const commentsByLineKey = buildCommentsByLineKey([makeComment('b', 'before', 2)]);
		const selectedLineKeys = new Set([
			makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1),
		]);

		const views = buildSplitDiffRowViews({
			rows,
			filePath: 'src/app.ts',
			activeTab: 'unstaged',
			readOnly: false,
			selectedLineKeys,
			commentsByLineKey,
			composerTarget: null,
		});

		expect(views[2].comments).toHaveLength(1);
		expect(views[2].left?.selectionKey).toBe(
			makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1),
		);
		expect(views[2].left?.bgClass).toBe('bg-interactive-accent/20');
		expect(views[2].right?.selectionKey).toBe(
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2),
		);
	});
});
