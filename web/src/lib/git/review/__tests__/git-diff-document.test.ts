import { describe, expect, it, vi } from 'vitest';
import type { GitReviewFileBody } from '$lib/api/git.js';
import { createGitPatchIndex } from '../git-patch-index.js';
import { gitReviewBodyBytes } from '../git-review-body-budget.js';
import {
	commitFileToReviewFile,
	GitDiffDocumentController,
	type GitDiffDocumentBodyLoader,
} from '../git-diff-document.svelte.js';
import { GitDiffSyntaxController } from '../git-diff-syntax-controller.svelte.js';
import {
	gitDiffSyntaxCacheKey,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxFileInput,
} from '../git-diff-syntax.js';

const limits = {
	maxSummaryFiles: 100,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 10,
	maxLoadedPatchBytes: 1_000,
	maxFileRows: 100,
	maxFilePatchBytes: 1_000,
	maxLineBytes: 1_000,
	maxContextLines: 20,
	bodyConcurrency: 4,
};

function file(path: string) {
	return {
		patchDigest: 'a'.repeat(64),
		path,
		status: 'modified' as const,
		rawStatus: 'M',
		category: 'normal' as const,
		additions: 1,
		deletions: 1,
		estimatedRows: 6,
		bodyState: 'unloaded' as const,
		bodyFingerprint: `fp-${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function body(path: string): GitReviewFileBody {
	const patch = `diff --git a/${path} b/${path}
@@ -0,0 +1,5 @@
+one
+two
+three
+four
+five
`;
	const patchIndex = createGitPatchIndex(patch);
	return {
		path,
		bodyFingerprint: `fp-${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: patchIndex.rowCount,
		patchBytes: 100,
		patch,
		patchIndex,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function bodyResponse(documentId: string, paths: readonly string[]) {
	return {
		status: 'ready' as const,
		documentId,
		files: Object.fromEntries(paths.map((path) => [path, body(path)])),
		errors: {},
		deferredFiles: [],
	};
}

function testCommentSource() {
	return {
		kind: 'commit' as const,
		shortHash: 'abc1234',
		subject: 'Test commit',
		baseLabel: 'parent abc',
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
				lines: new Map([[0, [{ text: 'one', className: 'cm-code-keyword' }]]]),
				characterCount: 3,
				segmentCount: 1,
			},
			characterCount: 3,
			segmentCount: 1,
		},
	};
}

function addedSyntaxSegments(controller: GitDiffDocumentController) {
	return controller.rowSource
		.rowsInRange(0, controller.rowSource.rowCount)
		.flatMap((row) =>
			row.kind === 'unified-row' && row.view.row.kind === 'add' ? [row.view.segments] : [],
		)[0];
}

describe('GitDiffDocumentController', () => {
	it('retries an incrementally published error before the original batch settles', async () => {
		const controller = new GitDiffDocumentController();
		const held = deferred<ReturnType<typeof bodyResponse>>();
		let publish!: Parameters<GitDiffDocumentBodyLoader>[4];
		const loadBodies = vi.fn<GitDiffDocumentBodyLoader>(
			async (_snapshot, paths, _purpose, _signal, partial) => {
				if (paths.length > 1) {
					publish = partial;
					return held.promise;
				}
				return bodyResponse(
					'doc',
					paths.map((file) => file.path),
				);
			},
		);
		try {
			controller.open(
				{
					project: '/project',
					documentId: 'doc',
					files: ['a.ts', 'b.ts'].map(file),
					limits: { ...limits, maxLoadedRows: 100 },
					firstBodyCandidates: [],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					loadBodies,
					onError: vi.fn(),
					commentSource: testCommentSource(),
				},
			);
			controller.handleBodyDemand({
				kind: 'viewport',
				documentId: 'doc',
				filePaths: ['a.ts', 'b.ts'],
			});
			const failedBody: GitReviewFileBody = {
				...body('a.ts'),
				bodyState: 'error',
				patch: null,
				patchIndex: null,
				renderedRowCount: 0,
				patchBytes: 0,
				error: 'Transient diff failure',
			};
			publish({ ...bodyResponse('doc', []), files: { 'a.ts': failedBody } }, ['a.ts']);
			expect(controller.fileBodies['a.ts']?.bodyState).toBe('error');
			controller.focusFile('a.ts');
			expect(controller.loadingBodies.has('a.ts')).toBe(true);
			held.resolve(bodyResponse('doc', ['a.ts', 'b.ts']));
			await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
			expect(loadBodies.mock.calls.map(([, paths]) => paths.map((file) => file.path))).toEqual([
				['a.ts', 'b.ts'],
				['a.ts'],
			]);
		} finally {
			controller.clear();
			held.resolve(bodyResponse('doc', ['a.ts', 'b.ts']));
		}
	});

	it.each(['viewport', 'navigation'] as const)(
		'recovers %s demand after an incremental prefetch exceeds its budget',
		async (kind) => {
			const controller = new GitDiffDocumentController();
			const held = deferred<ReturnType<typeof bodyResponse>>();
			let publish!: Parameters<GitDiffDocumentBodyLoader>[4];
			let prefetchSignal!: AbortSignal;
			const loadBodies = vi.fn<GitDiffDocumentBodyLoader>(
				async (_snapshot, paths, purpose, signal, partial) => {
					if (purpose === 'prefetch') {
						publish = partial;
						prefetchSignal = signal;
						return held.promise;
					}
					return bodyResponse(
						'doc',
						paths.map((file) => file.path),
					);
				},
			);
			try {
				controller.open(
					{
						project: '/project',
						documentId: 'doc',
						files: ['initial.ts', 'blocked.ts', 'wanted.ts'].map(file),
						limits: { ...limits, maxLoadedRows: 6 },
						firstBodyCandidates: ['initial.ts', 'blocked.ts', 'wanted.ts'],
					},
					{
						contextLines: 5,
						diffMode: 'unified',
						loadBodies,
						onError: vi.fn(),
						commentSource: testCommentSource(),
					},
				);
				await vi.waitFor(() => expect(controller.fileBodies['initial.ts']).toBeDefined());
				controller.handleBodyDemand({ kind, documentId: 'doc', filePaths: ['wanted.ts'] });
				publish(bodyResponse('doc', ['blocked.ts']), ['blocked.ts']);
				expect(prefetchSignal.aborted).toBe(true);
				expect(controller.loadingBodies.has('blocked.ts')).toBe(false);
				expect(controller.loadingBodies.has('wanted.ts')).toBe(true);
				held.resolve(bodyResponse('doc', ['blocked.ts', 'wanted.ts']));
				await vi.waitFor(() =>
					expect(controller.fileBodies['wanted.ts']?.bodyState).toBe('loaded'),
				);
				expect(controller.fileBodies['blocked.ts']).toBeUndefined();
				expect(controller.aggregateLimit).toBeNull();
				expect(loadBodies.mock.calls.at(-1)?.[2]).toBe('visible');
			} finally {
				controller.clear();
			}
		},
	);

	it('publishes a newly selected prefetched body with the visible budget', async () => {
		const controller = new GitDiffDocumentController();
		const held = deferred<ReturnType<typeof bodyResponse>>();
		let publish!: Parameters<GitDiffDocumentBodyLoader>[4];
		try {
			controller.open(
				{
					project: '/project',
					documentId: 'doc',
					files: ['initial.ts', 'wanted.ts'].map(file),
					limits: { ...limits, maxLoadedRows: 6 },
					firstBodyCandidates: ['initial.ts', 'wanted.ts'],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					onError: vi.fn(),
					commentSource: testCommentSource(),
					loadBodies: async (_snapshot, paths, purpose, _signal, partial) => {
						if (purpose === 'visible')
							return bodyResponse(
								'doc',
								paths.map((file) => file.path),
							);
						publish = partial;
						return held.promise;
					},
				},
			);
			await vi.waitFor(() => expect(controller.fileBodies['initial.ts']).toBeDefined());
			controller.focusFile('wanted.ts');
			publish(bodyResponse('doc', ['wanted.ts']), ['wanted.ts']);
			held.resolve(bodyResponse('doc', ['wanted.ts']));
			await vi.waitFor(() => expect(controller.fileBodies['wanted.ts']?.bodyState).toBe('loaded'));
			expect(controller.aggregateLimit).toBeNull();
		} finally {
			controller.clear();
		}
	});

	it('cancels bootstrap neighbors when a same-document refresh settles while hidden', async () => {
		const controller = new GitDiffDocumentController();
		const held = deferred<ReturnType<typeof bodyResponse>>();
		const signals: AbortSignal[] = [];
		const snapshot = {
			project: '/project',
			documentId: 'doc',
			files: ['a.ts', 'b.ts'].map(file),
			limits,
			firstBodyCandidates: ['a.ts', 'b.ts'],
		};
		const loadBodies: GitDiffDocumentBodyLoader = async (_snapshot, paths, purpose, signal) => {
			if (purpose === 'visible')
				return bodyResponse(
					'doc',
					paths.map((file) => file.path),
				);
			signals.push(signal);
			return held.promise;
		};
		const options = {
			contextLines: 5,
			diffMode: 'unified' as const,
			loadBodies,
			onError: vi.fn(),
			commentSource: testCommentSource(),
		};
		try {
			controller.open(snapshot, options);
			await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeDefined());
			controller.handleBodyDemand({ kind: 'viewport', documentId: 'doc', filePaths: [] });
			controller.open(snapshot, options);
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
		} finally {
			controller.clear();
			held.resolve(bodyResponse('doc', ['b.ts']));
		}
	});

	it('preserves both lanes during incremental publication and fences a replaced document', async () => {
		const controller = new GitDiffDocumentController();
		const held = deferred<ReturnType<typeof bodyResponse>>();
		let publish!: (result: ReturnType<typeof bodyResponse>, paths: string[]) => void;
		try {
			controller.open(
				{
					project: '/project',
					documentId: 'doc',
					files: ['a.ts', 'b.ts', 'c.ts'].map(file),
					limits: { ...limits, maxLoadedRows: 100 },
					firstBodyCandidates: ['a.ts', 'b.ts', 'c.ts'],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					commentSource: testCommentSource(),
					onError: vi.fn(),
					loadBodies: async (_snapshot, paths, purpose, _signal, partial) => {
						if (purpose === 'visible')
							return bodyResponse(
								'doc',
								paths.map((file) => file.path),
							);
						publish = partial;
						return held.promise;
					},
				},
			);
			publish(bodyResponse('doc', ['b.ts']), ['b.ts']);
			await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeDefined());
			expect(controller.fileBodies['b.ts']).toBeDefined();
			expect(controller.loadingBodies.has('b.ts')).toBe(false);
			expect(controller.loadingBodies.has('c.ts')).toBe(true);
			controller.clear();
			publish(bodyResponse('doc', ['c.ts']), ['c.ts']);
			held.resolve(bodyResponse('doc', ['b.ts', 'c.ts']));
			await held.promise;
			expect(controller.fileBodies).toEqual({});
		} finally {
			controller.clear();
		}
	});

	it('keeps the selected file singleton and batches neighbors after an oversized file', async () => {
		const controller = new GitDiffDocumentController();
		const paths = ['large.ts', 'a.ts', 'b.ts'];
		const oversized: GitReviewFileBody = {
			...body('large.ts'),
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			patchIndex: null,
			limitReason: 'file-too-many-bytes',
		};
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) => ({
			...bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
			files: Object.fromEntries(
				requested.map(({ path }) => [path, path === 'large.ts' ? oversized : body(path)]),
			),
		}));
		try {
			controller.open(
				{
					project: '/project',
					documentId: 'doc',
					files: paths.map(file),
					limits: { ...limits, maxLoadedRows: 20 },
					firstBodyCandidates: paths,
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					loadBodies,
					onError: vi.fn(),
					commentSource: testCommentSource(),
				},
			);
			await vi.waitFor(() => expect(controller.fileBodies['b.ts']?.bodyState).toBe('loaded'));
			expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded');
			expect(controller.fileBodies['large.ts']?.limitReason).toBe('file-too-many-bytes');
			expect(
				loadBodies.mock.calls.map(([, requested]) => requested.map(({ path }) => path)),
			).toEqual([['large.ts'], ['a.ts', 'b.ts']]);
			expect(controller.aggregateLimit).toBeNull();
		} finally {
			controller.clear();
		}
	});

	it('highlights the initial visible body without waiting for viewport demand', async () => {
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const controller = new GitDiffDocumentController(syntax);
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) =>
			bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
		);

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(addedSyntaxSegments(controller)).toBeDefined());
	});

	it('does not retain viewport paths as navigation syntax demand', async () => {
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const controller = new GitDiffDocumentController(syntax);
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) =>
			bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
		);
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts')],
				limits: { ...limits, maxLoadedRows: 20 },
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['a.ts'],
		});
		await vi.waitFor(() => expect(syntax.results['a.ts']).toBeDefined());

		syntax.replaceBodies({});
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['b.ts'],
		});
		await vi.waitFor(() => expect(syntax.results['b.ts']).toBeDefined());

		expect(syntax.results['a.ts']).toBeUndefined();
	});

	it('replays early demand into syntax and honors document cache clearing', async () => {
		const highlighter = vi.fn(async (input: GitDiffSyntaxFileInput) => highlightedAttempt(input));
		const syntax = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter: async () => ({ highlightGitDiffFile: highlighter }),
		});
		const controller = new GitDiffDocumentController(syntax);
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) =>
			bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
		);
		const snapshot = {
			project: '/project',
			documentId: 'doc',
			files: [file('a.ts')],
			limits,
			firstBodyCandidates: [],
		};
		const options = {
			contextLines: 5,
			diffMode: 'unified' as const,
			loadBodies,
			onError: vi.fn(),
			commentSource: testCommentSource(),
		};
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: snapshot.documentId,
			filePaths: ['a.ts'],
		});

		controller.open(snapshot, options);

		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledOnce());
		await vi.waitFor(() =>
			expect(addedSyntaxSegments(controller)).toEqual([
				{ text: 'one', className: 'cm-code-keyword' },
			]),
		);

		controller.clear({ preserveCache: true });
		expect(controller.rowSource.rowCount).toBe(0);
		controller.open(snapshot, options);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: snapshot.documentId,
			filePaths: ['a.ts'],
		});
		await vi.waitFor(() => expect(addedSyntaxSegments(controller)).toBeDefined());
		expect(highlighter).toHaveBeenCalledOnce();

		controller.clear();
		controller.open(snapshot, options);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: snapshot.documentId,
			filePaths: ['a.ts'],
		});
		await vi.waitFor(() => expect(highlighter).toHaveBeenCalledTimes(2));
	});

	it('reconciles retained viewport demand when the matching document becomes ready', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) =>
			bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
		);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['visible.ts'],
		});

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('visible.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledOnce());
		expect(loadBodies.mock.calls[0]?.[1]).toEqual([{ path: 'visible.ts' }]);
		expect(controller.getDemandDebugSnapshot()).toMatchObject({
			documentId: 'doc',
			demandedPaths: ['visible.ts'],
			readinessGeneration: 1,
		});
	});

	it('rejects stale demand and deduplicates repeated matching demand', async () => {
		const controller = new GitDiffDocumentController();
		const pending = deferred<ReturnType<typeof bodyResponse>>();
		const loadBodies = vi.fn(() => pending.promise);
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('visible.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'old-doc',
			filePaths: ['visible.ts'],
		});
		expect(loadBodies).not.toHaveBeenCalled();

		const demand = {
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['visible.ts'],
		} as const;
		controller.handleBodyDemand(demand);
		controller.handleBodyDemand({ ...demand, filePaths: [...demand.filePaths] });

		expect(loadBodies).toHaveBeenCalledOnce();
		expect(controller.getDemandDebugSnapshot().schedulerPendingByPath).toEqual({
			'visible.ts': true,
		});
		pending.resolve(bodyResponse('doc', ['visible.ts']));
	});

	it('keeps navigation demand separate from retained viewport demand', () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(() => new Promise<ReturnType<typeof bodyResponse>>(() => {}));
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('viewport.ts'), file('target.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['viewport.ts'],
		});

		controller.handleBodyDemand({
			kind: 'navigation',
			documentId: 'doc',
			filePaths: ['target.ts'],
		});

		expect(controller.getDemandDebugSnapshot().demandedPaths).toEqual(['viewport.ts']);
		expect(controller.getDemandDebugSnapshot().loadingPaths).toEqual(['viewport.ts', 'target.ts']);
	});

	it('protects an active prefetch response when its file becomes visible', async () => {
		const controller = new GitDiffDocumentController();
		const visible = deferred<ReturnType<typeof bodyResponse>>();
		const prefetch = deferred<ReturnType<typeof bodyResponse>>();
		const constrainedLimits = { ...limits, maxLoadedRows: 6 };
		const loadBodies = vi
			.fn()
			.mockReturnValueOnce(visible.promise)
			.mockReturnValueOnce(prefetch.promise);
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('initial.ts'), file('visible.ts')],
				limits: constrainedLimits,
				firstBodyCandidates: ['initial.ts', 'visible.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(2));

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['visible.ts'],
		});
		prefetch.resolve(bodyResponse('doc', ['visible.ts']));
		await vi.waitFor(() => expect(controller.fileBodies['visible.ts']?.bodyState).toBe('loaded'));

		visible.resolve(bodyResponse('doc', ['initial.ts']));
		await vi.waitFor(() => expect(controller.aggregateLimit).not.toBeNull());
		expect(controller.fileBodies['visible.ts']?.bodyState).toBe('loaded');
		expect(controller.fileBodies['initial.ts']?.bodyState).toBe('too-large');
	});

	it('applies a demanded body after stopping an over-budget prefetch response', async () => {
		const controller = new GitDiffDocumentController();
		const prefetch = deferred<ReturnType<typeof bodyResponse>>();
		const constrainedLimits = { ...limits, maxLoadedRows: 6 };
		const loadBodies = vi.fn(
			(_snapshot: unknown, requested: Array<{ path: string }>, purpose: string) =>
				purpose === 'prefetch'
					? prefetch.promise
					: Promise.resolve(
							bodyResponse(
								'doc',
								requested.map(({ path }) => path),
							),
						),
		);
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('initial.ts'), file('blocked.ts'), file('visible.ts')],
				limits: constrainedLimits,
				firstBodyCandidates: ['initial.ts', 'blocked.ts', 'visible.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		await vi.waitFor(() => expect(controller.fileBodies['initial.ts']?.bodyState).toBe('loaded'));

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['visible.ts'],
		});
		prefetch.resolve(bodyResponse('doc', ['blocked.ts', 'visible.ts']));

		await vi.waitFor(() => expect(controller.fileBodies['visible.ts']?.bodyState).toBe('loaded'));
		expect(controller.fileBodies['initial.ts']).toBeUndefined();
		expect(controller.fileBodies['blocked.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();
	});

	it('loads adjacent visible bodies without imposing a retained-byte terminal limit', async () => {
		const controller = new GitDiffDocumentController();
		const large = body('large.ts');
		const small = body('small.ts');
		const patchLimit = large.patchBytes + small.patchBytes;
		expect(gitReviewBodyBytes(large) + gitReviewBodyBytes(small)).toBeGreaterThan(patchLimit);
		try {
			controller.open(
				{
					project: '/project',
					documentId: 'doc',
					files: [file(large.path), file(small.path)],
					limits: { ...limits, maxLoadedRows: 100, maxLoadedPatchBytes: patchLimit },
					firstBodyCandidates: [],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					loadBodies: async (_snapshot, requested) =>
						bodyResponse(
							'doc',
							requested.map(({ path }) => path),
						),
					onError: vi.fn(),
					commentSource: testCommentSource(),
				},
			);
			controller.handleBodyDemand({
				kind: 'viewport',
				documentId: 'doc',
				filePaths: [large.path, small.path],
			});
			await vi.waitFor(() => {
				expect(controller.fileBodies[large.path]?.bodyState).toBe('loaded');
				expect(controller.fileBodies[small.path]?.bodyState).toBe('loaded');
			});
			expect(controller.aggregateLimit).toBeNull();
		} finally {
			controller.clear();
		}
	});

	it('recycles a previously visible body after viewport demand moves away', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot: unknown, requested: Array<{ path: string }>) =>
			bodyResponse(
				'doc',
				requested.map(({ path }) => path),
			),
		);
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('old-visible.ts'), file('new-visible.ts')],
				limits: { ...limits, maxLoadedRows: 6 },
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['old-visible.ts'],
		});
		await vi.waitFor(() =>
			expect(controller.fileBodies['old-visible.ts']?.bodyState).toBe('loaded'),
		);

		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: 'doc',
			filePaths: ['new-visible.ts'],
		});

		await vi.waitFor(() =>
			expect(controller.fileBodies['new-visible.ts']?.bodyState).toBe('loaded'),
		);
		expect(controller.fileBodies['old-visible.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();
	});

	it('starts a selected lazy body after the initial body batch settles', async () => {
		const controller = new GitDiffDocumentController();
		const initial = deferred<ReturnType<typeof bodyResponse>>();
		const loadBodies = vi.fn(async (_snapshot, files: Array<{ path: string }>) => {
			if (loadBodies.mock.calls.length === 1) return initial.promise;
			return bodyResponse(
				'doc',
				files.map(({ path }) => path),
			);
		});
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('initial.ts'), file('selected.ts')],
				limits,
				firstBodyCandidates: ['initial.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		controller.focusFile('selected.ts');
		expect(loadBodies).toHaveBeenCalledOnce();
		initial.resolve(bodyResponse('doc', ['initial.ts']));

		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(2));
		expect(loadBodies.mock.calls[1]?.[1]).toEqual([{ path: 'selected.ts' }]);
	});

	it('loads a file at the summary limit without rescanning the summary list', async () => {
		const controller = new GitDiffDocumentController();
		const files = Array.from({ length: 10_000 }, (_, index) => file(`file-${index}.ts`));
		const loadBodies = vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(requested.map(({ path }) => [path, body(path)])),
			errors: {},
			deferredFiles: [],
		}));
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files,
				limits: { ...limits, maxSummaryFiles: files.length },
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		controller.focusFile('file-9999.ts');

		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledOnce());
		expect(loadBodies.mock.calls[0]?.[1]).toEqual([{ path: 'file-9999.ts' }]);
	});

	it('preserves an in-progress draft when the same target is activated again', () => {
		const controller = new GitDiffDocumentController();
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(),
				onError: vi.fn(),
				commentSource: {
					kind: 'commit',
					shortHash: 'abcdef1',
					subject: 'Test commit',
					baseLabel: 'parent 1234567',
				},
			},
		);
		controller.openCommentComposer('a.ts', 'after', 12);
		controller.setCommentBody('Keep this draft');
		controller.setCommentSeverity('warning');

		controller.openCommentComposer('a.ts', 'after', 12);

		expect(controller.commentComposer.body).toBe('Keep this draft');
		expect(controller.commentComposer.severity).toBe('warning');
	});

	it('consumes a comment composer focus request only once', () => {
		const controller = new GitDiffDocumentController();
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(),
				onError: vi.fn(),
				commentSource: {
					kind: 'commit',
					shortHash: 'abcdef1',
					subject: 'Test commit',
					baseLabel: 'parent 1234567',
				},
			},
		);

		controller.openCommentComposer('a.ts', 'after', 12);
		expect(controller.commentComposer.focusPending).toBe(true);

		controller.markCommentComposerFocused();
		expect(controller.commentComposer.focusPending).toBe(false);
	});

	it('does not rebuild virtual rows while editing a comment body', () => {
		const controller = new GitDiffDocumentController();
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(),
				onError: vi.fn(),
				commentSource: {
					kind: 'commit',
					shortHash: 'abcdef1',
					subject: 'Test commit',
					baseLabel: 'parent 1234567',
				},
			},
		);
		controller.openCommentComposer('a.ts', 'after', 12);
		const patch = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +12 @@\n+new line\n';
		controller.fileBodies = {
			'a.ts': {
				...body('a.ts'),
				renderedRowCount: 2,
				patchBytes: patch.length,
				patch,
				patchIndex: createGitPatchIndex(patch),
			},
		};
		const sourceBeforeEdit = controller.rowSource;

		controller.setCommentBody('No full document rebuild');

		expect(controller.rowSource).toBe(sourceBeforeEdit);
		expect(controller.commentComposer.body).toBe('No full document rebuild');
	});

	it('recycles speculative loading before enforcing the aggregate limit', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(requested.map(({ path }) => [path, body(path)])),
			errors: {},
			deferredFiles: [],
		}));

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts')],
				limits,
				firstBodyCandidates: ['a.ts', 'b.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		expect(controller.fileBodies['b.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();

		controller.focusFile('b.ts');

		await vi.waitFor(() => expect(controller.fileBodies['b.ts']?.bodyState).toBe('loaded'));
		expect(controller.fileBodies['a.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();
	});

	it('continues server-deferred bodies without imposing a collection limit', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn<GitDiffDocumentBodyLoader>(async (_snapshot, requested) => {
			const paths = requested.map(({ path }) => path);
			if (paths.length === 1) return bodyResponse('doc', paths);
			return { ...bodyResponse('doc', paths.slice(0, 1)), deferredFiles: paths.slice(1) };
		});

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts'), file('c.ts')],
				limits: {
					...limits,
					maxLoadedRows: 100,
					maxLoadedPatchBytes: 3 * gitReviewBodyBytes(body('a.ts')),
				},
				firstBodyCandidates: ['a.ts', 'b.ts', 'c.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		try {
			await vi.waitFor(() => expect(controller.fileBodies['c.ts']?.bodyState).toBe('loaded'));
			expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded');
			expect(controller.fileBodies['b.ts']?.bodyState).toBe('loaded');
			expect(controller.aggregateLimit).toBeNull();
			expect(loadBodies.mock.calls.map(([, paths]) => paths.map(({ path }) => path))).toEqual([
				['a.ts'],
				['b.ts', 'c.ts'],
				['c.ts'],
			]);
		} finally {
			controller.clear();
		}
	});

	it('evicts a speculative body when the selected body arrives later', async () => {
		const controller = new GitDiffDocumentController();
		const visible = deferred<ReturnType<typeof bodyResponse>>();
		const loadBodies = vi.fn(
			async (_snapshot, requested: Array<{ path: string }>, purpose: string) => {
				if (purpose === 'visible') return visible.promise;
				return bodyResponse(
					'doc',
					requested.map(({ path }) => path),
				);
			},
		);

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('selected.ts'), file('prefetch.ts')],
				limits,
				firstBodyCandidates: ['selected.ts', 'prefetch.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['prefetch.ts']?.bodyState).toBe('loaded'));
		visible.resolve(bodyResponse('doc', ['selected.ts']));

		await vi.waitFor(() => expect(controller.fileBodies['selected.ts']?.bodyState).toBe('loaded'));
		expect(controller.fileBodies['prefetch.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();
	});

	it('renders explicit limits for files left unloaded after the aggregate budget is reached', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(
				requested.map(({ path }) => [
					path,
					path === 'b.ts' ? { ...body(path), renderedRowCount: 12 } : body(path),
				]),
			),
			errors: {},
			deferredFiles: [],
		}));

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts'), file('c.ts')],
				limits: { ...limits, maxBodyBatchFiles: 2 },
				collectionLimit: {
					reason: 'collection-too-many-files',
					message: 'Showing 3 of 30,000 changed files.',
					visibleFiles: 3,
					totalFilesKnown: 30_000,
				},
				firstBodyCandidates: ['a.ts', 'b.ts', 'c.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		controller.focusFile('b.ts');
		await vi.waitFor(() =>
			expect(controller.aggregateLimit?.reason).toBe('collection-too-many-rows'),
		);
		expect(controller.rowSource.rowsInRange(0, controller.rowSource.rowCount)).toContainEqual(
			expect.objectContaining({
				kind: 'file-limit',
				filePath: 'c.ts',
				reason: 'collection-too-many-rows',
			}),
		);

		controller.setFileFilter('c.ts');

		expect(controller.rowSource.rowsInRange(0, controller.rowSource.rowCount)).toContainEqual(
			expect.objectContaining({
				kind: 'collection-limit',
				message: 'Showing 3 of 30,000 changed files.',
			}),
		);
	});

	it('preserves per-file body errors instead of reporting a fingerprint change', async () => {
		const controller = new GitDiffDocumentController();
		const failedBody: GitReviewFileBody = {
			...body('a.ts'),
			bodyFingerprint: 'comparison-body-error',
			bodyState: 'error',
			renderedRowCount: 0,
			patchBytes: 0,
			error: 'Unable to read this path.',
		};

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(async () => ({
					status: 'ready' as const,
					documentId: 'doc',
					files: { 'a.ts': failedBody },
					errors: { 'a.ts': 'Unable to read this path.' },
					deferredFiles: [],
				})),
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('error'));
		expect(controller.fileBodies['a.ts']?.error).toBe('Unable to read this path.');
	});

	it('retries a transient body error when the file is focused again', async () => {
		const controller = new GitDiffDocumentController();
		const failedBody: GitReviewFileBody = {
			...body('a.ts'),
			bodyState: 'error',
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			patchIndex: null,
			error: 'Transient diff failure',
		};
		const loadBodies = vi
			.fn()
			.mockResolvedValueOnce({
				status: 'ready',
				documentId: 'doc',
				files: { 'a.ts': failedBody },
				errors: { 'a.ts': 'Transient diff failure' },
				deferredFiles: [],
			})
			.mockResolvedValueOnce({
				status: 'ready',
				documentId: 'doc',
				files: { 'a.ts': body('a.ts') },
				errors: {},
				deferredFiles: [],
			});

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('error'));

		controller.focusFile('a.ts');

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		expect(loadBodies).toHaveBeenCalledTimes(2);
	});

	it('rejects oversized cache entries without evicting smaller bodies', async () => {
		const controller = new GitDiffDocumentController();
		const byteLimit = 900;
		const patch = `diff --git a/large.ts b/large.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(500)}\n`;
		const patchIndex = createGitPatchIndex(patch);
		const large = {
			...body('large.ts'),
			patch,
			patchIndex,
			patchBytes: patch.length,
			renderedRowCount: patchIndex.rowCount,
		};
		expect(gitReviewBodyBytes(large)).toBeGreaterThan(byteLimit);
		expect(gitReviewBodyBytes(body('a.ts')) + gitReviewBodyBytes(body('b.ts'))).toBeLessThan(
			byteLimit,
		);
		const loadBodies = vi.fn<GitDiffDocumentBodyLoader>(async (snapshot, files) => ({
			status: 'ready',
			documentId: snapshot.documentId,
			files: Object.fromEntries(
				files.map(({ path }) => [path, path === large.path ? large : body(path)]),
			),
			errors: {},
			deferredFiles: [],
		}));
		try {
			for (const path of ['a.ts', 'b.ts', large.path, 'a.ts', 'b.ts', large.path]) {
				controller.open(
					{
						project: '/project',
						documentId: path,
						files: [file(path)],
						limits: { ...limits, maxLoadedPatchBytes: byteLimit },
						firstBodyCandidates: [path],
					},
					{
						contextLines: 5,
						diffMode: 'unified',
						loadBodies,
						onError: vi.fn(),
						commentSource: testCommentSource(),
					},
				);
				await vi.waitFor(() => expect(controller.fileBodies[path]?.bodyState).toBe('loaded'));
				expect(controller.aggregateLimit).toBeNull();
			}
			expect(loadBodies.mock.calls.map(([, files]) => files.map(({ path }) => path))).toEqual([
				['a.ts'],
				['b.ts'],
				[large.path],
				[large.path],
			]);
		} finally {
			controller.clear();
		}
	});

	it('bounds cached bodies across document changes', async () => {
		const controller = new GitDiffDocumentController();
		const boundedLimits = { ...limits, maxLoadedPatchBytes: gitReviewBodyBytes(body('a.ts')) };
		const loadBodies = vi.fn(
			async (snapshot: { documentId: string }, files: Array<{ path: string }>) => ({
				status: 'ready' as const,
				documentId: snapshot.documentId,
				files: Object.fromEntries(files.map(({ path }) => [path, body(path)])),
				errors: {},
				deferredFiles: [],
			}),
		);
		const open = (documentId: string, path: string) =>
			controller.open(
				{
					project: '/project',
					documentId,
					files: [file(path)],
					limits: boundedLimits,
					firstBodyCandidates: [path],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					loadBodies,
					onError: vi.fn(),
					commentSource: testCommentSource(),
				},
			);

		open('doc-a', 'a.ts');
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		open('doc-b', 'b.ts');
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(controller.fileBodies['b.ts']?.bodyState).toBe('loaded'));
		open('doc-a', 'a.ts');
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(3));
	});

	it('bounds zero-byte limited bodies by cache entry count', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(
			async (snapshot: { documentId: string }, files: Array<{ path: string }>) => ({
				status: 'ready' as const,
				documentId: snapshot.documentId,
				files: Object.fromEntries(
					files.map(({ path }) => [
						path,
						{
							...body(path),
							bodyState: 'binary' as const,
							category: 'binary' as const,
							isBinary: true,
							renderedRowCount: 0,
							patchBytes: 0,
						},
					]),
				),
				errors: {},
				deferredFiles: [],
			}),
		);
		const open = (index: number) => {
			const path = `binary-${index}.dat`;
			controller.open(
				{
					project: '/project',
					documentId: `doc-${index}`,
					files: [file(path)],
					limits,
					firstBodyCandidates: [path],
				},
				{
					contextLines: 5,
					diffMode: 'unified',
					loadBodies,
					onError: vi.fn(),
					commentSource: testCommentSource(),
				},
			);
		};

		for (let index = 0; index < 129; index += 1) {
			open(index);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(loadBodies).toHaveBeenCalledTimes(index + 1);
		}
		open(0);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loadBodies).toHaveBeenCalledTimes(130);
	});

	it('stops lazy body requests after a Working Tree response becomes stale', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async () => ({
			status: 'stale' as const,
			documentId: 'doc',
			changedPaths: ['a.ts'],
			message: 'The Working Tree changed.',
		}));
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies,
				onError: vi.fn(),
				commentSource: testCommentSource(),
			},
		);
		await vi.waitFor(() => expect(controller.isStale).toBe(true));

		controller.focusFile('b.ts');

		expect(loadBodies).toHaveBeenCalledTimes(1);
		expect(controller.rowSource.rowsInRange(0, controller.rowSource.rowCount)).toContainEqual(
			expect.objectContaining({
				kind: 'file-limit',
				filePath: 'b.ts',
				reason: 'stale-document',
				title: 'Refresh required',
			}),
		);
	});

	it('preserves comment text and exposes a copy block when Chat is unavailable', async () => {
		const controller = new GitDiffDocumentController();
		const patch = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+new line\n';
		const loadedBody: GitReviewFileBody = {
			...body('a.ts'),
			renderedRowCount: 2,
			patchBytes: patch.length,
			patch,
			patchIndex: createGitPatchIndex(patch),
		};
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(async () => ({
					status: 'ready' as const,
					documentId: 'doc',
					files: { 'a.ts': loadedBody },
					errors: {},
					deferredFiles: [],
				})),
				onError: vi.fn(),
				commentSource: {
					kind: 'commit',
					shortHash: 'abcdef1',
					subject: 'Test commit',
					baseLabel: 'parent 1234567',
				},
			},
		);
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeTruthy());
		controller.openCommentComposer('a.ts', 'after', 1);
		controller.setCommentBody('Keep this comment');

		const result = controller.submitComment(undefined);

		expect(result).toBe('unavailable');
		expect(controller.commentComposer.body).toBe('Keep this comment');
		expect(controller.commentCopyText).toContain('Keep this comment');
		expect(controller.commentCopyText).toContain('+new line');
	});

	it('does not report a Chat error for an empty comment submission', () => {
		const controller = new GitDiffDocumentController();
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts')],
				limits,
				firstBodyCandidates: [],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(),
				onError: vi.fn(),
				commentSource: {
					kind: 'commit',
					shortHash: 'abcdef1',
					subject: 'Test commit',
					baseLabel: 'parent 1234567',
				},
			},
		);
		controller.openCommentComposer('a.ts', 'after', 1);

		expect(controller.submitComment(vi.fn())).toBe('unavailable');
		expect(controller.commentError).toBeNull();
	});

	it('reuses loaded bodies when an unchanged snapshot is refreshed', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async () => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: { 'a.ts': body('a.ts') },
			errors: {},
			deferredFiles: [],
		}));
		const documentSnapshot = {
			project: '/project',
			documentId: 'doc',
			files: [file('a.ts')],
			limits,
			firstBodyCandidates: ['a.ts'],
		};
		const options = {
			contextLines: 5,
			diffMode: 'unified' as const,
			loadBodies,
			onError: vi.fn(),
			commentSource: testCommentSource(),
		};
		controller.open(documentSnapshot, options);
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeTruthy());

		controller.open(documentSnapshot, options);

		expect(controller.fileBodies['a.ts']).toEqual(body('a.ts'));
		expect(loadBodies).toHaveBeenCalledOnce();

		const loadedBodies = controller.fileBodies;
		controller.handleBodyDemand({
			kind: 'viewport',
			documentId: documentSnapshot.documentId,
			filePaths: ['a.ts'],
		});

		expect(controller.fileBodies).toBe(loadedBodies);
	});

	it('preserves unknown stats and type changes in virtual file summaries', () => {
		const summary = commitFileToReviewFile({
			...file('a.ts'),
			status: 'type-changed',
			rawStatus: 'T',
			statsKnown: false,
		});

		expect(summary.indexStatus).toBe('T');
		expect(summary.statsKnown).toBe(false);
	});
});
