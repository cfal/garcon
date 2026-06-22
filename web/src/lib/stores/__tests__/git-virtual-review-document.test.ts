import { describe, expect, it } from 'vitest';
import type {
	GitReviewDocumentSummary,
	GitReviewFileBody,
	GitReviewFileSummary,
} from '$lib/api/git.js';
import { buildVirtualRows } from '../git/git-virtual-review-document.svelte';

function makeSummary(files: GitReviewFileSummary[]): GitReviewDocumentSummary {
	return {
		documentId: 'doc',
		project: '/project',
		mode: 'working',
		context: 5,
		files,
		limits: {
			maxSummaryFiles: 10_000,
			maxBodyBatchFiles: 24,
			maxLoadedRows: 100_000,
			maxLoadedPatchBytes: 10_000_000,
			maxFileRows: 50_000,
			maxFilePatchBytes: 5_000_000,
			maxLineBytes: 20_000,
			maxContextLines: 50,
			bodyConcurrency: 4,
		},
	};
}

function makeFile(path: string, patch: Partial<GitReviewFileSummary> = {}): GitReviewFileSummary {
	return {
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
		...patch,
	};
}

function makeBody(path: string): GitReviewFileBody {
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		rows: [
			{
				key: 'hunk:0',
				kind: 'hunk',
				hunkIndex: 0,
				hunkId: 'hunk-0',
				beforeLine: null,
				afterLine: null,
				text: '@@ -1 +1 @@',
				diffLineIndex: -1,
			},
			{
				key: 'line:0:add',
				kind: 'add',
				hunkIndex: 0,
				hunkId: 'hunk-0',
				beforeLine: null,
				afterLine: 1,
				text: 'new line',
				diffLineIndex: 0,
			},
		],
		hunks: [
			{
				id: 'hunk-0',
				header: '@@ -1 +1 @@',
				oldStart: 1,
				oldLines: 0,
				newStart: 1,
				newLines: 1,
				rowStartIndex: 0,
				rowEndIndex: 1,
			},
		],
	};
}

function baseOptions(summary: GitReviewDocumentSummary) {
	return {
		summary,
		visibleFilePaths: summary.files.map((file) => file.path),
		fileBodies: {},
		loadingBodies: new Set<string>(),
		focusedFilePath: null,
		diffMode: 'unified' as const,
		activeTab: 'unstaged' as const,
		contextLines: 5,
		commentsByFile: {},
		composerState: {
			open: false,
			filePath: '',
			side: 'after' as const,
			line: 0,
			body: '',
			severity: 'note' as const,
		},
		selectedLineKeys: new Set<string>(),
		isFileViewed: () => false,
	};
}

describe('buildVirtualRows', () => {
	it('flattens loaded file rows into one document row stream', () => {
		const summary = makeSummary([makeFile('a.ts')]);
		const rows = buildVirtualRows({
			...baseOptions(summary),
			fileBodies: { 'a.ts': makeBody('a.ts') },
		});

		expect(rows.map((row) => row.kind)).toEqual(['file-header', 'unified-row', 'unified-row']);
		expect(rows[0]).toMatchObject({ kind: 'file-header', filePath: 'a.ts' });
		expect(rows[2]).toMatchObject({ kind: 'unified-row', filePath: 'a.ts' });
		if (rows[2].kind === 'unified-row') {
			expect(rows[2].view.text).toBe('new line');
			expect(rows[2].selectableLineKeys).toHaveLength(1);
		}
	});

	it('uses placeholders for unloaded files and limit rows for binary files', () => {
		const summary = makeSummary([
			makeFile('a.ts'),
			makeFile('image.png', {
				category: 'binary',
				bodyState: 'binary',
				isBinary: true,
				limitReason: 'binary',
				limitMessage: 'Binary diff is not available.',
			}),
		]);

		const rows = buildVirtualRows(baseOptions(summary));

		expect(rows.map((row) => row.kind)).toEqual([
			'file-header',
			'file-placeholder',
			'file-header',
			'file-limit',
		]);
		expect(rows[3]).toMatchObject({ kind: 'file-limit', filePath: 'image.png', reason: 'binary' });
	});

	it('falls back to summary order when visible file paths are not ready', () => {
		const summary = makeSummary([makeFile('a.ts'), makeFile('b.ts')]);

		const rows = buildVirtualRows({
			...baseOptions(summary),
			visibleFilePaths: [],
		});

		expect(rows.map((row) => `${row.kind}:${row.filePath}`)).toEqual([
			'file-header:a.ts',
			'file-placeholder:a.ts',
			'file-header:b.ts',
			'file-placeholder:b.ts',
		]);
	});

	it('appends an explicit collection limit row', () => {
		const summary = {
			...makeSummary([makeFile('a.ts')]),
			collectionLimit: {
				reason: 'collection-too-many-files' as const,
				message: 'Showing 1 of 2 changed files.',
				visibleFiles: 1,
				totalFilesKnown: 2,
			},
		};

		const rows = buildVirtualRows(baseOptions(summary));

		expect(rows.at(-1)).toMatchObject({
			kind: 'collection-limit',
			title: 'Diff limit reached',
			message: 'Showing 1 of 2 changed files.',
		});
	});
});
