import { describe, expect, it } from 'vitest';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';

function summary(path: string, renderedRows: number): GitReviewFileSummary {
	return {
		path,
		indexStatus: 'M',
		workTreeStatus: 'M',
		category: 'normal',
		additions: renderedRows,
		deletions: 0,
		estimatedRows: renderedRows,
		bodyState: 'unloaded',
		bodyFingerprint: `fingerprint:${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function indexedBody(path: string, lineCount: number): GitReviewFileBody {
	const lines = Array.from({ length: lineCount }, (_, index) => `+line ${index}`).join('\n');
	const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +1,${lineCount} @@\n${lines}\n`;
	const patchIndex = createGitPatchIndex(patch, lineCount + 1);
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: lineCount + 1,
		patchBytes: patch.length,
		patch,
		patchIndex,
	};
}

function options(files: GitReviewFileSummary[], bodies: Record<string, GitReviewFileBody>) {
	return {
		summary: {
			documentId: 'document',
			project: '/project',
			context: 3,
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
		},
		visibleFilePaths: files.map((file) => file.path),
		fileBodies: bodies,
		loadingBodies: new Set<string>(),
		focusedFilePath: null,
		diffMode: 'unified' as const,
		contextLines: 3,
		interaction: { kind: 'read-only' as const },
	};
}

describe('Git virtual review row source', () => {
	it('resolves only requested rows from a 100,000-row document', () => {
		const first = summary('first.txt', 49_999);
		const second = summary('second.txt', 49_999);
		const source = buildGitVirtualReviewRowSource(
			options([first, second], {
				'first.txt': indexedBody('first.txt', 49_999),
				'second.txt': indexedBody('second.txt', 49_999),
			}),
		);

		expect(source.rowCount).toBe(100_002);
		expect(source.rowsInRange(50_000, 50_020)).toHaveLength(20);
		expect(source.fileStart('second.txt')).toBe(50_001);
		expect(source.rowKey(50_001)).toBe(2_000_000);
	});

	it('aligns delete and add runs in split mode without legacy rows', () => {
		const file = summary('file.txt', 4);
		const patch = `diff --git a/file.txt b/file.txt
@@ -1,2 +1,3 @@
-old one
-old two
+new one
+new two
+new three
`;
		const patchIndex = createGitPatchIndex(patch, 6);
		const body: GitReviewFileBody = {
			path: 'file.txt',
			bodyFingerprint: 'fingerprint:file.txt',
			bodyState: 'loaded',
			category: 'normal',
			isBinary: false,
			isTooLarge: false,
			renderedRowCount: 6,
			patchBytes: patch.length,
			patch,
			patchIndex,
		};
		const splitOptions = {
			...options([file], { 'file.txt': body }),
			diffMode: 'split' as const,
		};

		const source = buildGitVirtualReviewRowSource(splitOptions);
		const unifiedSource = buildGitVirtualReviewRowSource(
			options([file], { 'file.txt': body }),
		);

		expect(source.rowCount).toBe(5);
		expect(source.rowKey(1)).not.toBe(unifiedSource.rowKey(1));
		expect(source.rowAt(2)).toMatchObject({
			kind: 'split-row',
			view: {
				left: { cell: { kind: 'del', text: 'old one' } },
				right: { cell: { kind: 'add', text: 'new one' } },
			},
		});
		expect(source.rowAt(4)).toMatchObject({
			kind: 'split-row',
			view: {
				left: { cell: { kind: 'empty' } },
				right: { cell: { kind: 'add', text: 'new three' } },
			},
		});
	});

	it('estimates ordinary rows at the rendered line height without adding vertical gaps', () => {
		const file = summary('file.txt', 1);
		const source = buildGitVirtualReviewRowSource(
			options([file], { 'file.txt': indexedBody('file.txt', 1) }),
		);

		expect(source.estimateRowHeight(1, 18)).toBe(28);
		expect(source.estimateRowHeight(2, 18)).toBe(18);
		expect(source.estimateRowHeight(2, 24)).toBe(24);
	});
});
