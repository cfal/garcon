import { describe, expect, it } from 'vitest';
import type { GitRenderedDiffRow } from '$lib/git/review/git-rendered-diff-types.js';
import { makeLineSelectionKey } from '$lib/git/review/git-line-selection.svelte.js';
import {
	buildSplitDiffRowView,
	buildUnifiedDiffRowView,
	renderUnifiedDiffRow,
	type GitDiffComposerDraft,
	type SplitDiffRow,
} from '$lib/git/review/git-diff-rows.js';
import type { GitDiffFileSyntaxResult } from '$lib/git/review/git-diff-syntax.js';

function makeReviewData(): GitRenderedDiffRow[] {
	return [
		{
			key: 'hunk:0:hunk-0',
			kind: 'hunk',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: null,
			afterLine: null,
			text: '@@ -1,3 +1,4 @@',
			diffLineIndex: -1,
		},
		{
			key: 'line:0:context:1:1',
			kind: 'context',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: 1,
			afterLine: 1,
			text: 'const a = 1;',
			diffLineIndex: 0,
		},
		{
			key: 'line:1:del:2',
			kind: 'del',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: 2,
			afterLine: null,
			text: 'const b = 2;',
			diffLineIndex: 1,
		},
		{
			key: 'line:2:add:2',
			kind: 'add',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: null,
			afterLine: 2,
			text: 'const b = 3;',
			diffLineIndex: 2,
		},
		{
			key: 'line:3:add:3',
			kind: 'add',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: null,
			afterLine: 3,
			text: 'const c = 4;',
			diffLineIndex: 3,
		},
		{
			key: 'line:4:context:3:4',
			kind: 'context',
			hunkIndex: 0,
			hunkId: 'hunk-0',
			beforeLine: 3,
			afterLine: 4,
			text: 'console.log(a);',
			diffLineIndex: 4,
		},
	];
}

function buildUnifiedDiffRows(rows: GitRenderedDiffRow[]) {
	return rows.map(renderUnifiedDiffRow);
}

function splitRows(): SplitDiffRow[] {
	return [
		{ key: 'header', isHeader: true, left: null, right: null },
		{
			key: 'context',
			isHeader: false,
			hunkIndex: 0,
			left: { kind: 'context', line: 1, text: 'const a = 1;', diffLineIndex: 0 },
			right: { kind: 'context', line: 1, text: 'const a = 1;', diffLineIndex: 0 },
		},
		{
			key: 'pair',
			isHeader: false,
			hunkIndex: 0,
			left: { kind: 'del', line: 2, text: 'const b = 2;', diffLineIndex: 1 },
			right: { kind: 'add', line: 2, text: 'const b = 3;', diffLineIndex: 2 },
		},
		{
			key: 'addition',
			isHeader: false,
			hunkIndex: 0,
			left: { kind: 'empty', line: null, text: '', diffLineIndex: -1 },
			right: { kind: 'add', line: 3, text: 'const c = 4;', diffLineIndex: 3 },
		},
	];
}

function syntaxResult(): GitDiffFileSyntaxResult {
	return {
		cacheKey: 'syntax',
		filePath: 'src/app.ts',
		bodyFingerprint: 'fingerprint',
		before: {
			path: 'src/app.ts',
			languageKey: 'typescript',
			lines: new Map([
				[0, [{ text: 'const a = 1;', className: 'cm-code-name' }]],
				[1, [{ text: 'const b = 2;', className: 'cm-code-deletion' }]],
				[4, [{ text: 'console.log(a);', className: 'cm-code-name' }]],
			]),
			characterCount: 42,
			segmentCount: 3,
		},
		after: {
			path: 'src/app.ts',
			languageKey: 'typescript',
			lines: new Map([
				[0, [{ text: 'const a = 1;', className: 'cm-code-keyword' }]],
				[2, [{ text: 'const b = 3;', className: 'cm-code-addition' }]],
				[3, [{ text: 'const c = 4;', className: 'cm-code-addition' }]],
				[4, [{ text: 'console.log(a);', className: 'cm-code-title' }]],
			]),
			characterCount: 55,
			segmentCount: 4,
		},
		characterCount: 97,
		segmentCount: 7,
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

	it('exposes selectable keys in visual order', () => {
		const rows = buildUnifiedDiffRows(makeReviewData());

		const views = rows.map((row) =>
			buildUnifiedDiffRowView(
				{
					filePath: 'src/app.ts',
					activeTab: 'unstaged',
					readOnly: false,
					selectedLineKeys: new Set(),
					composerTarget: null,
				},
				row,
			),
		);
		expect(views.flatMap((row) => row.selectionKey ?? [])).toEqual([
			makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1),
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2),
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 3),
		]);
	});

	it('decorates unified rows with composer targets and selection classes', () => {
		const rows = buildUnifiedDiffRows(makeReviewData());
		const selectedLineKeys = new Set([makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2)]);
		const composerTarget: GitDiffComposerDraft = {
			open: true,
			filePath: 'src/app.ts',
			side: 'after',
			line: 3,
			body: 'new note',
			severity: 'warning',
		};

		const views = rows.map((row) =>
			buildUnifiedDiffRowView(
				{
					filePath: 'src/app.ts',
					activeTab: 'unstaged',
					readOnly: false,
					selectedLineKeys,
					composerTarget,
				},
				row,
			),
		);

		expect(views[3].bgClass).toBe('bg-interactive-accent/20');
		expect(views[4].showComposer).toBe(true);
		expect(views[4].bgClass).toBe('bg-interactive-accent/10');
		expect(views[1].lineNumClass).toBe('text-foreground/70');
	});

	it('decorates split cells with side-specific selection targets', () => {
		const rows = splitRows();
		const selectedLineKeys = new Set([makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1)]);

		const views = rows.map((row) =>
			buildSplitDiffRowView(
				{
					filePath: 'src/app.ts',
					activeTab: 'unstaged',
					readOnly: false,
					selectedLineKeys,
					composerTarget: null,
				},
				row,
			),
		);

		expect(views[2].left?.selectionKey).toBe(
			makeLineSelectionKey('src/app.ts', 'unstaged', 'before', 1),
		);
		expect(views[2].left?.bgClass).toBe('bg-interactive-accent/20');
		expect(views[2].right?.selectionKey).toBe(
			makeLineSelectionKey('src/app.ts', 'unstaged', 'after', 2),
		);
		expect(views[1].left?.lineNumClass).toBe('text-foreground/70');
	});

	it('projects before and after syntax segments onto unified rows', () => {
		const views = buildUnifiedDiffRows(makeReviewData()).map((row) =>
			buildUnifiedDiffRowView(
				{
					filePath: 'src/app.ts',
					activeTab: 'unstaged',
					readOnly: false,
					selectedLineKeys: new Set(),
					composerTarget: null,
					syntaxResult: syntaxResult(),
				},
				row,
			),
		);

		expect(views[0].segments).toBeUndefined();
		expect(views[1].segments?.[0].className).toBe('cm-code-keyword');
		expect(views[2].segments?.[0].className).toBe('cm-code-deletion');
		expect(views[3].segments?.[0].className).toBe('cm-code-addition');
		expect(views[5].segments?.[0].className).toBe('cm-code-title');
		expect(views[2].text).toBe('const b = 2;');
	});

	it('projects each split cell from its own syntax side', () => {
		const views = splitRows().map((row) =>
			buildSplitDiffRowView(
				{
					filePath: 'src/app.ts',
					activeTab: 'unstaged',
					readOnly: false,
					selectedLineKeys: new Set(),
					composerTarget: null,
					syntaxResult: syntaxResult(),
				},
				row,
			),
		);

		expect(views[0].left).toBeNull();
		expect(views[1].left?.segments?.[0].className).toBe('cm-code-name');
		expect(views[1].right?.segments?.[0].className).toBe('cm-code-keyword');
		expect(views[2].left?.segments?.[0].className).toBe('cm-code-deletion');
		expect(views[2].right?.segments?.[0].className).toBe('cm-code-addition');
		expect(views[3].left?.segments).toBeUndefined();
	});
});
