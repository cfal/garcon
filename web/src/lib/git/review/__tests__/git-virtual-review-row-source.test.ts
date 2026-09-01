import { describe, expect, it } from 'vitest';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type { BuildVirtualRowsOptions } from '$lib/git/review/git-virtual-review-document.svelte.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import {
	buildGitVirtualReviewRowSource,
	virtualMeasurementKey,
	type GitVirtualReviewRowSource,
} from '$lib/git/review/git-virtual-review-row-source.js';
import type { GitDiffFileSyntaxResult } from '$lib/git/review/git-diff-syntax.js';

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

function options(
	files: GitReviewFileSummary[],
	bodies: Record<string, GitReviewFileBody>,
): BuildVirtualRowsOptions {
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

function expectEveryRowPresent(source: GitVirtualReviewRowSource): void {
	for (let index = 0; index < source.rowCount; index += 1) {
		expect(source.rowAt(index), `row ${index}`).not.toBeNull();
	}
	expect(source.rowAt(-1)).toBeNull();
	expect(source.rowAt(source.rowCount)).toBeNull();
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
		expect(source.rowAt(0)).not.toBeNull();
		expect(source.rowAt(50_001)).not.toBeNull();
		expect(source.rowAt(source.rowCount - 1)).not.toBeNull();
		expect(source.rowAt(source.rowCount)).toBeNull();
	});

	it('resolves every row in representative indexed sources', () => {
		const pending = summary('pending.txt', 4);
		const limited: GitReviewFileSummary = {
			...summary('binary.dat', 0),
			bodyState: 'binary',
			isBinary: true,
		};
		const loaded = summary('loaded.txt', 2);
		const loadedBody = indexedBody(loaded.path, 2);
		const collectionOptions = options([pending], {});
		collectionOptions.summary.collectionLimit = {
			reason: 'collection-too-many-files',
			message: 'Only a subset of files is shown.',
			visibleFiles: 1,
			totalFilesKnown: 2,
		};

		const splitOptions = options([loaded], { [loaded.path]: loadedBody });
		splitOptions.diffMode = 'split';

		const representativeSources = [
			buildGitVirtualReviewRowSource(options([pending], {})),
			buildGitVirtualReviewRowSource(options([limited], {})),
			buildGitVirtualReviewRowSource(options([loaded], { [loaded.path]: loadedBody })),
			buildGitVirtualReviewRowSource(splitOptions),
			buildGitVirtualReviewRowSource(collectionOptions),
		];

		for (const source of representativeSources) {
			expectEveryRowPresent(source);
		}
	});

	it('builds virtual measurements with the same keys and estimates as indexed access', () => {
		const pending = summary('pending.txt', 4);
		const limited: GitReviewFileSummary = {
			...summary('binary.dat', 0),
			bodyState: 'binary',
			isBinary: true,
		};
		const loaded = summary('loaded.txt', 2);
		const loadedBody = indexedBody(loaded.path, 2);
		const collectionOptions = options([pending], {});
		collectionOptions.summary.collectionLimit = {
			reason: 'collection-too-many-files',
			message: 'Only a subset of files is shown.',
			visibleFiles: 1,
			totalFilesKnown: 2,
		};
		const splitOptions = options([loaded], { [loaded.path]: loadedBody });
		splitOptions.diffMode = 'split';

		for (const source of [
			buildGitVirtualReviewRowSource(options([pending], {})),
			buildGitVirtualReviewRowSource(options([limited], {})),
			buildGitVirtualReviewRowSource(options([loaded], { [loaded.path]: loadedBody })),
			buildGitVirtualReviewRowSource(splitOptions),
			buildGitVirtualReviewRowSource(collectionOptions),
		]) {
			const measurements = source.buildVirtualMeasurements(18);
			expect(measurements.keys).toEqual(
				Array.from({ length: source.rowCount }, (_, index) =>
					virtualMeasurementKey(source.rowKey(index)),
				),
			);
			expect(measurements.estimates).toEqual(
				Array.from({ length: source.rowCount }, (_, index) => source.estimateRowHeight(index, 18)),
			);
		}
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
		const unifiedSource = buildGitVirtualReviewRowSource(options([file], { 'file.txt': body }));

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

	it('reads ordered file paths from clamped row ranges without materializing rows', () => {
		const pending = summary('pending.txt', 4);
		const loaded = summary('loaded.txt', 2);
		const source = buildGitVirtualReviewRowSource(
			options([pending, loaded], { 'loaded.txt': indexedBody('loaded.txt', 2) }),
		);

		expect(source.filePathAt(-1)).toBeNull();
		expect(source.filePathAt(0)).toBe('pending.txt');
		expect(source.filePathAt(1)).toBe('pending.txt');
		expect(source.filePathAt(2)).toBe('loaded.txt');
		expect(source.filePathAt(source.rowCount)).toBeNull();
		expect(source.filePathsInRange(-100, 3)).toEqual(['pending.txt', 'loaded.txt']);
		expect(source.filePathsInRange(1, 2)).toEqual(['pending.txt']);
		expect(source.filePathsInRange(2, 10_000)).toEqual(['loaded.txt']);
		expect(source.filePathsInRange(4, 4)).toEqual([]);
	});

	it('changes measurement revision only for structural or height-affecting inputs', () => {
		const file = summary('file.txt', 2);
		const baseOptions = options([file], {});
		const baseRevision = buildGitVirtualReviewRowSource(baseOptions).measurementRevision;
		const withLoading = {
			...baseOptions,
			loadingBodies: new Set(['file.txt']),
		};
		const withFocus = {
			...baseOptions,
			focusedFilePath: 'file.txt',
		};

		expect(buildGitVirtualReviewRowSource(withLoading).measurementRevision).toBe(baseRevision);
		expect(buildGitVirtualReviewRowSource(withFocus).measurementRevision).toBe(baseRevision);

		const changedDocument = options([file], {});
		changedDocument.summary.documentId = 'document-b';
		expect(buildGitVirtualReviewRowSource(changedDocument).measurementRevision).not.toBe(
			baseRevision,
		);

		const changedMode = { ...baseOptions, diffMode: 'split' as const };
		expect(buildGitVirtualReviewRowSource(changedMode).measurementRevision).not.toBe(baseRevision);

		const changedContext = { ...baseOptions, contextLines: 12 };
		expect(buildGitVirtualReviewRowSource(changedContext).measurementRevision).not.toBe(
			baseRevision,
		);

		const changedEstimate = options([{ ...file, estimatedRows: 20 }], {});
		expect(buildGitVirtualReviewRowSource(changedEstimate).measurementRevision).not.toBe(
			baseRevision,
		);

		const loaded = options([file], { 'file.txt': indexedBody('file.txt', 2) });
		expect(buildGitVirtualReviewRowSource(loaded).measurementRevision).not.toBe(baseRevision);

		const composerClosed = {
			...loaded,
			interaction: {
				kind: 'commentable' as const,
				composerState: {
					open: false,
					focusPending: false,
					filePath: '',
					side: 'after' as const,
					line: 0,
					body: '',
					severity: 'note' as const,
				},
			},
		};
		const composerOpen = {
			...composerClosed,
			interaction: {
				...composerClosed.interaction,
				composerState: {
					...composerClosed.interaction.composerState,
					open: true,
					filePath: 'file.txt',
					line: 1,
				},
			},
		};
		expect(buildGitVirtualReviewRowSource(composerOpen).measurementRevision).not.toBe(
			buildGitVirtualReviewRowSource(composerClosed).measurementRevision,
		);
	});

	it('joins syntax by file and diff line without changing virtualization identity', () => {
		const file = {
			...summary('src/new.py', 4),
			originalPath: 'src/old.ts',
		};
		const patch = `diff --git a/src/old.ts b/src/new.py
@@ -1,2 +1,2 @@
-const oldValue = 1;
+new_value = 2
 shared
`;
		const patchIndex = createGitPatchIndex(patch);
		const body: GitReviewFileBody = {
			path: file.path,
			bodyFingerprint: file.bodyFingerprint,
			bodyState: 'loaded',
			category: 'normal',
			isBinary: false,
			isTooLarge: false,
			renderedRowCount: patchIndex.rowCount,
			patchBytes: patch.length,
			patch,
			patchIndex,
		};
		const syntax: GitDiffFileSyntaxResult = {
			cacheKey: 'syntax',
			filePath: file.path,
			bodyFingerprint: body.bodyFingerprint,
			before: {
				path: 'src/old.ts',
				languageKey: 'typescript',
				lines: new Map([
					[0, [{ text: 'const oldValue = 1;', className: 'cm-code-keyword' }]],
					[2, [{ text: 'shared', className: 'cm-code-name' }]],
				]),
				characterCount: 25,
				segmentCount: 2,
			},
			after: {
				path: 'src/new.py',
				languageKey: 'python',
				lines: new Map([
					[1, [{ text: 'new_value = 2', className: 'cm-code-name' }]],
					[2, [{ text: 'shared', className: 'cm-code-title' }]],
				]),
				characterCount: 20,
				segmentCount: 2,
			},
			characterCount: 45,
			segmentCount: 4,
		};
		const baseOptions = options([file], { [file.path]: body });
		const plain = buildGitVirtualReviewRowSource(baseOptions);
		const highlighted = buildGitVirtualReviewRowSource({
			...baseOptions,
			syntaxResults: { [file.path]: syntax },
		});

		expect(highlighted.rowCount).toBe(plain.rowCount);
		expect(highlighted.measurementRevision).toBe(plain.measurementRevision);
		for (let index = 0; index < plain.rowCount; index += 1) {
			expect(highlighted.rowKey(index)).toBe(plain.rowKey(index));
			expect(highlighted.estimateRowHeight(index, 20)).toBe(plain.estimateRowHeight(index, 20));
			expect(highlighted.rowAt(index)?.id).toBe(plain.rowAt(index)?.id);
		}
		expect(highlighted.rowAt(2)).toMatchObject({
			kind: 'unified-row',
			view: { segments: [{ text: 'const oldValue = 1;', className: 'cm-code-keyword' }] },
		});
		expect(highlighted.rowAt(3)).toMatchObject({
			kind: 'unified-row',
			view: { segments: [{ text: 'new_value = 2', className: 'cm-code-name' }] },
		});
		expect(highlighted.rowAt(4)).toMatchObject({
			kind: 'unified-row',
			view: { segments: [{ text: 'shared', className: 'cm-code-title' }] },
		});

		const split = buildGitVirtualReviewRowSource({
			...baseOptions,
			diffMode: 'split',
			syntaxResults: { [file.path]: syntax },
		});
		expect(split.rowAt(2)).toMatchObject({
			kind: 'split-row',
			view: {
				left: { segments: [{ className: 'cm-code-keyword' }] },
				right: { segments: [{ className: 'cm-code-name' }] },
			},
		});
	});
});
