import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitCommitFileSummary,
} from '$lib/api/git.js';
import {
	getGitComparisonFileBodies,
	getGitComparisonSnapshot,
	type GitComparisonSnapshotReady,
} from '$lib/api/git-comparison.js';
import { GitHistoryController } from '$lib/git/history/git-history.svelte.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';

vi.mock('$lib/api/git.js', () => ({
	getGitHistoryCommits: vi.fn(),
	getGitCommitSnapshot: vi.fn(),
	getGitCommitFileBodies: vi.fn(),
}));

vi.mock('$lib/api/git-comparison.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/git-comparison.js')>();
	return {
		...actual,
		getGitComparisonFreshness: vi.fn(),
		getGitComparisonSnapshot: vi.fn(),
		getGitComparisonFileBodies: vi.fn(),
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function commit(hash: string, subject: string) {
	return {
		hash,
		shortHash: hash.slice(0, 7),
		parents: ['parent'],
		author: 'Test User',
		authorEmail: 'test@example.com',
		authorDate: '2026-01-01T00:00:00.000Z',
		committer: 'Test User',
		committerEmail: 'test@example.com',
		committerDate: '2026-01-01T00:00:00.000Z',
		subject,
		refs: [],
	};
}

function commitFile(path: string, fingerprint = `fp-${path}`): GitCommitFileSummary {
	return {
		path,
		status: 'modified',
		rawStatus: 'M',
		category: 'normal',
		additions: 1,
		deletions: 0,
		estimatedRows: 2,
		bodyState: 'unloaded',
		bodyFingerprint: fingerprint,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function snapshot(
	hash: string,
	fingerprint = 'fp-a',
	overrides: {
		files?: GitCommitFileSummary[];
		firstBodyCandidates?: string[];
	} = {},
) {
	const files = overrides.files ?? [commitFile('a.ts', fingerprint)];
	return {
		status: 'ready' as const,
		project: '/project',
		documentId: `doc-${hash}`,
		commit: {
			...commit(hash, `subject ${hash}`),
			body: '',
		},
		selectedParent: 'parent',
		parentOptions: [{ hash: 'parent', shortHash: 'parent', label: 'Parent 1' }],
		files,
		limits: {
			maxSummaryFiles: 1000,
			maxBodyBatchFiles: 24,
			maxLoadedRows: 10_000,
			maxLoadedPatchBytes: 1024 * 1024,
			maxFileRows: 10_000,
			maxFilePatchBytes: 1024 * 1024,
			maxLineBytes: 20_000,
			maxContextLines: 50,
			bodyConcurrency: 4,
		},
		firstBodyCandidates: overrides.firstBodyCandidates ?? ['a.ts'],
	};
}

function bodiesForPaths(paths: string[], fingerprintForPath = (path: string) => `fp-${path}`) {
	return {
		status: 'ready' as const,
		documentId: 'doc',
		files: Object.fromEntries(
			paths.map((path) => [
				path,
				(() => {
					const patch = `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+next\n`;
					return {
						path,
						bodyFingerprint: fingerprintForPath(path),
						bodyState: 'loaded' as const,
						category: 'normal' as const,
						isBinary: false,
						isTooLarge: false,
						renderedRowCount: 2,
						patchBytes: patch.length,
						patch,
						patchIndex: createGitPatchIndex(patch),
					};
				})(),
			]),
		),
		errors: {},
	};
}

function body(fingerprint = 'fp-a') {
	return bodiesForPaths(['a.ts'], () => fingerprint);
}

function comparisonSnapshot(): GitComparisonSnapshotReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/repo',
		documentId: 'comparison-doc',
		mode: 'direct',
		from: {
			kind: 'revision',
			requestedRevision: 'older',
			label: 'older',
			hash: 'a'.repeat(40),
			shortHash: 'aaaaaaa',
		},
		to: {
			kind: 'revision',
			requestedRevision: 'newer',
			label: 'newer',
			hash: 'b'.repeat(40),
			shortHash: 'bbbbbbb',
		},
		effectiveFromHash: 'a'.repeat(40),
		files: [],
		limits: {
			maxSummaryFiles: 1000,
			maxBodyBatchFiles: 24,
			maxLoadedRows: 10_000,
			maxLoadedPatchBytes: 1024 * 1024,
			maxFileRows: 10_000,
			maxFilePatchBytes: 1024 * 1024,
			maxLineBytes: 20_000,
			maxContextLines: 50,
			bodyConcurrency: 4,
		},
		firstBodyCandidates: [],
	};
}

describe('GitHistoryController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getGitCommitFileBodies).mockResolvedValue(body());
		vi.mocked(getGitComparisonFileBodies).mockResolvedValue({
			status: 'ready',
			documentId: 'comparison-doc',
			files: {},
			errors: {},
		});
	});

	it('loads the initial commit list', async () => {
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [commit('abcdef123', 'initial')],
			nextOffset: null,
		});
		const history = new GitHistoryController();

		history.loadInitial('/project');
		await flushPromises();

		expect(history.listLoading).toBe(false);
		expect(history.commits[0].subject).toBe('initial');
		expect(getGitHistoryCommits).toHaveBeenCalledWith(
			'/project',
			expect.objectContaining({
				limit: 50,
				offset: 0,
			}),
		);
	});

	it('preserves loaded pages when the History view remounts', async () => {
		vi.mocked(getGitHistoryCommits).mockResolvedValue({
			project: '/project',
			ref: 'HEAD',
			commits: [commit('abcdef123', 'initial')],
			nextOffset: null,
		});
		const history = new GitHistoryController();

		history.ensureInitialLoaded('/project');
		await flushPromises();
		history.commits = [...history.commits, commit('older1234', 'older page')];

		history.ensureInitialLoaded('/project');

		expect(getGitHistoryCommits).toHaveBeenCalledOnce();
		expect(history.commits.map((entry) => entry.subject)).toEqual(['initial', 'older page']);
	});

	it('opens a commit screen and loads first body candidates', async () => {
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot('abcdef123'));
		const history = new GitHistoryController();
		history.resetForProject('/project');

		history.openCommit('/project', 'abcdef123');
		await flushPromises();
		await flushPromises();

		expect(history.screen).toBe('commit');
		expect(history.commitSnapshot?.commit.hash).toBe('abcdef123');
		expect(getGitCommitFileBodies).toHaveBeenCalledWith(
			'/project',
			'doc-abcdef123',
			'abcdef123',
			[{ path: 'a.ts' }],
			expect.objectContaining({ parent: 'parent', context: 5 }),
		);
		expect(history.fileBodies['a.ts']?.bodyState).toBe('loaded');
		expect(
			history.rowSource
				.rowsInRange(0, history.rowSource.rowCount)
				.some((row) => row.kind === 'unified-row'),
		).toBe(true);
	});

	it('refreshes an expired commit document once without retrying indefinitely', async () => {
		vi.mocked(getGitCommitSnapshot)
			.mockResolvedValueOnce(snapshot('abcdef123', 'fp-a'))
			.mockResolvedValueOnce(snapshot('abcdef123', 'fp-b'));
		vi.mocked(getGitCommitFileBodies).mockResolvedValue({
			status: 'document-expired',
			documentId: 'expired-doc',
			message: 'This review expired.',
		});
		const history = new GitHistoryController();
		history.resetForProject('/project');

		history.openCommit('/project', 'abcdef123');

		await vi.waitFor(() => expect(getGitCommitSnapshot).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalledTimes(2));
		expect(getGitCommitSnapshot).toHaveBeenCalledTimes(2);
		expect(history.commitError).toBe('This review expired.');
	});

	it('keeps an open comment when a context change is requested', async () => {
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot('abcdef123'));
		const history = new GitHistoryController();
		history.resetForProject('/project');
		history.openCommit('/project', 'abcdef123');
		await flushPromises();
		await flushPromises();
		history.document.openCommentComposer('a.ts', 'after', 1);
		history.document.setCommentBody('Keep this draft');
		history.document.setCommentSeverity('warning');

		history.setDisplayOptions('/project', 'unified', 12);

		expect(getGitCommitSnapshot).toHaveBeenCalledOnce();
		expect(history.contextLines).toBe(5);
		expect(history.document.commentComposer).toMatchObject({
			open: true,
			body: 'Keep this draft',
			severity: 'warning',
		});
		expect(history.document.commentError).toBe(
			'Add or close this comment before changing context lines.',
		);
	});

	it('loads newly visible files after the active visible request without waiting for prefetch', async () => {
		const files = Array.from({ length: 9 }, (_, index) => commitFile(`file-${index}.ts`));
		const firstBodyCandidates = files.slice(0, 8).map((file) => file.path);
		const firstVisible = deferred<ReturnType<typeof bodiesForPaths>>();
		const prefetch = deferred<ReturnType<typeof bodiesForPaths>>();
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(
			snapshot('abcdef123', 'fp-a', { files, firstBodyCandidates }),
		);
		vi.mocked(getGitCommitFileBodies)
			.mockReturnValueOnce(firstVisible.promise)
			.mockReturnValueOnce(prefetch.promise)
			.mockResolvedValueOnce(bodiesForPaths(['file-8.ts']));
		const history = new GitHistoryController();
		history.resetForProject('/project');

		history.openCommit('/project', 'abcdef123');
		await vi.waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalledTimes(2));
		expect(vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[3]).toEqual([{ path: 'file-0.ts' }]);
		expect(vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[4]?.purpose).toBe('visible');
		expect(vi.mocked(getGitCommitFileBodies).mock.calls[1]?.[4]?.purpose).toBe('prefetch');
		const firstSignal = vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[4]?.signal;
		history.handleBodyDemand({
			kind: 'viewport',
			documentId: history.commitSnapshot!.documentId,
			filePaths: [files[8].path],
		});

		expect(firstSignal?.aborted).toBe(false);
		expect(getGitCommitFileBodies).toHaveBeenCalledTimes(2);
		firstVisible.resolve(bodiesForPaths(['file-0.ts']));
		await vi.waitFor(() => {
			expect(history.fileBodies['file-8.ts']?.bodyState).toBe('loaded');
			expect(getGitCommitFileBodies).toHaveBeenCalledTimes(3);
		});
		expect(vi.mocked(getGitCommitFileBodies).mock.calls[2]?.[3]).toEqual([{ path: 'file-8.ts' }]);
		prefetch.resolve(bodiesForPaths(firstBodyCandidates.slice(1)));
	});

	it('still aborts an active body batch when leaving commit details', async () => {
		const pendingBody = deferred<ReturnType<typeof body>>();
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(snapshot('abcdef123'));
		vi.mocked(getGitCommitFileBodies).mockReturnValueOnce(pendingBody.promise);
		const history = new GitHistoryController();
		history.resetForProject('/project');

		history.openCommit('/project', 'abcdef123');
		await vi.waitFor(() => expect(getGitCommitFileBodies).toHaveBeenCalledOnce());
		const signal = vi.mocked(getGitCommitFileBodies).mock.calls[0]?.[4]?.signal;
		history.focusFile('/project', 'a.ts');
		expect(history.scrollRequest?.filePath).toBe('a.ts');

		history.backToList();

		expect(signal?.aborted).toBe(true);
		expect(history.screen).toBe('list');
		expect(history.scrollRequest).toBeNull();
		pendingBody.resolve(body());
		await flushPromises();
		expect(history.fileBodies).toEqual({});
	});

	it('opens a selected revision comparison locally and preserves list state on back', async () => {
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(comparisonSnapshot());
		const history = new GitHistoryController();
		history.resetForProject('/project');
		history.listScrollTop = 320;

		history.openComparison(
			'/project',
			{
				fromRevision: 'older',
				toKind: 'revision',
				toRevision: 'newer',
			},
			{ diffMode: 'split', contextLines: 8 },
		);

		expect(history.screen).toBe('comparison');
		await vi.waitFor(() => expect(history.comparison.snapshot).not.toBeNull());
		expect(getGitComparisonSnapshot).toHaveBeenCalledWith(
			'/project',
			{ kind: 'revision', revision: 'older' },
			{ kind: 'revision', revision: 'newer' },
			'direct',
			expect.objectContaining({ context: 8 }),
		);
		expect(history.activeDocument).toBe(history.comparison.document);
		expect(history.comparison.document.diffMode).toBe('split');

		history.backToList();

		expect(history.screen).toBe('list');
		expect(history.listScrollTop).toBe(320);
		expect(history.comparison.snapshot).toBeNull();
		expect(history.activeDocument).toBe(history.document);
	});

	it('reports loading only for the active History screen', () => {
		const history = new GitHistoryController();

		history.screen = 'list';
		history.listLoading = true;
		history.commitLoading = false;
		history.comparison.isLoading = false;
		expect(history.activeScreenLoading).toBe(true);

		history.screen = 'commit';
		history.listLoading = true;
		expect(history.activeScreenLoading).toBe(false);
		history.commitLoading = true;
		expect(history.activeScreenLoading).toBe(true);

		history.screen = 'comparison';
		history.commitLoading = true;
		expect(history.activeScreenLoading).toBe(false);
		history.comparison.isLoading = true;
		expect(history.activeScreenLoading).toBe(true);
	});

	it('aborts a local comparison when returning to the commit list', async () => {
		const pending = deferred<GitComparisonSnapshotReady>();
		vi.mocked(getGitComparisonSnapshot).mockReturnValueOnce(pending.promise);
		const history = new GitHistoryController();
		history.resetForProject('/project');
		history.openComparison(
			'/project',
			{
				fromRevision: 'older',
				toKind: 'revision',
				toRevision: 'newer',
			},
			{ diffMode: 'unified', contextLines: 5 },
		);
		const signal = vi.mocked(getGitComparisonSnapshot).mock.calls[0]?.[4]?.signal;

		history.backToList();
		pending.resolve(comparisonSnapshot());
		await flushPromises();

		expect(signal?.aborted).toBe(true);
		expect(history.screen).toBe('list');
		expect(history.comparison.snapshot).toBeNull();
	});

	it('ignores stale commit snapshots after selecting another commit', async () => {
		const stale = deferred<ReturnType<typeof snapshot>>();
		vi.mocked(getGitCommitSnapshot)
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce(snapshot('bbbbbbb123', 'fp-b'));
		vi.mocked(getGitCommitFileBodies).mockResolvedValue(body('fp-b'));
		const history = new GitHistoryController();
		history.resetForProject('/project');

		history.openCommit('/project', 'aaaaaaa123');
		history.openCommit('/project', 'bbbbbbb123');
		await flushPromises();
		stale.resolve(snapshot('aaaaaaa123'));
		await flushPromises();

		expect(history.commitSnapshot?.commit.hash).toBe('bbbbbbb123');
		expect(history.selectedCommitHash).toBe('bbbbbbb123');
	});

	it('requests visible file bodies and preserves list state on back', async () => {
		const commitSnapshot = snapshot('abcdef123');
		vi.mocked(getGitCommitSnapshot).mockResolvedValue(commitSnapshot);
		const history = new GitHistoryController();
		history.resetForProject('/project');
		history.listScrollTop = 320;

		history.openCommit('/project', 'abcdef123');
		await flushPromises();
		history.handleBodyDemand({
			kind: 'viewport',
			documentId: commitSnapshot.documentId,
			filePaths: ['a.ts'],
		});
		await flushPromises();
		history.backToList();

		expect(getGitCommitFileBodies).toHaveBeenCalled();
		expect(history.screen).toBe('list');
		expect(history.listScrollTop).toBe(320);
	});
});
