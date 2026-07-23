import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getGitComparisonFileBodies,
	getGitComparisonSnapshot,
	type GitComparisonSnapshotReady,
} from '$lib/api/git-comparison.js';
import { getGitWorkingTreeFingerprint } from '$lib/api/git.js';
import { GitComparisonController } from '../git-comparison.svelte.js';

vi.mock('$lib/api/git-comparison.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/git-comparison.js')>();
	return {
		...actual,
		getGitComparisonSnapshot: vi.fn(),
		getGitComparisonFileBodies: vi.fn(),
	};
});

vi.mock('$lib/api/git.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/git.js')>()),
	getGitWorkingTreeFingerprint: vi.fn(),
}));

const limits = {
	maxSummaryFiles: 10_000,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 100_000,
	maxLoadedPatchBytes: 10_000_000,
	maxFileRows: 50_000,
	maxFilePatchBytes: 5_000_000,
	maxLineBytes: 20_000,
	maxContextLines: 20,
	bodyConcurrency: 4,
};

function workingTreeSnapshot(): GitComparisonSnapshotReady {
	return {
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		documentId: 'comparison-doc',
		mode: 'direct',
		from: {
			kind: 'revision',
			requestedRevision: 'main',
			label: 'main',
			hash: 'a'.repeat(40),
			shortHash: 'aaaaaaa',
		},
		to: {
			kind: 'working-tree',
			label: 'Working Tree',
			branch: 'main',
			headHash: 'a'.repeat(40),
			fingerprint: 'v1:old',
			shortFingerprint: 'old',
		},
		effectiveFromHash: 'a'.repeat(40),
		files: [],
		limits,
		firstBodyCandidates: [],
	};
}

function workingTreeSnapshotWithFile(): GitComparisonSnapshotReady {
	return {
		...workingTreeSnapshot(),
		files: [
			{
				path: 'src/a.ts',
				status: 'modified',
				rawStatus: 'M',
				category: 'normal',
				additions: 1,
				deletions: 0,
				estimatedRows: 2,
				bodyState: 'unloaded',
				bodyFingerprint: 'body-a',
				isGenerated: false,
				isBinary: false,
				isTooLarge: false,
			},
		],
	};
}

function revisionSnapshotWithFile(): GitComparisonSnapshotReady {
	return {
		...workingTreeSnapshotWithFile(),
		to: {
			kind: 'revision',
			requestedRevision: 'feature',
			label: 'feature',
			hash: 'b'.repeat(40),
			shortHash: 'bbbbbbb',
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe('GitComparisonController', () => {
	beforeEach(() => vi.clearAllMocks());

	it('opens Changes comparisons as HEAD to the complete Working Tree', () => {
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: 'HEAD',
			toKind: 'working-tree',
		});

		expect(comparison.dialogOpen).toBe(true);
		expect(comparison.fromRevision).toBe('HEAD');
		expect(comparison.toKind).toBe('working-tree');
		expect(comparison.mode).toBe('direct');
	});

	it('forces direct mode for Working Tree and swaps only revision endpoints', () => {
		const comparison = new GitComparisonController();
		comparison.toKind = 'revision';
		comparison.fromRevision = 'main';
		comparison.toRevision = 'feature';
		comparison.mode = 'merge-base';
		comparison.swapRevisions();
		expect([comparison.fromRevision, comparison.toRevision]).toEqual(['feature', 'main']);

		comparison.setToKind('working-tree');
		comparison.swapRevisions();
		expect(comparison.mode).toBe('direct');
		expect([comparison.fromRevision, comparison.toRevision]).toEqual(['feature', 'main']);
	});

	it('loads a frozen Working Tree comparison and detects later changes', async () => {
		const snapshot = { ...workingTreeSnapshot(), repoRoot: '/repo' };
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitComparisonFileBodies).mockResolvedValue({
			status: 'ready',
			documentId: snapshot.documentId,
			files: {},
			errors: {},
		});
		vi.mocked(getGitWorkingTreeFingerprint).mockResolvedValue({
			status: 'ready',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: 'v1:new',
			changedPathCount: 1,
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });

		expect(await comparison.compare('/project')).toBe(true);
		expect(comparison.snapshot?.documentId).toBe('comparison-doc');
		expect(comparison.dialogOpen).toBe(false);
		await comparison.checkFreshness('/project');
		expect(getGitWorkingTreeFingerprint).toHaveBeenCalledWith('/repo');
		expect(comparison.staleMessage).toContain('Working Tree changed');
	});

	it('does not report operational fingerprint failures as content staleness', async () => {
		const snapshot = workingTreeSnapshot();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitWorkingTreeFingerprint).mockResolvedValue({
			status: 'unknown',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: null,
			message: 'Fingerprint unavailable.',
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });

		expect(await comparison.compare('/project')).toBe(true);
		await comparison.checkFreshness('/project');

		expect(comparison.staleMessage).toBeNull();
		expect(comparison.document.isStale).toBe(false);
	});

	it('clears a transient body load error after a successful retry', async () => {
		const snapshot = {
			...workingTreeSnapshotWithFile(),
			firstBodyCandidates: ['src/a.ts'],
		};
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitComparisonFileBodies)
			.mockRejectedValueOnce(new Error('temporary network failure'))
			.mockResolvedValueOnce({
				status: 'ready',
				documentId: snapshot.documentId,
				files: {},
				errors: {},
			});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });

		await comparison.compare('/project');
		await vi.waitFor(() => expect(comparison.bodyError).toContain('temporary network failure'));
		comparison.focusFile('src/a.ts');
		await vi.waitFor(() => expect(getGitComparisonFileBodies).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(comparison.bodyError).toBeNull());
	});

	it('fills explicit From and To slots from History selection', () => {
		const comparison = new GitComparisonController();
		comparison.beginHistorySelection();
		comparison.selectHistoryCommit('older');
		comparison.selectHistoryCommit('newer');
		const defaults = comparison.takeSelectedHistoryRange();

			expect(defaults).toEqual({
				fromRevision: 'older',
				toKind: 'revision',
				toRevision: 'newer',
			});
		expect(comparison.historySelectionActive).toBe(false);
	});

	it('preserves typed endpoint and merge-base failures for dialog recovery', async () => {
		vi.mocked(getGitComparisonSnapshot)
			.mockResolvedValueOnce({
				status: 'not-found',
				project: '/project',
				endpoint: 'from',
				revision: 'missing',
				message: 'The From revision was not found in this repository.',
			})
			.mockResolvedValueOnce({
				status: 'no-merge-base',
				project: '/project',
				from: workingTreeSnapshot().from,
				to: {
					kind: 'revision',
					requestedRevision: 'other',
					label: 'other',
					hash: 'b'.repeat(40),
					shortHash: 'bbbbbbb',
				},
				message: 'These revisions do not have a common ancestor.',
			});
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: 'missing',
			toKind: 'revision',
			toRevision: 'other',
			mode: 'merge-base',
		});

		expect(await comparison.compare('/project')).toBe(false);
		expect(comparison.errorEndpoint).toBe('from');
		expect(await comparison.compare('/project')).toBe(false);
		expect(comparison.errorStatus).toBe('no-merge-base');
		expect(comparison.errorEndpoint).toBeNull();
	});

	it('keeps the frozen stale document visible when refresh fails', async () => {
		const snapshot = workingTreeSnapshot();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValueOnce(snapshot).mockResolvedValueOnce({
			status: 'working-tree-changing',
			project: '/project',
			message: 'The Working Tree is still changing.',
		});
		vi.mocked(getGitWorkingTreeFingerprint).mockResolvedValue({
			status: 'ready',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: 'v1:new',
			changedPathCount: 1,
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });
		await comparison.compare('/project');
		await comparison.checkFreshness('/project');

		await comparison.refresh('/project');
		expect(comparison.snapshot?.documentId).toBe(snapshot.documentId);
		expect(comparison.staleMessage).toContain('Working Tree changed');
		expect(comparison.document.isStale).toBe(true);
	});

	it('discards canceled endpoint edits before refreshing', async () => {
		const snapshot = workingTreeSnapshot();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });
		await comparison.compare('/project');

		comparison.editComparison();
		comparison.fromRevision = 'canceled-edit';
		comparison.closeDialog();
		await comparison.refresh('/project');

		expect(comparison.fromRevision).toBe('main');
		expect(vi.mocked(getGitComparisonSnapshot).mock.calls[1]?.[1]).toEqual({
			kind: 'revision',
			revision: 'main',
		});
	});

	it('aborts and closes an in-flight comparison from the dialog close action', async () => {
		const pending = deferred<GitComparisonSnapshotReady>();
		vi.mocked(getGitComparisonSnapshot).mockReturnValue(pending.promise);
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });

		const request = comparison.compare('/project');
		await vi.waitFor(() => expect(getGitComparisonSnapshot).toHaveBeenCalledOnce());
		const signal = vi.mocked(getGitComparisonSnapshot).mock.calls[0]?.[4]?.signal;
		comparison.closeDialog();

		expect(signal?.aborted).toBe(true);
		expect(comparison.dialogOpen).toBe(false);
		expect(comparison.isLoading).toBe(false);
		pending.resolve(workingTreeSnapshot());
		expect(await request).toBe(false);
		expect(comparison.snapshot).toBeNull();
	});

	it('uses caller display options for the first snapshot request', async () => {
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(workingTreeSnapshot());
		const comparison = new GitComparisonController();
		comparison.openDialog(
			{ fromRevision: 'main', toKind: 'working-tree' },
			{ diffMode: 'split', contextLines: 12 },
		);

		await comparison.compare('/project');

		expect(getGitComparisonSnapshot).toHaveBeenCalledOnce();
		expect(vi.mocked(getGitComparisonSnapshot).mock.calls[0]?.[4]).toMatchObject({ context: 12 });
	});

	it('requires explicit refresh before applying context changes to a Working Tree snapshot', async () => {
		const snapshot = workingTreeSnapshotWithFile();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitComparisonFileBodies).mockResolvedValue({
			status: 'ready',
			documentId: snapshot.documentId,
			files: {},
			errors: {},
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });
		await comparison.compare('/project');

		comparison.setDisplayOptions('/project', 'unified', 12);
		expect(getGitComparisonSnapshot).toHaveBeenCalledOnce();
		expect(comparison.staleMessage).toContain('Refresh the comparison');
		comparison.focusFile('src/a.ts');
		await vi.waitFor(() => expect(getGitComparisonFileBodies).toHaveBeenCalledOnce());

		expect(vi.mocked(getGitComparisonFileBodies).mock.calls[0]?.[5]).toMatchObject({ context: 5 });
		await comparison.refresh('/project');
		expect(getGitComparisonSnapshot).toHaveBeenCalledTimes(2);
		expect(vi.mocked(getGitComparisonSnapshot).mock.calls[1]?.[4]).toMatchObject({ context: 12 });
	});

	it('keeps an open revision comment when a context change is requested', async () => {
		const snapshot = revisionSnapshotWithFile();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		const comparison = new GitComparisonController();
		comparison.openDialog({
			fromRevision: 'main',
			toKind: 'revision',
			toRevision: 'feature',
		});
		await comparison.compare('/project');
		comparison.document.openCommentComposer('src/a.ts', 'after', 1);
		comparison.document.setCommentBody('Keep this draft');
		comparison.document.setCommentSeverity('blocker');

		comparison.setDisplayOptions('/project', 'unified', 12);

		expect(getGitComparisonSnapshot).toHaveBeenCalledOnce();
		expect(comparison.document.contextLines).toBe(5);
		expect(comparison.document.commentComposer).toMatchObject({
			open: true,
			body: 'Keep this draft',
			severity: 'blocker',
		});
		expect(comparison.document.commentError).toBe(
			'Add or close this comment before changing context lines.',
		);
	});

	it('preserves stale Working Tree content and an open comment across context changes', async () => {
		const snapshot = workingTreeSnapshotWithFile();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitWorkingTreeFingerprint).mockResolvedValue({
			status: 'ready',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: 'v1:new',
			changedPathCount: 1,
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });
		await comparison.compare('/project');
		comparison.document.openCommentComposer('src/a.ts', 'after', 1);
		comparison.document.setCommentBody('Keep this draft');
		await comparison.checkFreshness('/project');

		comparison.setDisplayOptions('/project', 'unified', 12);

		expect(getGitComparisonSnapshot).toHaveBeenCalledOnce();
		expect(comparison.document.isStale).toBe(true);
		expect(comparison.staleMessage).toContain('Working Tree changed');
		expect(comparison.document.commentComposer.body).toBe('Keep this draft');
	});

	it('upgrades a context refresh notice when the Working Tree later changes', async () => {
		const snapshot = workingTreeSnapshotWithFile();
		vi.mocked(getGitComparisonSnapshot).mockResolvedValue(snapshot);
		vi.mocked(getGitWorkingTreeFingerprint).mockResolvedValue({
			status: 'ready',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: 'v1:new',
			changedPathCount: 1,
		});
		const comparison = new GitComparisonController();
		comparison.openDialog({ fromRevision: 'main', toKind: 'working-tree' });
		await comparison.compare('/project');
		comparison.setDisplayOptions('/project', 'unified', 12);

		expect(comparison.staleMessage).toContain('Refresh the comparison');
		await comparison.checkFreshness('/project');

		expect(comparison.document.isStale).toBe(true);
		expect(comparison.staleMessage).toContain('Working Tree changed');
	});
});
