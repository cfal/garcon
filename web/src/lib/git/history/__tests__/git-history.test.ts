import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	getGitCommitFileBodies,
	getGitCommitSnapshot,
	getGitHistoryCommits,
	type GitCommitFileSummary,
} from '$lib/api/git.js';
import { GitHistoryController } from '$lib/git/history/git-history.svelte.js';
import type { GitVirtualFileHeaderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';

vi.mock('$lib/api/git.js', () => ({
	getGitHistoryCommits: vi.fn(),
	getGitCommitSnapshot: vi.fn(),
	getGitCommitFileBodies: vi.fn(),
}));

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

function snapshot(hash: string, fingerprint = 'fp-a') {
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
		files: [
			{
				path: 'a.ts',
				status: 'modified' as const,
				rawStatus: 'M',
				category: 'normal' as const,
				additions: 1,
				deletions: 0,
				estimatedRows: 2,
				bodyState: 'unloaded' as const,
				bodyFingerprint: fingerprint,
				isGenerated: false,
				isBinary: false,
				isTooLarge: false,
			} satisfies GitCommitFileSummary,
		],
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
		firstBodyCandidates: ['a.ts'],
	};
}

function body(fingerprint = 'fp-a') {
	return {
		documentId: 'doc',
		files: {
			'a.ts': {
				path: 'a.ts',
				bodyFingerprint: fingerprint,
				bodyState: 'loaded' as const,
				category: 'normal' as const,
				isBinary: false,
				isTooLarge: false,
				rows: [
					{
						key: 'hunk-0',
						kind: 'hunk' as const,
						text: '@@ -1 +1 @@',
						beforeLine: null,
						afterLine: null,
						hunkId: 'h0',
						hunkIndex: 0,
						diffLineIndex: -1,
					},
					{
						key: 'add-0',
						kind: 'add' as const,
						text: 'next',
						beforeLine: null,
						afterLine: 1,
						hunkId: 'h0',
						hunkIndex: 0,
						diffLineIndex: 0,
					},
				],
				hunks: [],
			},
		},
		errors: {},
	};
}

describe('GitHistoryController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getGitCommitFileBodies).mockResolvedValue(body());
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
			['a.ts'],
			expect.objectContaining({ parent: 'parent', context: 5 }),
		);
		expect(history.fileBodies['a.ts']?.bodyState).toBe('loaded');
		expect(history.virtualRows.some((row) => row.kind === 'unified-row')).toBe(true);
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
		history.setVisibleRows('/project', [
			{
				kind: 'file-header',
				filePath: 'a.ts',
				id: 'row',
				estimatedHeight: 42,
				file: {
					...commitSnapshot.files[0],
					indexStatus: 'M',
					workTreeStatus: ' ',
				},
				isFocused: true,
			} satisfies GitVirtualFileHeaderRow,
		]);
		await flushPromises();
		history.backToList();

		expect(getGitCommitFileBodies).toHaveBeenCalled();
		expect(history.screen).toBe('list');
		expect(history.listScrollTop).toBe(320);
	});
});
