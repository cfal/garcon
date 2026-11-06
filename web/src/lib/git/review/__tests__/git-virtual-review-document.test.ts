import { describe, expect, it, vi } from 'vitest';
import * as gitApi from '$lib/api/git.js';
import type {
	GitReviewDocumentSummary,
	GitReviewFileBody,
	GitReviewFileSummary,
} from '$lib/api/git.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { buildGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import {
	GitVirtualReviewDocumentController,
	type GitVirtualReviewDocumentDeps,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import { GitDiffSyntaxController } from '$lib/git/review/git-diff-syntax-controller.svelte.js';
import {
	gitDiffSyntaxCacheKey,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxFileInput,
} from '$lib/git/review/git-diff-syntax.js';

function buildVirtualRows(options: Parameters<typeof buildGitVirtualReviewRowSource>[0]) {
	const source = buildGitVirtualReviewRowSource(options);
	return source.rowsInRange(0, source.rowCount);
}

function makeSummary(files: GitReviewFileSummary[], documentId = 'doc'): GitReviewDocumentSummary {
	return {
		document: { executorId: 'local', instanceId: 'test-instance', documentId },
		documentId,
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
	const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+new line\n`;
	return {
		patchDigest: 'a'.repeat(64),
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: 2,
		patchBytes: patch.length,
		patch,
		patchIndex: createGitPatchIndex(patch),
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
		contextLines: 5,
		interaction: {
			kind: 'workbench' as const,
			activeTab: 'unstaged' as const,
			composerState: {
				open: false,
				focusPending: false,
				filePath: '',
				side: 'after' as const,
				line: 0,
				body: '',
				severity: 'note' as const,
			},
			selectedLineKeys: new Set<string>(),
		},
	};
}

function highlightedAttempt(input: GitDiffSyntaxFileInput): GitDiffSyntaxAttempt {
	return {
		status: 'highlighted',
		result: {
			cacheKey: gitDiffSyntaxCacheKey(input.documentId, input.file, input.body),
			filePath: input.file.path,
			bodyFingerprint: input.body.bodyFingerprint,
			before: null,
			after: {
				path: input.file.path,
				languageKey: 'typescript',
				lines: new Map([[0, [{ text: 'new line', className: 'cm-code-keyword' }]]]),
				characterCount: 8,
				segmentCount: 1,
			},
			characterCount: 8,
			segmentCount: 1,
		},
	};
}

function documentDeps(visibleFilePaths: () => string[]): GitVirtualReviewDocumentDeps {
	return {
		targetKey: () => 'target',
		targetProjectPath: () => null,
		activeTab: () => 'unstaged',
		visibleFilePaths,
		selectedFile: () => null,
		selectedLineKeys: () => new Set(),
		composerState: () => ({
			open: false,
			focusPending: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		}),
		surfaceError: vi.fn(),
		markExternallyStale: vi.fn(),
		invalidateSelections: vi.fn(),
	};
}

function addedSyntaxSegments(controller: GitVirtualReviewDocumentController) {
	return controller.rowSource
		.rowsInRange(0, controller.rowSource.rowCount)
		.flatMap((row) =>
			row.kind === 'unified-row' && row.view.row.kind === 'add' ? [row.view.segments] : [],
		)[0];
}

describe('buildVirtualRows', () => {
	it('scopes every virtual row identity to the document', () => {
		const file = makeFile('a.ts');
		const first = buildVirtualRows(baseOptions(makeSummary([file], 'doc-a')));
		const second = buildVirtualRows(baseOptions(makeSummary([file], 'doc-b')));

		expect(first.every((row) => row.id.startsWith('doc-a:'))).toBe(true);
		expect(second.every((row) => row.id.startsWith('doc-b:'))).toBe(true);
		expect(first.map((row) => row.id)).not.toEqual(second.map((row) => row.id));
	});

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
			expect(rows[2].selectableLineKeys()).toHaveLength(1);
			expect(rows[2].actionTarget).toMatchObject({ tab: 'unstaged', mode: 'stage' });
		}
	});

	it('does not synthesize workbench actions for commentable documents', () => {
		const summary = makeSummary([makeFile('a.ts')]);
		const options = baseOptions(summary);
		const rows = buildVirtualRows({
			...options,
			fileBodies: { 'a.ts': makeBody('a.ts') },
			interaction: {
				kind: 'commentable',
				composerState: options.interaction.composerState,
			},
		});
		const content = rows.filter((row) => row.kind === 'unified-row' || row.kind === 'split-row');

		expect(content.every((row) => row.actionTarget === null)).toBe(true);
		expect(content.every((row) => row.selectableLineKeys().length === 0)).toBe(true);
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

	it('describes unsupported conflict bodies instead of mislabeling them as binary', () => {
		const summary = makeSummary([
			makeFile('conflicted.dat', {
				category: 'binary',
				bodyState: 'too-large',
				isBinary: true,
				isTooLarge: true,
				limitReason: 'unsupported-file-kind',
				limitMessage: 'Resolve this conflict before reviewing its comparison diff.',
			}),
		]);

		const rows = buildVirtualRows(baseOptions(summary));

		expect(rows[1]).toMatchObject({
			kind: 'file-limit',
			title: 'Diff unavailable',
			reason: 'unsupported-file-kind',
		});
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

describe('GitVirtualReviewDocumentController syntax', () => {
	it('publishes indexed bodies while the rest of the batch is held and fences reset callbacks', async () => {
		const paths = ['a.ts', 'b.ts'];
		const ready = (requested: string[]) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(requested.map((path) => [path, makeBody(path)])),
			errors: {},
			deferredFiles: [],
		});
		const held = Promise.withResolvers<ReturnType<typeof ready>>();
		let publish!: NonNullable<
			NonNullable<Parameters<typeof gitApi.getGitReviewFileBodies>[5]>['onIndexedBodies']
		>;
		const load = vi
			.spyOn(gitApi, 'getGitReviewFileBodies')
			.mockImplementation((_target, _document, _files, _tab, _context, options) => {
				publish = options!.onIndexedBodies!;
				return held.promise;
			});
		const controller = new GitVirtualReviewDocumentController(documentDeps(() => paths));
		try {
			controller.applySummary(makeSummary(paths.map((path) => makeFile(path))));
			controller.requestBodies('/project', paths);
			publish(ready(['a.ts']), ['a.ts']);
			expect(controller.fileBodies['a.ts']).toBeDefined();
			expect(controller.loadingBodies.has('a.ts')).toBe(false);
			expect(controller.loadingBodies.has('b.ts')).toBe(true);
			controller.reset();
			publish(ready(['b.ts']), ['b.ts']);
			held.resolve(ready(paths));
			await held.promise;
			expect(controller.fileBodies).toEqual({});
		} finally {
			controller.reset();
			load.mockRestore();
		}
	});

	it('batches visible files and continues after an oversized file', async () => {
		const paths = ['large.ts', 'a.ts', 'b.ts'];
		const oversized: GitReviewFileBody = {
			...makeBody('large.ts'),
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			patchIndex: null,
			limitReason: 'file-too-many-bytes',
		};
		const load = vi
			.spyOn(gitApi, 'getGitReviewFileBodies')
			.mockImplementation(async (_target, document, requested) => ({
				status: 'ready',
				documentId: document.documentId,
				files: Object.fromEntries(
					requested.map((path) => [path, path === 'large.ts' ? oversized : makeBody(path)]),
				),
				errors: {},
				deferredFiles: [],
			}));
		const controller = new GitVirtualReviewDocumentController(documentDeps(() => paths));
		try {
			controller.applySummary(makeSummary(paths.map((path) => makeFile(path))));
			controller.requestBodies('/project', paths);
			await vi.waitFor(() => expect(controller.fileBodies['b.ts']?.bodyState).toBe('loaded'));
			expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded');
			expect(controller.fileBodies['large.ts']?.limitReason).toBe('file-too-many-bytes');
			expect(load.mock.calls.map(([, , requested]) => requested)).toEqual([paths]);
			expect(controller.aggregateLimit).toBeNull();
		} finally {
			controller.reset();
			load.mockRestore();
		}
	});

	it.each(['document', 'executor', 'instance', 'return'] as const)(
		'clears and refetches bodies after a %s change',
		async (change) => {
			const first = makeSummary([makeFile('a.ts')]);
			const next = makeSummary(
				[makeFile('a.ts')],
				change === 'document' || change === 'return' ? 'next' : first.documentId,
			);
			if (change === 'executor') next.document = { ...next.document, executorId: 'remote' };
			if (change === 'instance') next.document = { ...next.document, instanceId: 'replacement' };
			const refreshed =
				Promise.withResolvers<Awaited<ReturnType<typeof gitApi.getGitReviewFileBodies>>>();
			const load = vi
				.spyOn(gitApi, 'getGitReviewFileBodies')
				.mockResolvedValueOnce({
					status: 'ready',
					documentId: first.documentId,
					files: { 'a.ts': makeBody('a.ts') },
					errors: {},
					deferredFiles: [],
				})
				.mockReturnValueOnce(refreshed.promise);
			const controller = new GitVirtualReviewDocumentController(documentDeps(() => ['a.ts']));
			try {
				controller.applySummary(first);
				controller.requestBodies('/project', ['a.ts']);
				await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeTruthy());
				if (change === 'return') controller.clearForDisplayChange();
				controller.applySummary(next);
				controller.requestBodies('/project', ['a.ts']);
				expect(controller.fileBodies).toEqual({});
				expect(load).toHaveBeenCalledTimes(2);
				expect(
					controller.rowSource
						.rowsInRange(0, controller.rowSource.rowCount)
						.some((row) => row.kind === 'unified-row'),
				).toBe(false);
				refreshed.resolve({
					status: 'ready',
					documentId: next.documentId,
					files: { 'a.ts': { ...makeBody('a.ts'), patchDigest: 'b'.repeat(64) } },
					errors: {},
					deferredFiles: [],
				});
				await vi.waitFor(() =>
					expect(controller.fileBodies['a.ts']?.patchDigest).toBe('b'.repeat(64)),
				);
				const renewed = controller.rowSource
					.rowsInRange(0, controller.rowSource.rowCount)
					.find((row) => row.kind === 'unified-row');
				expect(renewed?.kind === 'unified-row' && renewed.actionTarget?.proof).toEqual({
					document: next.document,
					bodyFingerprint: 'fingerprint:a.ts',
					patchDigest: 'b'.repeat(64),
				});
			} finally {
				controller.reset();
				load.mockRestore();
			}
		},
	);

	it('highlights the initial visible body without highlighting prefetched bodies', async () => {
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const controller = new GitVirtualReviewDocumentController(
			documentDeps(() => ['a.ts', 'b.ts']),
			syntax,
		);
		const summary = makeSummary([makeFile('a.ts'), makeFile('b.ts')]);
		controller.summary = summary;
		controller.fileBodies = { 'a.ts': makeBody('a.ts'), 'b.ts': makeBody('b.ts') };
		controller.applySummary(summary);

		controller.requestInitialBodies('/project', ['a.ts', 'b.ts']);

		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledOnce());
		expect(highlighter.mock.calls[0]?.[0].file.path).toBe('a.ts');
		expect(syntax.results['a.ts']).toBeDefined();
		expect(syntax.results['b.ts']).toBeUndefined();
	});

	it('does not retain viewport paths as navigation syntax demand', async () => {
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const deps = documentDeps(() => ['a.ts', 'b.ts']);
		deps.targetProjectPath = () => '/project';
		const controller = new GitVirtualReviewDocumentController(deps, syntax);
		const summary = makeSummary([makeFile('a.ts'), makeFile('b.ts')]);
		const bodies = { 'a.ts': makeBody('a.ts'), 'b.ts': makeBody('b.ts') };
		controller.summary = summary;
		controller.fileBodies = bodies;
		controller.applySummary(summary);

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: summary.documentId,
			filePaths: ['a.ts'],
		});
		await vi.waitFor(() => expect(syntax.results['a.ts']).toBeDefined());

		syntax.replaceBodies({ 'b.ts': bodies['b.ts'] });
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: summary.documentId,
			filePaths: ['b.ts'],
		});
		await vi.waitFor(() => expect(syntax.results['b.ts']).toBeDefined());

		syntax.replaceBodies(bodies);

		expect(syntax.results['a.ts']).toBeUndefined();
	});

	it('activates demanded retained bodies and follows workbench cache policy', async () => {
		let visiblePaths = ['a.ts'];
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const controller = new GitVirtualReviewDocumentController(
			documentDeps(() => visiblePaths),
			syntax,
		);
		const summary = makeSummary([makeFile('a.ts')]);
		controller.summary = summary;
		controller.fileBodies = { 'a.ts': makeBody('a.ts') };
		controller.applySummary(summary);

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: summary.documentId,
			filePaths: ['a.ts'],
		});

		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(addedSyntaxSegments(controller)).toEqual([
				{ text: 'new line', className: 'cm-code-keyword' },
			]),
		);

		controller.clearForDisplayChange();
		expect(controller.rowSource.rowCount).toBe(0);
		controller.summary = summary;
		controller.fileBodies = { 'a.ts': makeBody('a.ts') };
		controller.applySummary(summary);
		await vi.waitFor(() => expect(addedSyntaxSegments(controller)).toBeDefined());
		expect(highlighter).toHaveBeenCalledOnce();

		controller.refreshAllData();
		controller.summary = summary;
		controller.fileBodies = { 'a.ts': makeBody('a.ts') };
		controller.applySummary(summary);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: summary.documentId,
			filePaths: ['a.ts'],
		});
		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledTimes(2));

		visiblePaths = [];
		controller.pruneToFilePaths(new Set());
		expect(controller.fileBodies).toEqual({});
		expect(
			controller.rowSource
				.rowsInRange(0, controller.rowSource.rowCount)
				.some((row) => row.kind === 'unified-row' || row.kind === 'split-row'),
		).toBe(false);
	});
});
