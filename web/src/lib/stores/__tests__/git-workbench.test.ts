import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GitWorkbenchStore,
	makeLineSelectionKey,
	type GitDiffActionTarget,
	type GitWorkbenchTarget,
} from '../git/git-workbench.svelte';
import type {
	GitReviewDocumentSummary,
	GitReviewFileBody,
	GitReviewFileSummary,
	GitTreeNode,
	GitWorkbenchSnapshotResponse,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

// Mock the git API module
vi.mock('$lib/api/git.js', () => ({
	getGitWorkbenchSnapshot: vi.fn(),
	getGitWorkbenchFingerprint: vi.fn(),
	getGitReviewFileBodies: vi.fn(),
	getGitConflicts: vi.fn(),
	getGitConflictDetails: vi.fn(),
	gitAcceptConflictSide: vi.fn(),
	gitMarkConflictResolved: vi.fn(),
	getGitStashes: vi.fn(),
	gitCreateStash: vi.fn(),
	gitApplyStash: vi.fn(),
	gitPopStash: vi.fn(),
	gitDropStash: vi.fn(),
	getGitFileHistory: vi.fn(),
	getGitBlame: vi.fn(),
	getGitGraph: vi.fn(),
	getGitCompare: vi.fn(),
	gitStageSelection: vi.fn(),
	gitStageHunk: vi.fn(),
	gitStagePaths: vi.fn(),
	gitCommitIndex: vi.fn(),
	gitInitialCommit: vi.fn(),
	generateCommitMessage: vi.fn(),
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
	gitRemoveWorktree: vi.fn(),
	gitRevertCommit: vi.fn(),
}));

vi.stubGlobal('localStorage', {
	getItem: () => 'claude',
	setItem: () => {},
	removeItem: () => {},
});

const gitApi = await import('$lib/api/git.js');
const mockedApi = vi.mocked(gitApi);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeReviewSummary(
	paths: string[] = ['a.ts'],
	overrides: Partial<GitReviewDocumentSummary> = {},
): GitReviewDocumentSummary {
	return {
		documentId: overrides.documentId ?? 'doc',
		project: overrides.project ?? '/project',
		mode: overrides.mode ?? 'working',
		context: overrides.context ?? 5,
		files: paths.map((path) => makeReviewFileSummary(path)),
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
		...overrides,
	};
}

function makeReviewFileSummary(
	path = 'a.ts',
	fingerprint = `fingerprint:${path}`,
): GitReviewFileSummary {
	return {
		path,
		indexStatus: ' ',
		workTreeStatus: 'M',
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

function makeReviewBody(
	path = 'a.ts',
	text = '',
	fingerprint = `fingerprint:${path}`,
): GitReviewFileBody {
	return {
		path,
		bodyFingerprint: fingerprint,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		rows: text
			? [
					{
						key: 'hunk:0:hunk-0',
						kind: 'hunk',
						hunkIndex: 0,
						hunkId: 'hunk-0',
						beforeLine: null,
						afterLine: null,
						text: '@@ -1 +1 @@',
						diffLineIndex: -1,
					},
					{
						key: `line:0:context:1:1:${text}`,
						kind: 'context',
						hunkIndex: 0,
						hunkId: 'hunk-0',
						beforeLine: 1,
						afterLine: 1,
						text,
						diffLineIndex: 0,
					},
				]
			: [],
		hunks: text
			? [
					{
						id: 'hunk-0',
						header: '@@ -1 +1 @@',
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						rowStartIndex: 0,
						rowEndIndex: 1,
					},
				]
			: [],
	};
}

function makeTreeFile(path = 'a.ts') {
	return {
		path,
		name: path.split('/').pop() ?? path,
		kind: 'file' as const,
		staged: false,
		hasUnstaged: true,
		indexStatus: ' ' as const,
		workTreeStatus: 'M' as const,
		changeKind: 'modified' as const,
		unstagedFacet: {
			status: 'M' as const,
			changeKind: 'modified' as const,
			stats: { additions: 1, deletions: 0 },
		},
	};
}

function makeWorkbenchSnapshot({
	project = '/project',
	root = [makeTreeFile('a.ts')],
	hasCommits = true,
	summary,
	selectedFile,
	firstBodyCandidates = [],
	workbenchFingerprint = 'v1:baseline',
}: {
	project?: string;
	root?: GitTreeNode[];
	hasCommits?: boolean;
	summary?: GitReviewDocumentSummary;
	selectedFile?: string | null;
	firstBodyCandidates?: string[];
	workbenchFingerprint?: string;
} = {}): GitWorkbenchSnapshotResponse {
	const filePaths = root.filter((node) => node.kind === 'file').map((node) => node.path);
	const reviewSummary =
		summary ?? makeReviewSummary(filePaths.length > 0 ? filePaths : ['a.ts'], { project });
	return {
		status: 'ready',
		project,
		target: {
			projectPath: project,
			repoRoot: project,
			worktreePath: project,
			label: project.split('/').pop() || project,
			branch: 'main',
			source: 'chat-project',
		},
		tree: {
			root,
			hasCommits,
			statsState: 'loaded',
		},
		reviewSummary,
		selectedFile: selectedFile ?? reviewSummary.files[0]?.path ?? null,
		firstBodyCandidates,
		snapshotId: reviewSummary.documentId,
		workbenchFingerprint,
	};
}

function makeNotRepositorySnapshot(project = '/project'): GitWorkbenchSnapshotResponse {
	return {
		status: 'not-git-repository',
		project,
		target: null,
		tree: null,
		reviewSummary: null,
		selectedFile: null,
		firstBodyCandidates: [],
		message: 'Git is not initialized in this directory.',
	};
}

function makeTarget(projectPath = '/project'): GitWorkbenchTarget {
	return {
		projectPath,
		repoRoot: projectPath,
		worktreePath: projectPath,
		label: projectPath.split('/').pop() || projectPath,
		source: 'chat-project',
	};
}

function makeActionTarget(
	filePath = 'a.ts',
	mode: 'stage' | 'unstage' = 'stage',
): GitDiffActionTarget {
	return {
		filePath,
		tab: mode === 'stage' ? 'unstaged' : 'staged',
		mode,
		contextLines: 5,
	};
}

function makeFingerprint(fingerprint: string) {
	return {
		status: 'ready' as const,
		project: '/project',
		fingerprintVersion: 1 as const,
		fingerprint,
		changedPathCount: 1,
	};
}

describe('GitWorkbenchStore', () => {
	let wb: GitWorkbenchStore;

	beforeEach(() => {
		wb = new GitWorkbenchStore();
		vi.clearAllMocks();
		mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot());
		mockedApi.getGitWorkbenchFingerprint.mockResolvedValue(makeFingerprint('v1:baseline'));
		mockedApi.getGitReviewFileBodies.mockResolvedValue({
			documentId: 'doc',
			files: { 'a.ts': makeReviewBody('a.ts') },
			errors: {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('snapshot loading', () => {
		it('reports initial loading until the first snapshot resolves', async () => {
			const snapshot = deferred<GitWorkbenchSnapshotResponse>();
			mockedApi.getGitWorkbenchSnapshot.mockReturnValueOnce(snapshot.promise);

			expect(wb.isInitialLoadPending).toBe(false);

			const load = wb.setTarget(makeTarget('/project'));
			await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(1));

			expect(wb.isInitialLoadPending).toBe(true);

			snapshot.resolve(makeWorkbenchSnapshot({ root: [makeTreeFile('a.ts')] }));
			await load;

			expect(wb.isInitialLoadPending).toBe(false);
		});

		it('loads tree, summary, and selection from the workbench snapshot', async () => {
			const tree = [makeTreeFile('a.ts')];
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: tree }));

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.files.tree).toEqual(tree);
			expect(wb.files.hasCommits).toBe(true);
			expect(wb.files.selectedFile).toBe('a.ts');
			expect(wb.files.isLoadingTree).toBe(false);
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledWith(
				'/project',
				'unstaged',
				5,
				expect.objectContaining({
					signal: expect.any(AbortSignal),
					selectedFile: null,
					bodyCandidateCount: 8,
				}),
			);
		});

		it('aborts and ignores stale snapshots when target changes', async () => {
			const staleSnapshot = deferred<GitWorkbenchSnapshotResponse>();
			const currentTree = [makeTreeFile('new.ts')];
			mockedApi.getGitWorkbenchSnapshot
				.mockReturnValueOnce(staleSnapshot.promise)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						project: '/project-b',
						root: currentTree,
						hasCommits: false,
					}),
				);

			const staleTarget = wb.setTarget({
				projectPath: '/project-a',
				repoRoot: '/repo',
				worktreePath: '/project-a',
				label: 'a',
				source: 'worktree',
			});
			const staleOptions = mockedApi.getGitWorkbenchSnapshot.mock.calls[0]?.[3] as RequestInit;
			const currentTarget = wb.setTarget({
				projectPath: '/project-b',
				repoRoot: '/repo',
				worktreePath: '/project-b',
				label: 'b',
				source: 'worktree',
			});

			expect(staleOptions.signal).toBeInstanceOf(AbortSignal);
			expect(staleOptions.signal?.aborted).toBe(true);
			staleSnapshot.resolve(
				makeWorkbenchSnapshot({
					project: '/project-a',
					root: [makeTreeFile('old.ts')],
				}),
			);
			await Promise.all([staleTarget, currentTarget]);

			expect(wb.target?.projectPath).toBe('/project-b');
			expect(wb.files.tree).toEqual(currentTree);
			expect(wb.files.hasCommits).toBe(false);
			expect(wb.files.isLoadingTree).toBe(false);
		});

		it('shows typed non-repository state from the snapshot response', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeNotRepositorySnapshot('/project'));

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.repositoryError).toBe('Git is not initialized in this directory.');
			expect(wb.files.tree).toEqual([]);
			expect(wb.review.virtualRows).toEqual([]);
			expect(wb.loadedWorkbenchFingerprint).toBeNull();
			expect(wb.isExternallyStale).toBe(false);
			expect(mockedApi.getGitReviewFileBodies).not.toHaveBeenCalled();
		});

		it('stores the ready snapshot fingerprint as the freshness baseline', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}),
			);

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.loadedWorkbenchFingerprint).toBe('v1:loaded');
			expect(wb.latestWorkbenchFingerprint).toBe('v1:loaded');
			expect(wb.isExternallyStale).toBe(false);
		});

		it('keeps the workbench fresh when the polled fingerprint matches', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}),
			);
			mockedApi.getGitWorkbenchFingerprint.mockResolvedValue({
				status: 'ready',
				project: '/project',
				fingerprintVersion: 1,
				fingerprint: 'v1:loaded',
				changedPathCount: 1,
			});

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			await wb.checkFreshness('/project');

			expect(wb.latestWorkbenchFingerprint).toBe('v1:loaded');
			expect(wb.isExternallyStale).toBe(false);
		});

		it('marks the workbench stale when the polled fingerprint changes', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}),
			);
			mockedApi.getGitWorkbenchFingerprint.mockResolvedValue({
				status: 'ready',
				project: '/project',
				fingerprintVersion: 1,
				fingerprint: 'v1:changed',
				changedPathCount: 1,
			});

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			await wb.checkFreshness('/project');

			expect(wb.latestWorkbenchFingerprint).toBe('v1:changed');
			expect(wb.isExternallyStale).toBe(true);
		});

		it('ignores stale freshness responses after target changes', async () => {
			const staleFingerprint =
				deferred<Awaited<ReturnType<typeof gitApi.getGitWorkbenchFingerprint>>>();
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						project: '/project-a',
						workbenchFingerprint: 'v1:a',
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						project: '/project-b',
						workbenchFingerprint: 'v1:b',
					}),
				);
			mockedApi.getGitWorkbenchFingerprint.mockReturnValueOnce(staleFingerprint.promise);

			await wb.setTarget({
				projectPath: '/project-a',
				repoRoot: '/repo',
				worktreePath: '/project-a',
				label: 'a',
				source: 'worktree',
			});
			const staleCheck = wb.checkFreshness('/project-a');
			await wb.setTarget({
				projectPath: '/project-b',
				repoRoot: '/repo',
				worktreePath: '/project-b',
				label: 'b',
				source: 'worktree',
			});

			staleFingerprint.resolve({
				status: 'ready',
				project: '/project-a',
				fingerprintVersion: 1,
				fingerprint: 'v1:stale-response',
				changedPathCount: 1,
			});
			await staleCheck;

			expect(wb.target?.projectPath).toBe('/project-b');
			expect(wb.loadedWorkbenchFingerprint).toBe('v1:b');
			expect(wb.latestWorkbenchFingerprint).toBe('v1:b');
			expect(wb.isExternallyStale).toBe(false);
		});

		it('does not run freshness polling while a local hunk stage mutation is reconciling', async () => {
			const stageResult = deferred<Awaited<ReturnType<typeof gitApi.gitStageHunk>>>();
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						workbenchFingerprint: 'v1:old',
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						workbenchFingerprint: 'v1:new',
					}),
				);
			mockedApi.gitStageHunk.mockReturnValueOnce(stageResult.promise);

			await wb.setTarget(makeTarget());
			mockedApi.getGitWorkbenchFingerprint.mockClear();

			const stage = wb.staging.stageHunk('/project', makeActionTarget(), 0);

			expect(wb.isReconcilingLocalGitMutation).toBe(true);
			await wb.checkFreshness('/project');
			expect(mockedApi.getGitWorkbenchFingerprint).not.toHaveBeenCalled();

			stageResult.resolve({ success: true });
			await stage;

			expect(wb.loadedWorkbenchFingerprint).toBe('v1:new');
			expect(wb.isReconcilingLocalGitMutation).toBe(false);
			expect(wb.isExternallyStale).toBe(false);
		});

		it('ignores an in-flight freshness response after a local mutation begins', async () => {
			const freshness = deferred<Awaited<ReturnType<typeof gitApi.getGitWorkbenchFingerprint>>>();
			const stageResult = deferred<Awaited<ReturnType<typeof gitApi.gitStageHunk>>>();
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						workbenchFingerprint: 'v1:old',
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						workbenchFingerprint: 'v1:changed',
					}),
				);
			mockedApi.getGitWorkbenchFingerprint.mockReturnValueOnce(freshness.promise);
			mockedApi.gitStageHunk.mockReturnValueOnce(stageResult.promise);

			await wb.setTarget(makeTarget());
			const freshnessCheck = wb.checkFreshness('/project');
			const stage = wb.staging.stageHunk('/project', makeActionTarget(), 0);

			freshness.resolve(makeFingerprint('v1:changed'));
			await freshnessCheck;

			expect(wb.isExternallyStale).toBe(false);

			stageResult.resolve({ success: true });
			await stage;

			expect(wb.loadedWorkbenchFingerprint).toBe('v1:changed');
			expect(wb.isExternallyStale).toBe(false);
		});

		it('suppresses body fingerprint mismatch while a local mutation is reconciling', async () => {
			const bodyLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitReviewFileBodies>>>();
			const stageResult = deferred<Awaited<ReturnType<typeof gitApi.gitStageHunk>>>();
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						firstBodyCandidates: ['a.ts'],
						workbenchFingerprint: 'v1:old',
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						workbenchFingerprint: 'v1:new',
					}),
				);
			mockedApi.getGitReviewFileBodies.mockReturnValueOnce(bodyLoad.promise);
			mockedApi.gitStageHunk.mockReturnValueOnce(stageResult.promise);

			await wb.setTarget(makeTarget());
			const stage = wb.staging.stageHunk('/project', makeActionTarget(), 0);

			bodyLoad.resolve({
				documentId: 'doc',
				files: { 'a.ts': makeReviewBody('a.ts', 'changed', 'fingerprint:new') },
				errors: {},
			});
			await Promise.resolve();

			expect(wb.isExternallyStale).toBe(false);

			stageResult.resolve({ success: true });
			await stage;

			expect(wb.isExternallyStale).toBe(false);
		});

		it('keeps body fingerprint mismatch as a stale signal outside local mutations', async () => {
			const bodyLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitReviewFileBodies>>>();
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
				makeWorkbenchSnapshot({
					firstBodyCandidates: ['a.ts'],
					workbenchFingerprint: 'v1:old',
				}),
			);
			mockedApi.getGitReviewFileBodies.mockReturnValueOnce(bodyLoad.promise);

			await wb.setTarget(makeTarget());
			bodyLoad.resolve({
				documentId: 'doc',
				files: { 'a.ts': makeReviewBody('a.ts', 'changed', 'fingerprint:new') },
				errors: {},
			});

			await vi.waitFor(() => expect(wb.isExternallyStale).toBe(true));
		});

		it('runs one freshness check when a local mutation ends without a snapshot', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
				makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:old',
				}),
			);
			mockedApi.getGitWorkbenchFingerprint.mockResolvedValueOnce(makeFingerprint('v1:changed'));

			await wb.setTarget(makeTarget());

			await wb.runLocalGitMutation('/project', async () => true);

			await vi.waitFor(() => {
				expect(mockedApi.getGitWorkbenchFingerprint).toHaveBeenCalledWith(
					'/project',
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});
			await vi.waitFor(() => expect(wb.isExternallyStale).toBe(true));
		});

		it('clears local mutation reconciliation state when the target resets', async () => {
			const mutation = deferred<boolean>();
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(
				makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:old',
				}),
			);

			await wb.setTarget(makeTarget());
			const pending = wb.runLocalGitMutation('/project', () => mutation.promise);

			expect(wb.isReconcilingLocalGitMutation).toBe(true);

			await wb.setTarget(null);

			expect(wb.isReconcilingLocalGitMutation).toBe(false);

			mutation.resolve(true);
			await pending;
			expect(wb.isReconcilingLocalGitMutation).toBe(false);
		});

		it('refreshes stale workbench data while preserving the selected file', async () => {
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root: [makeTreeFile('a.ts')],
						workbenchFingerprint: 'v1:old',
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root: [makeTreeFile('a.ts')],
						workbenchFingerprint: 'v1:new',
					}),
				);

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			wb.markExternallyStale();
			mockedApi.getGitWorkbenchSnapshot.mockClear();

			await wb.refreshStaleWorkbench();

			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledWith(
				'/project',
				'unstaged',
				5,
				expect.objectContaining({
					selectedFile: 'a.ts',
					bodyCandidateCount: 8,
				}),
			);
			expect(wb.loadedWorkbenchFingerprint).toBe('v1:new');
			expect(wb.isExternallyStale).toBe(false);
		});

		it('surfaces unexpected snapshot load failures', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockRejectedValue(new Error('network error'));

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.files.tree).toEqual([]);
			expect(wb.lastError).toContain('network error');
			expect(wb.repositoryError).toBeNull();
			expect(wb.isInitialLoadPending).toBe(false);
		});
	});

	describe('virtual review document', () => {
		it('loads visible file bodies with the active tab and document id', async () => {
			mockedApi.getGitReviewFileBodies.mockResolvedValue({
				documentId: 'doc',
				files: { 'a.ts': makeReviewBody('a.ts', 'loaded') },
				errors: {},
			});
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}),
			);
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			await vi.waitFor(() => {
				expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalled();
			});

			wb.review.requestBodies('/project', ['a.ts']);

			await vi.waitFor(() => {
				expect(mockedApi.getGitReviewFileBodies).toHaveBeenCalledWith(
					'/project',
					'doc',
					['a.ts'],
					'unstaged',
					5,
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});
			await vi.waitFor(() => {
				expect(wb.review.virtualRows.some((row) => row.kind === 'unified-row')).toBe(true);
			});
		});

		it('ignores aborted body loads after tab changes', async () => {
			const staleBodyLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitReviewFileBodies>>>();
			const root = [
				{
					...makeTreeFile('a.ts'),
					staged: true,
					stagedFacet: {
						status: 'M' as const,
						changeKind: 'modified' as const,
						stats: { additions: 1, deletions: 0 },
					},
				},
			];
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root,
						summary: makeReviewSummary(['a.ts'], { documentId: 'working-doc', mode: 'working' }),
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root,
						summary: makeReviewSummary(['a.ts'], { documentId: 'staged-doc', mode: 'staged' }),
					}),
				);
			mockedApi.getGitReviewFileBodies
				.mockReturnValueOnce(staleBodyLoad.promise)
				.mockResolvedValueOnce({
					documentId: 'staged-doc',
					files: { 'a.ts': makeReviewBody('a.ts', 'new') },
					errors: {},
				});
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(1));
			wb.review.requestBodies('/project', ['a.ts']);
			wb.setActiveTab('staged');
			await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2));
			wb.review.requestBodies('/project', ['a.ts']);

			const abortError = new Error('aborted');
			abortError.name = 'AbortError';
			staleBodyLoad.reject(abortError);

			await vi.waitFor(() => {
				expect(
					wb.review.virtualRows.some(
						(row) => row.kind === 'unified-row' && row.view.text === 'new',
					),
				).toBe(true);
			});
			expect(
				wb.review.virtualRows.some((row) => row.kind === 'unified-row' && row.view.text === 'old'),
			).toBe(false);
		});

		it('does not preload file bodies when tree visibility changes', () => {
			wb.files.applyTree(
				Array.from({ length: 25 }, (_, index) => makeTreeFile(`file-${index}.ts`)) as any,
			);

			expect(wb.files.visibleFilePaths).toHaveLength(25);
			expect(mockedApi.getGitReviewFileBodies).not.toHaveBeenCalled();
		});

		it('setContextLines clears loaded rows and requests a new snapshot', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}),
			);
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(1));
			wb.review.requestBodies('/project', ['a.ts']);
			await vi.waitFor(() => expect(mockedApi.getGitReviewFileBodies).toHaveBeenCalled());

			wb.setContextLines(10);

			expect(wb.review.contextLines).toBe(10);
			expect(wb.review.virtualRows.some((row) => row.kind === 'unified-row')).toBe(false);
			await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2));
		});
	});

	describe('line selection', () => {
		it('toggles line selection', () => {
			const key = makeLineSelectionKey('a.ts', 'unstaged', 'before', 0);
			wb.selection.toggleLineSelection(key);

			expect(wb.selection.selectedLineKeys.has(key)).toBe(true);
			expect(wb.selection.hasSelection).toBe(true);

			wb.selection.toggleLineSelection(key);

			expect(wb.selection.selectedLineKeys.has(key)).toBe(false);
			expect(wb.selection.hasSelection).toBe(false);
		});

		it('selects line range', () => {
			const first = makeLineSelectionKey('a.ts', 'unstaged', 'before', 0);
			const second = makeLineSelectionKey('a.ts', 'unstaged', 'after', 1);
			const third = makeLineSelectionKey('a.ts', 'unstaged', 'before', 2);
			const fourth = makeLineSelectionKey('a.ts', 'unstaged', 'after', 3);
			const allKeys = [first, second, third, fourth];

			wb.selection.selectLineRange(first, third, allKeys);

			expect(wb.selection.selectedLineKeys.size).toBe(3);
			expect(wb.selection.selectedLineKeys.has(first)).toBe(true);
			expect(wb.selection.selectedLineKeys.has(second)).toBe(true);
			expect(wb.selection.selectedLineKeys.has(third)).toBe(true);
		});

		it('clears selection', () => {
			wb.selection.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			wb.selection.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'after', 1));

			wb.selection.clearSelection();

			expect(wb.selection.hasSelection).toBe(false);
		});
	});

	describe('staging', () => {
		it('stages selected lines and refreshes', async () => {
			mockedApi.gitStageSelection.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			wb.files.selectedFile = 'a.ts';
			wb.selection.selectedLineKeys = new Set([
				makeLineSelectionKey('a.ts', 'unstaged', 'before', 0),
				makeLineSelectionKey('a.ts', 'unstaged', 'after', 1),
			]);
			mockedApi.getGitWorkbenchSnapshot.mockClear();

			const result = await wb.staging.stageSelectedLines('/project');

			expect(result).toBe(true);
			expect(wb.selection.selectedLineKeys.size).toBe(0);
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalled();
		});

		it('blocks diff-coordinate staging while the workbench is stale', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot());
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			wb.markExternallyStale();

			const result = await wb.staging.stageHunk(
				'/project',
				{ filePath: 'a.ts', tab: 'unstaged', mode: 'stage', contextLines: 5 },
				0,
			);

			expect(result).toBe(false);
			expect(mockedApi.gitStageHunk).not.toHaveBeenCalled();
			expect(wb.lastError).toBe('Refresh the Git workbench before modifying changes.');
		});

		it('stages entire file for untracked files', async () => {
			mockedApi.gitStagePaths.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.staging.stageFile('/project', 'new-file.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['new-file.ts'], 'stage');
		});

		it('advances selection after staging the selected file out of the active tab', async () => {
			mockedApi.gitStagePaths.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root: [
							{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
							{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						] as GitTreeNode[],
						summary: makeReviewSummary(['a.ts', 'b.ts']),
					}),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({
						root: [
							{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
							{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						] as GitTreeNode[],
						summary: makeReviewSummary(['b.ts']),
					}),
				);
			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			expect(wb.files.selectedFile).toBe('a.ts');

			const result = await wb.staging.stageFile('/project', 'a.ts');

			expect(result).toBe(true);
			expect(wb.files.selectedFile).toBe('b.ts');
			expect(mockedApi.getGitReviewFileBodies).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				['b.ts'],
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
		});

		it('unstages entire file', async () => {
			mockedApi.gitStagePaths.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.staging.unstageFile('/project', 'a.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['a.ts'], 'unstage');
		});

		it('stages an entire directory with one path batch', async () => {
			mockedApi.gitStagePaths.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.staging.stageDirectory('/project', 'src');

			expect(result).toBe(true);
			expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['src'], 'stage');
		});

		it('unstages an entire directory with one path batch', async () => {
			mockedApi.gitStagePaths.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.staging.unstageDirectory('/project', 'src');

			expect(result).toBe(true);
			expect(mockedApi.gitStagePaths).toHaveBeenCalledWith('/project', ['src'], 'unstage');
		});
	});

	describe('commit workflow', () => {
		it('commits index and clears message', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.commit.commitMessage = 'feat: add login';
			mockedApi.gitCommitIndex.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.commit.commitIndex('/project');

			expect(result).toBe(true);
			expect(wb.commit.commitMessage).toBe('');
			expect(wb.commit.isCommitting).toBe(false);
		});

		it('does not commit when message is empty', async () => {
			wb.commit.commitMessage = '';

			const result = await wb.commit.commitIndex('/project');

			expect(result).toBe(false);
			expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();
		});

		it('surfaces error on commit failure', async () => {
			wb.commit.commitMessage = 'test';
			mockedApi.gitCommitIndex.mockRejectedValue(new Error('nothing staged'));

			const result = await wb.commit.commitIndex('/project');

			expect(result).toBe(false);
			expect(wb.lastError).toContain('nothing staged');
		});

		it('creates initial commit', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.files.hasCommits = false;
			mockedApi.gitInitialCommit.mockResolvedValue({ success: true });
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({ root: [], hasCommits: true }),
			);

			const result = await wb.commit.createInitialCommit('/project');

			expect(result).toBe(true);
			expect(wb.files.hasCommits).toBe(true);
		});

		it('does not apply a completed commit continuation to a new target', async () => {
			const commit = deferred<Awaited<ReturnType<typeof gitApi.gitCommitIndex>>>();
			mockedApi.getGitWorkbenchSnapshot
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({ root: [makeTreeFile('a.ts')], workbenchFingerprint: 'a' }),
				)
				.mockResolvedValueOnce(
					makeWorkbenchSnapshot({ root: [makeTreeFile('b.ts')], workbenchFingerprint: 'b' }),
				);
			mockedApi.gitCommitIndex.mockReturnValueOnce(commit.promise);

			await wb.setTarget(makeTarget('/project-a'));
			wb.commit.commitMessage = 'commit A';
			const pending = wb.commit.commitIndex('/project-a');
			await vi.waitFor(() => expect(mockedApi.gitCommitIndex).toHaveBeenCalledTimes(1));

			await wb.setTarget(makeTarget('/project-b'));
			wb.commit.commitMessage = 'draft B';
			mockedApi.getGitWorkbenchSnapshot.mockClear();
			commit.resolve({ success: true });

			await expect(pending).resolves.toBe(true);
			expect(wb.projectPath).toBe('/project-b');
			expect(wb.commit.commitMessage).toBe('draft B');
			expect(wb.files.selectedFile).toBe('b.ts');
			expect(mockedApi.getGitWorkbenchSnapshot).not.toHaveBeenCalled();
		});

		it('generates commit message from staged files', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.files.applyTree([
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any);
			mockedApi.generateCommitMessage.mockResolvedValue({ message: 'feat: auto-generated' });

			await wb.commit.generateCommitMsg('/project');

			expect(wb.commit.commitMessage).toBe('feat: auto-generated');
			expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project', ['staged.ts']);
			expect(wb.commit.isGeneratingMessage).toBe(false);
		});

		it('does not publish a generated message into a newly selected project', async () => {
			const generated = deferred<{ message: string }>();
			mockedApi.generateCommitMessage.mockReturnValueOnce(generated.promise);
			await wb.setTarget(makeTarget('/project-a'));
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any);

			const generation = wb.commit.generateCommitMsg('/project-a');
			await vi.waitFor(() =>
				expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project-a', ['a.ts']),
			);
			await wb.setTarget(makeTarget('/project-b'));
			wb.commit.commitMessage = 'draft B';
			generated.resolve({ message: 'message for project A' });
			await generation;

			expect(wb.commit.commitMessage).toBe('draft B');
			expect(wb.commit.isGeneratingMessage).toBe(false);
		});

		it('uses the server-returned generated message as-is', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.files.applyTree([
				{ path: 'feature/auth/a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'feature/auth/b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any);
			mockedApi.generateCommitMessage.mockResolvedValue({
				message: 'feature/auth: feat: auto-generated',
				directoryPrefix: 'feature/auth',
			});

			await wb.commit.generateCommitMsg('/project');

			expect(wb.commit.commitMessage).toBe('feature/auth: feat: auto-generated');
			expect(mockedApi.generateCommitMessage).toHaveBeenCalledWith('/project', [
				'feature/auth/a.ts',
				'feature/auth/b.ts',
			]);
		});

		it('surfaces error when no staged files for message generation', async () => {
			wb.files.applyTree([]);

			await wb.commit.generateCommitMsg('/project');

			expect(wb.lastError).toContain('No staged files');
		});

		it('maps typed commit generation errorCode to localized message', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.files.applyTree([
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any);
			mockedApi.generateCommitMessage.mockRejectedValue(
				new ApiError(504, 'Timed out', 'commit_message_timeout'),
			);

			await wb.commit.generateCommitMsg('/project');

			expect(wb.lastError).toContain('timed out');
		});
	});

	describe('derived getters', () => {
		it('stagedFiles collects staged file paths', () => {
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: true,
					hasUnstaged: false,
					children: [
						{ path: 'src/c.ts', name: 'c.ts', kind: 'file', staged: true, hasUnstaged: false },
					],
				},
			] as any);

			expect(wb.files.stagedFiles).toEqual(['a.ts', 'src/c.ts']);
		});

		it('filteredTree filters by search query', () => {
			wb.files.applyTree([
				{ path: 'auth.ts', name: 'auth.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'utils.ts', name: 'utils.ts', kind: 'file', staged: false, hasUnstaged: true },
			] as any);
			wb.files.treeSearchQuery = 'auth';

			expect(wb.files.filteredTree).toHaveLength(1);
			expect(wb.files.filteredTree[0].path).toBe('auth.ts');
		});

		it('shows generated files by default and hides them only when requested', () => {
			wb.files.applyTree([
				{
					path: 'src/generated/api.ts',
					name: 'api.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: true,
					category: 'generated',
				},
				{
					path: 'src/app.ts',
					name: 'app.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: true,
					category: 'normal',
				},
			] as any);

			expect(wb.files.hideGenerated).toBe(false);
			expect(wb.files.visibleFilePaths).toEqual(['src/generated/api.ts', 'src/app.ts']);

			wb.setHideGenerated(true);

			expect(wb.files.visibleFilePaths).toEqual(['src/app.ts']);
		});

		it('filters the file tree to the active tab when hiding opposite-tab files', () => {
			wb.files.applyTree([
				{
					path: 'staged-only.ts',
					name: 'staged-only.ts',
					kind: 'file',
					staged: true,
					hasUnstaged: false,
				},
				{
					path: 'unstaged-only.ts',
					name: 'unstaged-only.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: true,
				},
				{
					path: 'mixed.ts',
					name: 'mixed.ts',
					kind: 'file',
					staged: true,
					hasUnstaged: true,
				},
				{
					path: 'untracked.ts',
					name: 'untracked.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: false,
					changeKind: 'untracked',
				},
			] as any);

			expect(wb.files.hideOtherTabFiles).toBe(false);
			expect(wb.files.filteredTree.map((node) => node.path)).toEqual([
				'staged-only.ts',
				'unstaged-only.ts',
				'mixed.ts',
				'untracked.ts',
			]);

			wb.setHideOtherTabFiles(true);

			expect(wb.files.hideOtherTabFilesLabel).toBe('Hide staged');
			expect(wb.files.filteredTree.map((node) => node.path)).toEqual([
				'unstaged-only.ts',
				'mixed.ts',
				'untracked.ts',
			]);

			wb.setActiveTab('staged');

			expect(wb.files.hideOtherTabFilesLabel).toBe('Hide unstaged');
			expect(wb.files.filteredTree.map((node) => node.path)).toEqual([
				'staged-only.ts',
				'mixed.ts',
			]);
		});

		it('recomputes visible directory flags when hiding opposite-tab files', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: true,
					hasUnstaged: true,
					children: [
						{
							path: 'src/staged.ts',
							name: 'staged.ts',
							kind: 'file',
							staged: true,
							hasUnstaged: false,
						},
						{
							path: 'src/unstaged.ts',
							name: 'unstaged.ts',
							kind: 'file',
							staged: false,
							hasUnstaged: true,
						},
					],
				},
			] as any);

			wb.setHideOtherTabFiles(true);

			expect(wb.files.filteredTree[0]).toMatchObject({
				path: 'src',
				staged: false,
				hasUnstaged: true,
			});
			expect(wb.files.filteredTree[0].children?.map((node) => node.path)).toEqual([
				'src/unstaged.ts',
			]);

			wb.setActiveTab('staged');

			expect(wb.files.filteredTree[0]).toMatchObject({
				path: 'src',
				staged: true,
				hasUnstaged: false,
			});
			expect(wb.files.filteredTree[0].children?.map((node) => node.path)).toEqual([
				'src/staged.ts',
			]);
		});

		it('totalChangedFiles counts files recursively', () => {
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: false,
					hasUnstaged: true,
					children: [
						{ path: 'src/b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						{ path: 'src/c.ts', name: 'c.ts', kind: 'file', staged: false, hasUnstaged: true },
					],
				},
			] as any);

			expect(wb.files.totalChangedFiles).toBe(3);
		});
	});

	describe('compact folders', () => {
		it('collapses single-child directory chains', () => {
			wb.files.applyTree([
				{
					path: 'a',
					name: 'a',
					kind: 'directory',
					staged: false,
					hasUnstaged: true,
					children: [
						{
							path: 'a/b',
							name: 'b',
							kind: 'directory',
							staged: false,
							hasUnstaged: true,
							children: [
								{
									path: 'a/b/c',
									name: 'c',
									kind: 'directory',
									staged: false,
									hasUnstaged: true,
									children: [
										{
											path: 'a/b/c/file.ts',
											name: 'file.ts',
											kind: 'file',
											staged: false,
											hasUnstaged: true,
										},
									],
								},
							],
						},
					],
				},
			] as any);

			const result = wb.files.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('a/b/c');
			expect(result[0].path).toBe('a/b/c');
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children![0].name).toBe('file.ts');
		});

		it('stops compacting when directory has multiple children', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: false,
					hasUnstaged: true,
					children: [
						{
							path: 'src/lib',
							name: 'lib',
							kind: 'directory',
							staged: false,
							hasUnstaged: true,
							children: [
								{
									path: 'src/lib/a.ts',
									name: 'a.ts',
									kind: 'file',
									staged: false,
									hasUnstaged: true,
								},
								{
									path: 'src/lib/b.ts',
									name: 'b.ts',
									kind: 'file',
									staged: false,
									hasUnstaged: true,
								},
							],
						},
					],
				},
			] as any);

			const result = wb.files.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src/lib');
			expect(result[0].children).toHaveLength(2);
		});

		it('does not compact directory with a single file child', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: false,
					hasUnstaged: true,
					children: [
						{
							path: 'src/index.ts',
							name: 'index.ts',
							kind: 'file',
							staged: false,
							hasUnstaged: true,
						},
					],
				},
			] as any);

			const result = wb.files.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src');
			expect(result[0].children).toHaveLength(1);
		});

		it('preserves staged/hasUnstaged flags through compaction', () => {
			wb.files.applyTree([
				{
					path: 'a',
					name: 'a',
					kind: 'directory',
					staged: true,
					hasUnstaged: false,
					children: [
						{
							path: 'a/b',
							name: 'b',
							kind: 'directory',
							staged: false,
							hasUnstaged: true,
							children: [
								{
									path: 'a/b/file.ts',
									name: 'file.ts',
									kind: 'file',
									staged: true,
									hasUnstaged: true,
								},
							],
						},
					],
				},
			] as any);

			const result = wb.files.filteredTree;
			expect(result[0].staged).toBe(true);
			expect(result[0].hasUnstaged).toBe(true);
		});
	});

	describe('review comments', () => {
		it('adds, updates, and removes draft comments', () => {
			wb.drafts.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 10,
				body: 'Needs refactoring',
				severity: 'warning',
			});

			expect(wb.drafts.reviewComments).toHaveLength(1);
			const id = wb.drafts.reviewComments[0].id;
			expect(wb.drafts.reviewComments[0].body).toBe('Needs refactoring');

			wb.drafts.updateDraftComment(id, { body: 'Updated comment' });
			expect(wb.drafts.reviewComments[0].body).toBe('Updated comment');

			wb.drafts.removeDraftComment(id);
			expect(wb.drafts.reviewComments).toHaveLength(0);
		});

		it('groups comments by file', () => {
			wb.drafts.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 1,
				body: 'one',
				severity: 'note',
			});
			wb.drafts.addDraftComment({
				filePath: 'b.ts',
				side: 'after',
				line: 2,
				body: 'two',
				severity: 'note',
			});
			wb.drafts.addDraftComment({
				filePath: 'a.ts',
				side: 'before',
				line: 5,
				body: 'three',
				severity: 'blocker',
			});

			const grouped = wb.drafts.commentsByFile;
			expect(Object.keys(grouped)).toEqual(['a.ts', 'b.ts']);
			expect(grouped['a.ts']).toHaveLength(2);
			expect(grouped['b.ts']).toHaveLength(1);
		});

		it('builds finalized review message', () => {
			wb.drafts.reviewSummary = 'Overall good';
			wb.drafts.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 10,
				body: 'Fix this',
				severity: 'warning',
			});

			const msg = wb.drafts.buildFinalizedReviewMessage();

			expect(msg).toContain('Summary:');
			expect(msg).toContain('Overall good');
			expect(msg).toContain('[warning] a.ts:10');
			expect(msg).toContain('Fix this');
		});

		it('finalizeReviewToAgent calls send and clears on success', async () => {
			wb.drafts.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 1,
				body: 'test',
				severity: 'note',
			});
			wb.drafts.reviewSummary = 'summary';
			const send = vi.fn().mockResolvedValue(true);

			const result = await wb.drafts.finalizeReviewToAgent(send);

			expect(result).toBe(true);
			expect(send).toHaveBeenCalledOnce();
			expect(wb.drafts.reviewComments).toHaveLength(0);
			expect(wb.drafts.reviewSummary).toBe('');
		});
	});

	describe('tree pane width', () => {
		it('defaults to 300px', () => {
			expect(wb.files.treePaneWidthPx).toBe(300);
		});

		it('clamps width to bounds [220, 560]', () => {
			wb.files.setTreePaneWidth(100);
			expect(wb.files.treePaneWidthPx).toBe(220);

			wb.files.setTreePaneWidth(1000);
			expect(wb.files.treePaneWidthPx).toBe(560);
		});

		it('rounds to integer', () => {
			wb.files.setTreePaneWidth(333.7);
			expect(wb.files.treePaneWidthPx).toBe(334);
		});

		it('persists to localStorage', () => {
			const spy = vi.spyOn(localStorage, 'setItem');
			wb.files.setTreePaneWidth(400);
			expect(spy).toHaveBeenCalledWith(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx, '400');
		});

		it('loads from localStorage', () => {
			vi.spyOn(localStorage, 'getItem').mockReturnValue('350');
			wb.files.loadTreePaneWidth();
			expect(wb.files.treePaneWidthPx).toBe(350);
		});

		it('ignores invalid localStorage value', () => {
			vi.spyOn(localStorage, 'getItem').mockReturnValue('notanumber');
			wb.files.treePaneWidthPx = 300;
			wb.files.loadTreePaneWidth();
			expect(wb.files.treePaneWidthPx).toBe(300);
		});
	});

	describe('activeTab', () => {
		it('defaults to unstaged', () => {
			expect(wb.files.activeTab).toBe('unstaged');
		});

		it('setActiveTab switches tab and clears selection', () => {
			wb.selection.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			expect(wb.selection.hasSelection).toBe(true);

			wb.setActiveTab('staged');

			expect(wb.files.activeTab).toBe('staged');
			expect(wb.selection.hasSelection).toBe(false);
		});

		it('setActiveTab is no-op when same tab', () => {
			wb.selection.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			wb.setActiveTab('unstaged');

			expect(wb.selection.hasSelection).toBe(true);
		});

		it('unstagedFileCount counts files with hasUnstaged or untracked', () => {
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
				{
					path: 'c.ts',
					name: 'c.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: false,
					changeKind: 'untracked',
				},
			] as any);

			expect(wb.files.unstagedFileCount()).toBe(2);
		});

		it('stagedFileCount counts files with staged flag', () => {
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'c.ts', name: 'c.ts', kind: 'file', staged: true, hasUnstaged: true },
			] as any);

			expect(wb.files.stagedFileCount()).toBe(2);
		});
	});

	describe('tree selection scroll targets', () => {
		it('finds the first visible file for a selected directory in unstaged tab', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: false,
					hasUnstaged: true,
					children: [
						{ path: 'src/a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
						{ path: 'src/b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
					],
				},
				{ path: 'README.md', name: 'README.md', kind: 'file', staged: false, hasUnstaged: true },
			] as any);
			wb.setActiveTab('unstaged');

			expect(wb.files.firstVisibleFileInDirectory('src')).toBe('src/a.ts');
		});

		it('finds the first visible file for a selected directory in staged tab', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: true,
					hasUnstaged: true,
					children: [
						{ path: 'src/a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
						{ path: 'src/b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
					],
				},
			] as any);
			wb.setActiveTab('staged');

			expect(wb.files.firstVisibleFileInDirectory('src')).toBe('src/b.ts');
		});

		it('returns null when directory has no visible files for active tab', () => {
			wb.files.applyTree([
				{
					path: 'src',
					name: 'src',
					kind: 'directory',
					staged: false,
					hasUnstaged: false,
					children: [
						{ path: 'src/a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: false },
					],
				},
			] as any);
			wb.setActiveTab('staged');

			expect(wb.files.firstVisibleFileInDirectory('src')).toBeNull();
		});

		it('creates unique scroll requests for repeated file selections', () => {
			wb.review.requestScrollToFile('src/a.ts');
			const first = wb.review.scrollRequest;
			wb.review.requestScrollToFile('src/a.ts');
			const second = wb.review.scrollRequest;

			expect(first?.filePath).toBe('src/a.ts');
			expect(second?.filePath).toBe('src/a.ts');
			expect(second?.token).toBeGreaterThan(first?.token ?? 0);
		});

		it('switches to staged tab when selecting a staged-only file', async () => {
			await wb.setTarget(makeTarget('/project'));
			const stagedTree = [
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({ root: stagedTree }),
			);
			wb.files.applyTree(stagedTree);
			wb.setActiveTab('unstaged');

			await wb.selectFile('/project', 'staged.ts');

			expect(wb.files.activeTab).toBe('staged');
			expect(wb.files.selectedFile).toBe('staged.ts');
			expect(wb.review.scrollRequest?.filePath).toBe('staged.ts');
		});

		it('ignores a stale file selection after the target changes', async () => {
			await wb.setTarget(makeTarget('/project'));
			wb.files.applyTree([
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any);
			wb.setActiveTab('unstaged');
			const selectedBefore = wb.files.selectedFile;
			const scrollBefore = wb.review.scrollRequest;

			await wb.selectFile('/previous-project', 'staged.ts');

			expect(wb.files.activeTab).toBe('unstaged');
			expect(wb.files.selectedFile).toBe(selectedBefore);
			expect(wb.review.scrollRequest).toBe(scrollBefore);
		});
	});

	describe('target refresh lifecycle', () => {
		it('selects the first file from the snapshot and starts selected body loading', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}),
			);

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.files.selectedFile).toBe('a.ts');
			expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalled();
			await vi.waitFor(() => {
				expect(mockedApi.getGitReviewFileBodies).toHaveBeenCalledWith(
					'/project',
					'doc',
					['a.ts'],
					'unstaged',
					5,
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});
		});

		it('does not reload when target discovery canonicalizes a subdirectory worktree', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					project: '/repo/subdir',
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts'], { project: '/repo/subdir' }),
				}),
			);

			await wb.setTarget({
				projectPath: '/repo/subdir',
				repoRoot: '/repo/subdir',
				worktreePath: '/repo/subdir',
				label: 'subdir',
				source: 'chat-project',
			});
			wb.commit.commitMessage = 'feat: preserve draft';
			mockedApi.getGitWorkbenchSnapshot.mockClear();

			await wb.setTarget({
				projectPath: '/repo/subdir',
				repoRoot: '/repo',
				worktreePath: '/repo',
				label: 'subdir',
				source: 'chat-project',
			});

			expect(mockedApi.getGitWorkbenchSnapshot).not.toHaveBeenCalled();
			expect(wb.target?.worktreePath).toBe('/repo');
			expect(wb.files.selectedFile).toBe('a.ts');
			expect(wb.commit.commitMessage).toBe('feat: preserve draft');
		});

		it('logs first-load timing when the workbench trace flag is enabled', async () => {
			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
				key === 'garcon.gitWorkbenchTrace' ? '1' : 'claude',
			);
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
				}),
			);

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(debugSpy).toHaveBeenCalledWith(
				'git workbench load',
				expect.objectContaining({
					reason: 'mount',
					snapshotMs: expect.any(Number),
					firstRenderableMs: expect.any(Number),
				}),
			);
		});

		it('preserves commit draft on same-target refresh', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(
				makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
				}),
			);

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			wb.commit.commitMessage = 'feat: keep draft';

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.commit.commitMessage).toBe('feat: keep draft');
		});

		it('clears commit draft when target changes', async () => {
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			await wb.setTarget({
				projectPath: '/project-a',
				repoRoot: '/repo',
				worktreePath: '/project-a',
				label: 'a',
				source: 'worktree',
			});
			wb.commit.commitMessage = 'feat: old target';

			await wb.setTarget({
				projectPath: '/project-b',
				repoRoot: '/repo',
				worktreePath: '/project-b',
				label: 'b',
				source: 'worktree',
			});

			expect(wb.commit.commitMessage).toBe('');
		});
	});

	describe('porcelain inspector', () => {
		it('aborts and ignores stale history loads when the selected file changes', async () => {
			const firstHistory = deferred<Awaited<ReturnType<typeof gitApi.getGitFileHistory>>>();
			const firstBlame = deferred<Awaited<ReturnType<typeof gitApi.getGitBlame>>>();
			const secondHistory = deferred<Awaited<ReturnType<typeof gitApi.getGitFileHistory>>>();
			const secondBlame = deferred<Awaited<ReturnType<typeof gitApi.getGitBlame>>>();
			const oldCommit = {
				hash: 'old',
				author: 'A',
				email: 'a@example.com',
				date: '2026-01-01',
				subject: 'old file',
			};
			const nextCommit = {
				hash: 'new',
				author: 'B',
				email: 'b@example.com',
				date: '2026-01-02',
				subject: 'new file',
			};
			const oldLine = {
				line: 1,
				originalLine: 1,
				finalLine: 1,
				commit: 'old',
				author: 'A',
				authorMail: 'a@example.com',
				authorTime: '2026-01-01T00:00:00.000Z',
				summary: 'old',
				content: 'old',
			};
			const nextLine = {
				...oldLine,
				commit: 'new',
				author: 'B',
				authorMail: 'b@example.com',
				summary: 'new',
				content: 'new',
			};
			mockedApi.getGitFileHistory
				.mockReturnValueOnce(firstHistory.promise)
				.mockReturnValueOnce(secondHistory.promise);
			mockedApi.getGitBlame
				.mockReturnValueOnce(firstBlame.promise)
				.mockReturnValueOnce(secondBlame.promise);

			wb.files.selectedFile = 'a.ts';
			wb.porcelain.setInspectorView('history');
			const firstLoad = wb.porcelain.loadCurrentView('/project');
			const firstOptions = mockedApi.getGitFileHistory.mock.calls[0]?.[3] as RequestInit;

			wb.files.selectedFile = 'b.ts';
			const secondLoad = wb.porcelain.loadCurrentView('/project');
			const secondOptions = mockedApi.getGitFileHistory.mock.calls[1]?.[3] as RequestInit;

			expect(firstOptions.signal).toBeInstanceOf(AbortSignal);
			expect(firstOptions.signal?.aborted).toBe(true);
			expect(secondOptions.signal).toBeInstanceOf(AbortSignal);
			expect(secondOptions.signal?.aborted).toBe(false);

			secondHistory.resolve({ commits: [nextCommit] });
			secondBlame.resolve({ lines: [nextLine], truncated: false });
			await secondLoad;

			firstHistory.resolve({ commits: [oldCommit] });
			firstBlame.resolve({ lines: [oldLine], truncated: false });
			await firstLoad;

			expect(wb.porcelain.fileHistory).toEqual([nextCommit]);
			expect(wb.porcelain.blameLines).toEqual([nextLine]);
			expect(wb.porcelain.isLoading).toBe(false);
		});
	});

	describe('reset', () => {
		it('clears all state including activeTab', () => {
			wb.files.applyTree([
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
			] as any);
			wb.files.selectedFile = 'a.ts';
			wb.commit.commitMessage = 'test';
			wb.setActiveTab('staged');

			wb.reset();

			expect(wb.files.tree).toEqual([]);
			expect(wb.files.selectedFile).toBeNull();
			expect(wb.commit.commitMessage).toBe('');
			expect(wb.files.hasCommits).toBe(true);
			expect(wb.lastError).toBeNull();
			expect(wb.files.activeTab).toBe('unstaged');
		});
	});

	describe('error feedback', () => {
		it('dismissError clears the error', () => {
			wb.commit.commitMessage = 'test';
			// Trigger an error manually via the public method
			mockedApi.gitCommitIndex.mockRejectedValue(new Error('fail'));

			// After error, dismissError should clear
			wb.dismissError();
			expect(wb.lastError).toBeNull();
		});
	});
});
