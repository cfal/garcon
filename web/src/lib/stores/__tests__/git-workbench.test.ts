import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GitWorkbenchStore,
	makeLineSelectionKey,
	type GitWorkbenchDeps,
} from '../git-workbench.svelte';
import type {
	GitReviewDocumentSummary,
	GitReviewFileBody,
	GitReviewFileSummary,
	GitTreeNode,
	GitWorkbenchSnapshotResponse,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

const mockDeps: GitWorkbenchDeps = {
	getSettings: vi.fn().mockResolvedValue({ ui: {} }),
};

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
	gitStageFile: vi.fn(),
	gitCommitIndex: vi.fn(),
	gitInitialCommit: vi.fn(),
	generateCommitMessage: vi.fn(),
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
	gitRemoveWorktree: vi.fn(),
	gitRevertLastCommit: vi.fn(),
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
	const filePaths = root
		.filter((node) => node.kind === 'file')
		.map((node) => node.path);
	const reviewSummary = summary ?? makeReviewSummary(filePaths.length > 0 ? filePaths : ['a.ts'], { project });
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

describe('GitWorkbenchStore', () => {
	let wb: GitWorkbenchStore;

		beforeEach(() => {
			wb = new GitWorkbenchStore(mockDeps);
			vi.clearAllMocks();
			mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot());
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

				expect(wb.tree).toEqual(tree);
				expect(wb.hasCommits).toBe(true);
				expect(wb.selectedFile).toBe('a.ts');
				expect(wb.isLoadingTree).toBe(false);
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
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						project: '/project-b',
						root: currentTree,
						hasCommits: false,
					}));

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
				staleSnapshot.resolve(makeWorkbenchSnapshot({
					project: '/project-a',
					root: [makeTreeFile('old.ts')],
				}));
				await Promise.all([staleTarget, currentTarget]);

				expect(wb.target?.projectPath).toBe('/project-b');
				expect(wb.tree).toEqual(currentTree);
				expect(wb.hasCommits).toBe(false);
				expect(wb.isLoadingTree).toBe(false);
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
				expect(wb.tree).toEqual([]);
				expect(wb.virtualReviewRows).toEqual([]);
				expect(wb.loadedWorkbenchFingerprint).toBeNull();
				expect(wb.isExternallyStale).toBe(false);
				expect(mockedApi.getGitReviewFileBodies).not.toHaveBeenCalled();
			});

			it('stores the ready snapshot fingerprint as the freshness baseline', async () => {
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}));

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
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}));
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
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					workbenchFingerprint: 'v1:loaded',
				}));
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
				const staleFingerprint = deferred<Awaited<ReturnType<typeof gitApi.getGitWorkbenchFingerprint>>>();
				mockedApi.getGitWorkbenchSnapshot
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						project: '/project-a',
						workbenchFingerprint: 'v1:a',
					}))
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						project: '/project-b',
						workbenchFingerprint: 'v1:b',
					}));
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

			it('refreshes stale workbench data while preserving the selected file', async () => {
				mockedApi.getGitWorkbenchSnapshot
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root: [makeTreeFile('a.ts')],
						workbenchFingerprint: 'v1:old',
					}))
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root: [makeTreeFile('a.ts')],
						workbenchFingerprint: 'v1:new',
					}));

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

				expect(wb.tree).toEqual([]);
				expect(wb.lastError).toContain('network error');
				expect(wb.repositoryError).toBeNull();
			});
		});

		describe('virtual review document', () => {
			it('loads visible file bodies with the active tab and document id', async () => {
				mockedApi.getGitReviewFileBodies.mockResolvedValue({
					documentId: 'doc',
					files: { 'a.ts': makeReviewBody('a.ts', 'loaded') },
					errors: {},
				});
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}));
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

				wb.requestFilesLoaded('/project', ['a.ts']);

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
				expect(wb.virtualReviewRows.some((row) => row.kind === 'unified-row')).toBe(true);
			});
		});

			it('ignores aborted body loads after tab changes', async () => {
				const staleBodyLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitReviewFileBodies>>>();
				const root = [{
					...makeTreeFile('a.ts'),
					staged: true,
					stagedFacet: { status: 'M' as const, changeKind: 'modified' as const, stats: { additions: 1, deletions: 0 } },
				}];
				mockedApi.getGitWorkbenchSnapshot
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root,
						summary: makeReviewSummary(['a.ts'], { documentId: 'working-doc', mode: 'working' }),
					}))
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root,
						summary: makeReviewSummary(['a.ts'], { documentId: 'staged-doc', mode: 'staged' }),
					}));
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
				wb.requestFilesLoaded('/project', ['a.ts']);
				wb.setActiveTab('staged');
				await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2));
				wb.requestFilesLoaded('/project', ['a.ts']);

				const abortError = new Error('aborted');
				abortError.name = 'AbortError';
				staleBodyLoad.reject(abortError);

			await vi.waitFor(() => {
				expect(wb.virtualReviewRows.some((row) => row.kind === 'unified-row' && row.view.text === 'new')).toBe(true);
			});
			expect(wb.virtualReviewRows.some((row) => row.kind === 'unified-row' && row.view.text === 'old')).toBe(false);
		});

		it('does not preload file bodies when tree visibility changes', () => {
			wb.tree = Array.from({ length: 25 }, (_, index) => makeTreeFile(`file-${index}.ts`)) as any;

			expect(wb.visibleFilePaths).toHaveLength(25);
			expect(mockedApi.getGitReviewFileBodies).not.toHaveBeenCalled();
		});

			it('setContextLines clears loaded rows and requests a new snapshot', async () => {
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}));
				await wb.setTarget({
					projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
					label: 'project',
					source: 'chat-project',
				});
				await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(1));
				wb.requestFilesLoaded('/project', ['a.ts']);
				await vi.waitFor(() => expect(mockedApi.getGitReviewFileBodies).toHaveBeenCalled());

			wb.setContextLines(10);

				expect(wb.contextLines).toBe(10);
				expect(wb.virtualReviewRows.some((row) => row.kind === 'unified-row')).toBe(false);
				await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2));
			});
	});

	describe('review progress', () => {
		function setSingleModifiedFile(): void {
			wb.tree = [
				{
					path: 'a.ts',
					name: 'a.ts',
					kind: 'file',
					staged: false,
					hasUnstaged: true,
					indexStatus: ' ',
					workTreeStatus: 'M',
					changeKind: 'modified',
					unstagedFacet: {
						status: 'M',
						changeKind: 'modified',
						stats: { additions: 1, deletions: 0 },
					},
				},
			] as any;
		}

			it('invalidates viewed state when body fingerprint changes under the same status', async () => {
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts'], {
						files: [makeReviewFileSummary('a.ts', 'old-fingerprint')],
					}),
				}));
				await wb.setTarget({
					projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
					label: 'project',
					source: 'chat-project',
				});
				await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(1));

			wb.setFileViewed('a.ts', true);

			expect(wb.isFileViewed('a.ts')).toBe(true);
			wb.setHideViewed(true);
				expect(wb.visibleFilePaths).toEqual([]);

				wb.setHideViewed(false);
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValueOnce(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts'], {
						files: [makeReviewFileSummary('a.ts', 'new-fingerprint')],
					}),
				}));
				wb.refreshAllData();
				await vi.waitFor(() => expect(mockedApi.getGitWorkbenchSnapshot).toHaveBeenCalledTimes(2));

			expect(wb.isFileViewed('a.ts')).toBe(false);
			wb.setHideViewed(true);
			expect(wb.visibleFilePaths).toEqual(['a.ts']);
		});

		it('does not mark a file viewed before its rendered diff identity is loaded', () => {
			setSingleModifiedFile();

			wb.setFileViewed('a.ts', true);

			expect(wb.isFileViewed('a.ts')).toBe(false);
			wb.setHideViewed(true);
			expect(wb.visibleFilePaths).toEqual(['a.ts']);
		});
	});

	describe('line selection', () => {
		it('toggles line selection', () => {
			const key = makeLineSelectionKey('a.ts', 'unstaged', 'before', 0);
			wb.toggleLineSelection(key);

			expect(wb.selectedLineKeys.has(key)).toBe(true);
			expect(wb.hasSelection).toBe(true);

			wb.toggleLineSelection(key);

			expect(wb.selectedLineKeys.has(key)).toBe(false);
			expect(wb.hasSelection).toBe(false);
		});

		it('selects line range', () => {
			const first = makeLineSelectionKey('a.ts', 'unstaged', 'before', 0);
			const second = makeLineSelectionKey('a.ts', 'unstaged', 'after', 1);
			const third = makeLineSelectionKey('a.ts', 'unstaged', 'before', 2);
			const fourth = makeLineSelectionKey('a.ts', 'unstaged', 'after', 3);
			const allKeys = [first, second, third, fourth];

			wb.selectLineRange(first, third, allKeys);

			expect(wb.selectedLineKeys.size).toBe(3);
			expect(wb.selectedLineKeys.has(first)).toBe(true);
			expect(wb.selectedLineKeys.has(second)).toBe(true);
			expect(wb.selectedLineKeys.has(third)).toBe(true);
		});

		it('clears selection', () => {
			wb.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			wb.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'after', 1));

			wb.clearSelection();

			expect(wb.hasSelection).toBe(false);
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
				wb.selectedFile = 'a.ts';
				wb.selectedLineKeys = new Set([
					makeLineSelectionKey('a.ts', 'unstaged', 'before', 0),
					makeLineSelectionKey('a.ts', 'unstaged', 'after', 1),
				]);
				mockedApi.getGitWorkbenchSnapshot.mockClear();

				const result = await wb.stageSelectedLines('/project');

				expect(result).toBe(true);
				expect(wb.selectedLineKeys.size).toBe(0);
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

				const result = await wb.stageHunk(
					'/project',
					{ filePath: 'a.ts', tab: 'unstaged', mode: 'stage', contextLines: 5 },
					0,
				);

				expect(result).toBe(false);
				expect(mockedApi.gitStageHunk).not.toHaveBeenCalled();
				expect(wb.lastError).toBe('Refresh the Git workbench before modifying changes.');
			});

			it('stages entire file for untracked files', async () => {
				mockedApi.gitStageFile.mockResolvedValue({ success: true });
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

				const result = await wb.stageFile('/project', 'new-file.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStageFile).toHaveBeenCalledWith('/project', 'new-file.ts', 'stage');
		});

			it('advances selection after staging the selected file out of the active tab', async () => {
				mockedApi.gitStageFile.mockResolvedValue({ success: true });
				mockedApi.getGitWorkbenchSnapshot
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root: [
							{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
							{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						] as GitTreeNode[],
						summary: makeReviewSummary(['a.ts', 'b.ts']),
					}))
					.mockResolvedValueOnce(makeWorkbenchSnapshot({
						root: [
							{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
							{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						] as GitTreeNode[],
						summary: makeReviewSummary(['b.ts']),
					}));
				await wb.setTarget({
					projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			expect(wb.selectedFile).toBe('a.ts');

			const result = await wb.stageFile('/project', 'a.ts');

				expect(result).toBe(true);
				expect(wb.selectedFile).toBe('b.ts');
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
				mockedApi.gitStageFile.mockResolvedValue({ success: true });
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

				const result = await wb.unstageFile('/project', 'a.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStageFile).toHaveBeenCalledWith('/project', 'a.ts', 'unstage');
		});
	});

	describe('commit workflow', () => {
			it('commits index and clears message', async () => {
				wb.commitMessage = 'feat: add login';
				mockedApi.gitCommitIndex.mockResolvedValue({ success: true });
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [] }));

			const result = await wb.commitIndex('/project');

			expect(result).toBe(true);
			expect(wb.commitMessage).toBe('');
			expect(wb.isCommitting).toBe(false);
		});

		it('does not commit when message is empty', async () => {
			wb.commitMessage = '';

			const result = await wb.commitIndex('/project');

			expect(result).toBe(false);
			expect(mockedApi.gitCommitIndex).not.toHaveBeenCalled();
		});

		it('surfaces error on commit failure', async () => {
			wb.commitMessage = 'test';
			mockedApi.gitCommitIndex.mockRejectedValue(new Error('nothing staged'));

			const result = await wb.commitIndex('/project');

			expect(result).toBe(false);
			expect(wb.lastError).toContain('nothing staged');
		});

			it('creates initial commit', async () => {
				wb.hasCommits = false;
				mockedApi.gitInitialCommit.mockResolvedValue({ success: true });
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({ root: [], hasCommits: true }));

			const result = await wb.createInitialCommit('/project');

			expect(result).toBe(true);
			expect(wb.hasCommits).toBe(true);
		});

		it('generates commit message from staged files', async () => {
			wb.tree = [
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			mockedApi.generateCommitMessage.mockResolvedValue({ message: 'feat: auto-generated' });

			await wb.generateCommitMsg('/project');

			expect(wb.commitMessage).toBe('feat: auto-generated');
			expect(wb.isGeneratingMessage).toBe(false);
		});

		it('prepends directory prefix to generated message when enabled', async () => {
			wb.tree = [
				{ path: 'feature/auth/a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'feature/auth/b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			(wb as any).hydrateCommitSettings = vi.fn(async () => {
				wb.commitUseCommonDirPrefix = true;
			});
			mockedApi.generateCommitMessage.mockResolvedValue({ message: 'feat: auto-generated' });

			await wb.generateCommitMsg('/project');

			expect(wb.commitMessage).toBe('feature/auth: feat: auto-generated');
		});

		it('does not prepend directory prefix to generated message when disabled', async () => {
			wb.tree = [
				{ path: 'feature/auth/a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'feature/auth/b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			(wb as any).hydrateCommitSettings = vi.fn(async () => {
				wb.commitUseCommonDirPrefix = false;
			});
			mockedApi.generateCommitMessage.mockResolvedValue({ message: 'feat: auto-generated' });

			await wb.generateCommitMsg('/project');

			expect(wb.commitMessage).toBe('feat: auto-generated');
		});

		it('surfaces error when no staged files for message generation', async () => {
			wb.tree = [];

			await wb.generateCommitMsg('/project');

			expect(wb.lastError).toContain('No staged files');
		});

		it('maps typed commit generation errorCode to localized message', async () => {
			wb.tree = [
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			mockedApi.generateCommitMessage.mockRejectedValue(
				new ApiError(504, 'Timed out', 'commit_message_timeout'),
			);

			await wb.generateCommitMsg('/project');

			expect(wb.lastError).toContain('timed out');
		});
	});

	describe('derived getters', () => {
		it('stagedFiles collects staged file paths', () => {
			wb.tree = [
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
			] as any;

			expect(wb.stagedFiles).toEqual(['a.ts', 'src/c.ts']);
		});

		it('filteredTree filters by search query', () => {
			wb.tree = [
				{ path: 'auth.ts', name: 'auth.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'utils.ts', name: 'utils.ts', kind: 'file', staged: false, hasUnstaged: true },
			] as any;
			wb.treeSearchQuery = 'auth';

			expect(wb.filteredTree).toHaveLength(1);
			expect(wb.filteredTree[0].path).toBe('auth.ts');
		});

		it('shows generated files by default and hides them only when requested', () => {
			wb.tree = [
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
			] as any;

			expect(wb.hideGenerated).toBe(false);
			expect(wb.visibleFilePaths).toEqual(['src/generated/api.ts', 'src/app.ts']);

			wb.setHideGenerated(true);

			expect(wb.visibleFilePaths).toEqual(['src/app.ts']);
		});

		it('totalChangedFiles counts files recursively', () => {
			wb.tree = [
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
			] as any;

			expect(wb.totalChangedFiles).toBe(3);
		});
	});

	describe('compact folders', () => {
		it('collapses single-child directory chains', () => {
			wb.tree = [
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
			] as any;

			const result = wb.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('a/b/c');
			expect(result[0].path).toBe('a/b/c');
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children![0].name).toBe('file.ts');
		});

		it('stops compacting when directory has multiple children', () => {
			wb.tree = [
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
			] as any;

			const result = wb.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src/lib');
			expect(result[0].children).toHaveLength(2);
		});

		it('does not compact directory with a single file child', () => {
			wb.tree = [
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
			] as any;

			const result = wb.filteredTree;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src');
			expect(result[0].children).toHaveLength(1);
		});

		it('preserves staged/hasUnstaged flags through compaction', () => {
			wb.tree = [
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
			] as any;

			const result = wb.filteredTree;
			expect(result[0].staged).toBe(true);
			expect(result[0].hasUnstaged).toBe(true);
		});
	});

	describe('review comments', () => {
		it('adds, updates, and removes draft comments', () => {
			wb.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 10,
				body: 'Needs refactoring',
				severity: 'warning',
			});

			expect(wb.reviewComments).toHaveLength(1);
			const id = wb.reviewComments[0].id;
			expect(wb.reviewComments[0].body).toBe('Needs refactoring');

			wb.updateDraftComment(id, { body: 'Updated comment' });
			expect(wb.reviewComments[0].body).toBe('Updated comment');

			wb.removeDraftComment(id);
			expect(wb.reviewComments).toHaveLength(0);
		});

		it('groups comments by file', () => {
			wb.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 1,
				body: 'one',
				severity: 'note',
			});
			wb.addDraftComment({
				filePath: 'b.ts',
				side: 'after',
				line: 2,
				body: 'two',
				severity: 'note',
			});
			wb.addDraftComment({
				filePath: 'a.ts',
				side: 'before',
				line: 5,
				body: 'three',
				severity: 'blocker',
			});

			const grouped = wb.commentsByFile;
			expect(Object.keys(grouped)).toEqual(['a.ts', 'b.ts']);
			expect(grouped['a.ts']).toHaveLength(2);
			expect(grouped['b.ts']).toHaveLength(1);
		});

		it('builds finalized review message', () => {
			wb.reviewSummary = 'Overall good';
			wb.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 10,
				body: 'Fix this',
				severity: 'warning',
			});

			const msg = wb.buildFinalizedReviewMessage();

			expect(msg).toContain('Summary:');
			expect(msg).toContain('Overall good');
			expect(msg).toContain('[warning] a.ts:10');
			expect(msg).toContain('Fix this');
		});

		it('finalizeReviewToAgent calls send and clears on success', async () => {
			wb.addDraftComment({
				filePath: 'a.ts',
				side: 'after',
				line: 1,
				body: 'test',
				severity: 'note',
			});
			wb.reviewSummary = 'summary';
			const send = vi.fn().mockResolvedValue(true);

			const result = await wb.finalizeReviewToAgent(send);

			expect(result).toBe(true);
			expect(send).toHaveBeenCalledOnce();
			expect(wb.reviewComments).toHaveLength(0);
			expect(wb.reviewSummary).toBe('');
		});
	});

	describe('tree pane width', () => {
		it('defaults to 300px', () => {
			expect(wb.treePaneWidthPx).toBe(300);
		});

		it('clamps width to bounds [220, 560]', () => {
			wb.setTreePaneWidth(100);
			expect(wb.treePaneWidthPx).toBe(220);

			wb.setTreePaneWidth(1000);
			expect(wb.treePaneWidthPx).toBe(560);
		});

		it('rounds to integer', () => {
			wb.setTreePaneWidth(333.7);
			expect(wb.treePaneWidthPx).toBe(334);
		});

		it('persists to localStorage', () => {
			const spy = vi.spyOn(localStorage, 'setItem');
			wb.setTreePaneWidth(400);
			expect(spy).toHaveBeenCalledWith(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx, '400');
		});

		it('loads from localStorage', () => {
			vi.spyOn(localStorage, 'getItem').mockReturnValue('350');
			wb.loadTreePaneWidth();
			expect(wb.treePaneWidthPx).toBe(350);
		});

		it('ignores invalid localStorage value', () => {
			vi.spyOn(localStorage, 'getItem').mockReturnValue('notanumber');
			wb.treePaneWidthPx = 300;
			wb.loadTreePaneWidth();
			expect(wb.treePaneWidthPx).toBe(300);
		});
	});

	describe('activeTab', () => {
		it('defaults to unstaged', () => {
			expect(wb.activeTab).toBe('unstaged');
		});

		it('setActiveTab switches tab and clears selection', () => {
			wb.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			expect(wb.hasSelection).toBe(true);

			wb.setActiveTab('staged');

			expect(wb.activeTab).toBe('staged');
			expect(wb.hasSelection).toBe(false);
		});

		it('setActiveTab is no-op when same tab', () => {
			wb.toggleLineSelection(makeLineSelectionKey('a.ts', 'unstaged', 'before', 0));
			wb.setActiveTab('unstaged');

			expect(wb.hasSelection).toBe(true);
		});

		it('unstagedFileCount counts files with hasUnstaged or untracked', () => {
			wb.tree = [
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
			] as any;

			expect(wb.unstagedFileCount).toBe(2);
		});

		it('stagedFileCount counts files with staged flag', () => {
			wb.tree = [
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'c.ts', name: 'c.ts', kind: 'file', staged: true, hasUnstaged: true },
			] as any;

			expect(wb.stagedFileCount).toBe(2);
		});
	});

	describe('tree selection scroll targets', () => {
		it('finds the first visible file for a selected directory in unstaged tab', () => {
			wb.tree = [
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
			] as any;
			wb.setActiveTab('unstaged');

			expect(wb.firstVisibleFileInDirectory('src')).toBe('src/a.ts');
		});

		it('finds the first visible file for a selected directory in staged tab', () => {
			wb.tree = [
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
			] as any;
			wb.setActiveTab('staged');

			expect(wb.firstVisibleFileInDirectory('src')).toBe('src/b.ts');
		});

		it('returns null when directory has no visible files for active tab', () => {
			wb.tree = [
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
			] as any;
			wb.setActiveTab('staged');

			expect(wb.firstVisibleFileInDirectory('src')).toBeNull();
		});

		it('creates unique scroll requests for repeated file selections', () => {
			wb.requestDiffScrollToFile('src/a.ts');
			const first = wb.diffScrollRequest;
			wb.requestDiffScrollToFile('src/a.ts');
			const second = wb.diffScrollRequest;

			expect(first?.filePath).toBe('src/a.ts');
			expect(second?.filePath).toBe('src/a.ts');
			expect(second?.token).toBeGreaterThan(first?.token ?? 0);
		});

		it('switches to staged tab when selecting a staged-only file', async () => {
			wb.tree = [
				{ path: 'staged.ts', name: 'staged.ts', kind: 'file', staged: true, hasUnstaged: false },
			] as any;
			wb.setActiveTab('unstaged');

			await wb.selectFile('/project', 'staged.ts');

			expect(wb.activeTab).toBe('staged');
			expect(wb.selectedFile).toBe('staged.ts');
			expect(wb.diffScrollRequest?.filePath).toBe('staged.ts');
		});
	});

		describe('target refresh lifecycle', () => {
			it('selects the first file from the snapshot and starts selected body loading', async () => {
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts']),
				}));

				await wb.setTarget({
					projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
					source: 'chat-project',
				});

				expect(wb.selectedFile).toBe('a.ts');
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
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					project: '/repo/subdir',
					root: [makeTreeFile('a.ts')],
					summary: makeReviewSummary(['a.ts'], { project: '/repo/subdir' }),
				}));

				await wb.setTarget({
					projectPath: '/repo/subdir',
					repoRoot: '/repo/subdir',
					worktreePath: '/repo/subdir',
					label: 'subdir',
					source: 'chat-project',
				});
				wb.commitMessage = 'feat: preserve draft';
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
				expect(wb.selectedFile).toBe('a.ts');
				expect(wb.commitMessage).toBe('feat: preserve draft');
			});

		it('logs first-load timing when the workbench trace flag is enabled', async () => {
			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
				key === 'garcon.gitWorkbenchTrace' ? '1' : 'claude',
			);
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
				}));

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
				mockedApi.getGitWorkbenchSnapshot.mockResolvedValue(makeWorkbenchSnapshot({
					root: [makeTreeFile('a.ts')],
				}));

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});
			wb.commitMessage = 'feat: keep draft';

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.commitMessage).toBe('feat: keep draft');
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
			wb.commitMessage = 'feat: old target';

			await wb.setTarget({
				projectPath: '/project-b',
				repoRoot: '/repo',
				worktreePath: '/project-b',
				label: 'b',
				source: 'worktree',
			});

				expect(wb.commitMessage).toBe('');
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

				wb.selectedFile = 'a.ts';
				wb.porcelain.setInspectorView('history');
				const firstLoad = wb.porcelain.loadCurrentView('/project');
				const firstOptions = mockedApi.getGitFileHistory.mock.calls[0]?.[3] as RequestInit;

				wb.selectedFile = 'b.ts';
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
			wb.tree = [
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
			] as any;
			wb.selectedFile = 'a.ts';
			wb.commitMessage = 'test';
			wb.setActiveTab('staged');

			wb.reset();

			expect(wb.tree).toEqual([]);
			expect(wb.selectedFile).toBeNull();
			expect(wb.commitMessage).toBe('');
			expect(wb.hasCommits).toBe(true);
			expect(wb.lastError).toBeNull();
			expect(wb.activeTab).toBe('unstaged');
		});
	});

	describe('error feedback', () => {
		it('dismissError clears the error', () => {
			wb.commitMessage = 'test';
			// Trigger an error manually via the public method
			mockedApi.gitCommitIndex.mockRejectedValue(new Error('fail'));

			// After error, dismissError should clear
			wb.dismissError();
			expect(wb.lastError).toBeNull();
		});
	});
});
