import { describe, expect, it, vi } from 'vitest';
import type { GitReviewFileBody } from '$lib/api/git.js';
import { createGitPatchIndex } from '../git-patch-index.js';
import { commitFileToReviewFile, GitDiffDocumentController } from '../git-diff-document.svelte.js';

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

describe('GitDiffDocumentController', () => {
	it('starts a selected lazy body after the initial body batch settles', async () => {
		const controller = new GitDiffDocumentController();
		let resolveInitial!: (value: {
			status: 'ready';
			documentId: string;
			files: Record<string, GitReviewFileBody>;
			errors: Record<string, string>;
		}) => void;
		const initial = new Promise<{
			status: 'ready';
			documentId: string;
			files: Record<string, GitReviewFileBody>;
			errors: Record<string, string>;
		}>((resolve) => {
			resolveInitial = resolve;
		});
		const loadBodies = vi.fn(async (_snapshot, files: Array<{ path: string }>) => {
			if (loadBodies.mock.calls.length === 1) return initial;
			return {
				status: 'ready' as const,
				documentId: 'doc',
				files: Object.fromEntries(files.map(({ path }) => [path, body(path)])),
				errors: {},
			};
		});
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('initial.ts'), file('selected.ts')],
				limits,
				firstBodyCandidates: ['initial.ts'],
			},
			{ contextLines: 5, diffMode: 'unified', loadBodies, onError: vi.fn() },
		);

		controller.focusFile('selected.ts');
		expect(loadBodies).toHaveBeenCalledOnce();
		resolveInitial({
			status: 'ready',
			documentId: 'doc',
			files: { 'initial.ts': body('initial.ts') },
			errors: {},
		});

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
		}));
		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files,
				limits: { ...limits, maxSummaryFiles: files.length },
				firstBodyCandidates: [],
			},
			{ contextLines: 5, diffMode: 'unified', loadBodies, onError: vi.fn() },
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

	it('stops speculative loading before enforcing the aggregate limit on user-visible files', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(requested.map(({ path }) => [path, body(path)])),
			errors: {},
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
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		expect(controller.fileBodies['b.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();

		controller.focusFile('b.ts');

		await vi.waitFor(() =>
			expect(controller.aggregateLimit?.reason).toBe('collection-too-many-rows'),
		);
		expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded');
		expect(controller.fileBodies['b.ts']?.bodyState).toBe('too-large');
	});

	it('honors a collection budget limit emitted by the server', async () => {
		const controller = new GitDiffDocumentController();
		const limitedBody: GitReviewFileBody = {
			...body('b.ts'),
			bodyState: 'too-large',
			category: 'large',
			isTooLarge: true,
			renderedRowCount: 0,
			patchBytes: 0,
			patch: null,
			patchIndex: null,
			limitReason: 'collection-too-many-rows',
			limitMessage: 'Server stopped after 6 rendered rows.',
		};

		controller.open(
			{
				project: '/project',
				documentId: 'doc',
				files: [file('a.ts'), file('b.ts'), file('c.ts')],
				limits,
				firstBodyCandidates: ['a.ts'],
			},
			{
				contextLines: 5,
				diffMode: 'unified',
				loadBodies: vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
					status: 'ready' as const,
					documentId: 'doc',
					files: Object.fromEntries(
						requested.flatMap(({ path }) =>
							path === 'a.ts'
								? [[path, body(path)]]
								: path === 'b.ts'
									? [[path, limitedBody]]
									: [],
						),
					),
					errors: {},
				})),
				onError: vi.fn(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded'));
		controller.focusFile('b.ts');
		await vi.waitFor(() =>
			expect(controller.aggregateLimit?.reason).toBe('collection-too-many-rows'),
		);
		expect(controller.aggregateLimit?.message).toBe('Server stopped after 6 rendered rows.');
		expect(controller.fileBodies['a.ts']?.bodyState).toBe('loaded');
		expect(controller.fileBodies['b.ts']).toBe(limitedBody);
		expect(controller.fileBodies['c.ts']).toBeUndefined();
	});

	it('evicts a speculative body when the selected body arrives later', async () => {
		const controller = new GitDiffDocumentController();
		let resolveVisible!: (value: {
			status: 'ready';
			documentId: string;
			files: Record<string, GitReviewFileBody>;
			errors: Record<string, string>;
		}) => void;
		const visible = new Promise<{
			status: 'ready';
			documentId: string;
			files: Record<string, GitReviewFileBody>;
			errors: Record<string, string>;
		}>((resolve) => {
			resolveVisible = resolve;
		});
		const loadBodies = vi.fn(
			async (_snapshot, requested: Array<{ path: string }>, purpose: string) => {
				if (purpose === 'visible') return visible;
				return {
					status: 'ready' as const,
					documentId: 'doc',
					files: Object.fromEntries(requested.map(({ path }) => [path, body(path)])),
					errors: {},
				};
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
			},
		);

		await vi.waitFor(() =>
			expect(controller.fileBodies['prefetch.ts']?.bodyState).toBe('loaded'),
		);
		resolveVisible({
			status: 'ready',
			documentId: 'doc',
			files: { 'selected.ts': body('selected.ts') },
			errors: {},
		});

		await vi.waitFor(() =>
			expect(controller.fileBodies['selected.ts']?.bodyState).toBe('loaded'),
		);
		expect(controller.fileBodies['prefetch.ts']).toBeUndefined();
		expect(controller.aggregateLimit).toBeNull();
	});

	it('renders explicit limits for files left unloaded after the aggregate budget is reached', async () => {
		const controller = new GitDiffDocumentController();
		const loadBodies = vi.fn(async (_snapshot, requested: Array<{ path: string }>) => ({
			status: 'ready' as const,
			documentId: 'doc',
			files: Object.fromEntries(requested.map(({ path }) => [path, body(path)])),
			errors: {},
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
				})),
				onError: vi.fn(),
			},
		);

		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyState).toBe('error'));
		expect(controller.fileBodies['a.ts']?.error).toBe('Unable to read this path.');
	});

	it('bounds cached bodies across document changes', async () => {
		const controller = new GitDiffDocumentController();
		const boundedLimits = { ...limits, maxLoadedPatchBytes: 150 };
		const loadBodies = vi.fn(
			async (snapshot: { documentId: string }, files: Array<{ path: string }>) => ({
				status: 'ready' as const,
				documentId: snapshot.documentId,
				files: Object.fromEntries(files.map(({ path }) => [path, body(path)])),
				errors: {},
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
				{ contextLines: 5, diffMode: 'unified', loadBodies, onError: vi.fn() },
			);

		open('doc-a', 'a.ts');
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(1));
		open('doc-b', 'b.ts');
		await vi.waitFor(() => expect(loadBodies).toHaveBeenCalledTimes(2));
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
				{ contextLines: 5, diffMode: 'unified', loadBodies, onError: vi.fn() },
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
			{ contextLines: 5, diffMode: 'unified', loadBodies, onError: vi.fn() },
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
		};
		controller.open(documentSnapshot, options);
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeTruthy());

		controller.open(documentSnapshot, options);

		expect(controller.fileBodies['a.ts']).toEqual(body('a.ts'));
		expect(loadBodies).toHaveBeenCalledOnce();
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
