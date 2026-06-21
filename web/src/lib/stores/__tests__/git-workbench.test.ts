import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GitWorkbenchStore,
	makeLineSelectionKey,
	type GitWorkbenchDeps,
} from '../git-workbench.svelte';
import type { GitFileReviewData, GitFileReviewMode } from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

const mockDeps: GitWorkbenchDeps = {
	getSettings: vi.fn().mockResolvedValue({ ui: {} }),
};

// Mock the git API module
vi.mock('$lib/api/git.js', () => ({
	getGitChangesTree: vi.fn(),
	getGitChangesStats: vi.fn(),
	getGitFileReviewData: vi.fn(),
	getGitFileReviewDataBatch: vi.fn(),
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

function makeReviewData(
	path = 'a.ts',
	mode: GitFileReviewMode = 'working',
	text = '',
): GitFileReviewData {
	return {
		path,
		mode,
		isBinary: false,
		truncated: false,
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

describe('GitWorkbenchStore', () => {
	let wb: GitWorkbenchStore;

	beforeEach(() => {
		wb = new GitWorkbenchStore(mockDeps);
		vi.clearAllMocks();
		mockedApi.getGitChangesStats.mockResolvedValue({ working: {}, staged: {} });
		mockedApi.getGitFileReviewData.mockResolvedValue(makeReviewData('a.ts'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

		describe('tree loading', () => {
			it('loads tree and sets hasCommits from response', async () => {
			const tree = [
				{
					path: 'a.ts',
					name: 'a.ts',
					kind: 'file' as const,
					staged: false,
					hasUnstaged: true,
					changeKind: 'modified' as const,
				},
			];
			mockedApi.getGitChangesTree.mockResolvedValue({ root: tree, hasCommits: true });

			await wb.loadTree('/project');

			expect(wb.tree).toEqual(tree);
			expect(wb.hasCommits).toBe(true);
				expect(wb.isLoadingTree).toBe(false);
				expect(mockedApi.getGitChangesTree).toHaveBeenCalledWith(
					'/project',
					false,
					expect.objectContaining({ signal: expect.any(AbortSignal) }),
				);
			});

			it('aborts stale tree loads when a newer load starts', async () => {
				const staleTreeLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitChangesTree>>>();
				const currentTree = [
					{ path: 'new.ts', name: 'new.ts', kind: 'file' as const, staged: false, hasUnstaged: true },
				];
				mockedApi.getGitChangesTree
					.mockReturnValueOnce(staleTreeLoad.promise)
					.mockResolvedValueOnce({ root: currentTree, hasCommits: true });

				const staleLoad = wb.loadTree('/project-a');
				const staleOptions = mockedApi.getGitChangesTree.mock.calls[0]?.[2] as RequestInit;
				const currentLoad = wb.loadTree('/project-b');
				const currentOptions = mockedApi.getGitChangesTree.mock.calls[1]?.[2] as RequestInit;

				expect(staleOptions.signal).toBeInstanceOf(AbortSignal);
				expect(staleOptions.signal?.aborted).toBe(true);
				expect(currentOptions.signal).toBeInstanceOf(AbortSignal);
				expect(currentOptions.signal?.aborted).toBe(false);

				staleTreeLoad.resolve({ root: [], hasCommits: false });
				await Promise.all([staleLoad, currentLoad]);

				expect(wb.tree).toEqual(currentTree);
			});

			it('aborts stale stats loads when a newer stats load starts', async () => {
				const staleStatsLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitChangesStats>>>();
				mockedApi.getGitChangesStats
					.mockReturnValueOnce(staleStatsLoad.promise)
					.mockResolvedValueOnce({ working: {}, staged: {} });

				wb.hydrateStats('/project-a');
				const staleOptions = mockedApi.getGitChangesStats.mock.calls[0]?.[1] as RequestInit;
				wb.hydrateStats('/project-b');
				const currentOptions = mockedApi.getGitChangesStats.mock.calls[1]?.[1] as RequestInit;

				expect(staleOptions.signal).toBeInstanceOf(AbortSignal);
				expect(staleOptions.signal?.aborted).toBe(true);
				expect(currentOptions.signal).toBeInstanceOf(AbortSignal);
				expect(currentOptions.signal?.aborted).toBe(false);

				staleStatsLoad.resolve({ working: {}, staged: {} });
				await vi.waitFor(() => {
					expect(mockedApi.getGitChangesStats).toHaveBeenCalledTimes(2);
				});
			});

		it('sets hasCommits false when no commits', async () => {
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: false });

			await wb.loadTree('/project');

			expect(wb.hasCommits).toBe(false);
		});

		it('surfaces error on tree load failure', async () => {
			mockedApi.getGitChangesTree.mockRejectedValue(new Error('network error'));

			await wb.loadTree('/project');

			expect(wb.tree).toEqual([]);
			expect(wb.lastError).toContain('network error');
		});

		it('ignores stale tree results after target changes', async () => {
			const staleTreeLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitChangesTree>>>();
			const staleTree = [
				{ path: 'old.ts', name: 'old.ts', kind: 'file' as const, staged: false, hasUnstaged: true },
			];
			const currentTree = [
				{ path: 'new.ts', name: 'new.ts', kind: 'file' as const, staged: false, hasUnstaged: true },
			];
			mockedApi.getGitChangesTree
				.mockReturnValueOnce(staleTreeLoad.promise)
				.mockResolvedValueOnce({ root: currentTree, hasCommits: false });

			const staleTarget = wb.setTarget({
				projectPath: '/project-a',
				repoRoot: '/repo',
				worktreePath: '/project-a',
				label: 'a',
				source: 'worktree',
			});
			const currentTarget = wb.setTarget({
				projectPath: '/project-b',
				repoRoot: '/repo',
				worktreePath: '/project-b',
				label: 'b',
				source: 'worktree',
			});

			staleTreeLoad.resolve({ root: staleTree, hasCommits: true });
			await Promise.all([staleTarget, currentTarget]);

			expect(wb.target?.projectPath).toBe('/project-b');
			expect(wb.tree).toEqual(currentTree);
			expect(wb.hasCommits).toBe(false);
			expect(wb.isLoadingTree).toBe(false);
		});
	});

	describe('file review data', () => {
		it('loads review data with active tab', async () => {
			const reviewData = makeReviewData('a.ts');
			mockedApi.getGitFileReviewData.mockResolvedValue(reviewData);

			await wb.loadFileReviewData('/project', 'a.ts');

			expect(mockedApi.getGitFileReviewData).toHaveBeenCalledWith(
				'/project',
				'a.ts',
				'unstaged',
				5,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(wb.reviewDataByPath['a.ts']).toEqual(reviewData);
		});

		it('ignores stale file review data after tab changes', async () => {
			const staleReviewLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitFileReviewData>>>();
			const staleReviewData = makeReviewData('a.ts', 'working', 'old');
			const currentReviewData = makeReviewData('a.ts', 'staged', 'new');
			mockedApi.getGitFileReviewData
				.mockReturnValueOnce(staleReviewLoad.promise)
				.mockResolvedValueOnce(currentReviewData);

			const staleLoad = wb.loadFileReviewData('/project', 'a.ts');
			wb.setActiveTab('staged');
			const currentLoad = wb.loadFileReviewData('/project', 'a.ts');

			staleReviewLoad.resolve(staleReviewData);
			await Promise.all([staleLoad, currentLoad]);

			expect(mockedApi.getGitFileReviewData).toHaveBeenNthCalledWith(
				1,
				'/project',
				'a.ts',
				'unstaged',
				5,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(mockedApi.getGitFileReviewData).toHaveBeenNthCalledWith(
				2,
				'/project',
				'a.ts',
				'staged',
				5,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(wb.reviewDataByPath['a.ts']).toEqual(currentReviewData);
			expect(wb.isLoadingFile).toBe(false);
		});

		it('requestFilesLoaded fetches uncached files', async () => {
			mockedApi.getGitFileReviewDataBatch.mockImplementation(
				async (_project, files) =>
					({
						files: Object.fromEntries(
							(files as string[]).map((file) => [
								file,
								makeReviewData(file),
							]),
						),
						errors: {},
					}) as any,
			);

			wb.requestFilesLoaded('/project', ['a.ts', 'src/b.ts']);

			// Allow microtasks to resolve
			await vi.waitFor(() => {
				expect(Object.keys(wb.reviewDataByPath)).toEqual(
					expect.arrayContaining(['a.ts', 'src/b.ts']),
				);
			});
			expect(mockedApi.getGitFileReviewDataBatch).toHaveBeenCalledTimes(1);
		});

		it('requestFilesLoaded deduplicates in-flight requests', async () => {
			let callCount = 0;
			mockedApi.getGitFileReviewDataBatch.mockImplementation(async (_project, files) => {
				callCount++;
				return {
					files: Object.fromEntries(
						(files as string[]).map((file) => [
							file,
							makeReviewData(file),
						]),
					),
					errors: {},
				} as any;
			});

			// Call twice with same file
			wb.requestFilesLoaded('/project', ['a.ts']);
			wb.requestFilesLoaded('/project', ['a.ts']);

			await vi.waitFor(() => {
				expect(wb.reviewDataByPath['a.ts']).toBeDefined();
			});
			expect(callCount).toBe(1);
		});

		it('does not batch-load a file while selected-file load is in flight', async () => {
			const reviewLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitFileReviewData>>>();
			mockedApi.getGitFileReviewData.mockReturnValueOnce(reviewLoad.promise);

			const selectedLoad = wb.loadFileReviewData('/project', 'a.ts');
			wb.requestFilesLoaded('/project', ['a.ts']);
			reviewLoad.resolve({
				...makeReviewData('a.ts'),
			});
			await selectedLoad;

			expect(mockedApi.getGitFileReviewDataBatch).not.toHaveBeenCalled();
		});

		it('selected-file load reuses an in-flight batch request for the same file', async () => {
			const batchLoad = deferred<Awaited<ReturnType<typeof gitApi.getGitFileReviewDataBatch>>>();
			const reviewData = makeReviewData('a.ts');
			mockedApi.getGitFileReviewData.mockClear();
			mockedApi.getGitFileReviewDataBatch.mockReturnValueOnce(batchLoad.promise);

			wb.requestFilesLoaded('/project', ['a.ts']);
			const selectedLoad = wb.loadFileReviewData('/project', 'a.ts');
			batchLoad.resolve({ files: { 'a.ts': reviewData }, errors: {} });
			await selectedLoad;

			expect(mockedApi.getGitFileReviewData).not.toHaveBeenCalled();
			expect(wb.reviewDataByPath['a.ts']).toEqual(reviewData);
		});

		it('setContextLines clears review data for re-fetch', () => {
			wb.reviewDataByPath = { 'a.ts': {} as any };

			wb.setContextLines(10);

			expect(wb.contextLines).toBe(10);
			expect(wb.reviewDataByPath).toEqual({});
		});

		it('refreshAllData clears cache and review data', () => {
			wb.reviewDataByPath = { 'a.ts': {} as any };

			wb.refreshAllData();

			expect(wb.reviewDataByPath).toEqual({});
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

		it('invalidates viewed state when rendered diff identity changes under the same status', () => {
			setSingleModifiedFile();
			wb.reviewDataByPath = { 'a.ts': makeReviewData('a.ts', 'working', 'old') };

			wb.setFileViewed('a.ts', true);

			expect(wb.isFileViewed('a.ts')).toBe(true);
			wb.setHideViewed(true);
			expect(wb.visibleFilePaths).toEqual([]);

			wb.setHideViewed(false);
			wb.reviewDataByPath = { 'a.ts': makeReviewData('a.ts', 'working', 'new') };

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
			wb.selectedFile = 'a.ts';
			wb.selectedLineKeys = new Set([
				makeLineSelectionKey('a.ts', 'unstaged', 'before', 0),
				makeLineSelectionKey('a.ts', 'unstaged', 'after', 1),
			]);
			mockedApi.gitStageSelection.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });
			mockedApi.getGitFileReviewData.mockResolvedValue(makeReviewData('a.ts'));

			const result = await wb.stageSelectedLines('/project');

			expect(result).toBe(true);
			expect(wb.selectedLineKeys.size).toBe(0);
			expect(mockedApi.getGitChangesTree).toHaveBeenCalled();
		});

		it('stages entire file for untracked files', async () => {
			mockedApi.gitStageFile.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });

			const result = await wb.stageFile('/project', 'new-file.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStageFile).toHaveBeenCalledWith('/project', 'new-file.ts', 'stage');
		});

		it('advances selection after staging the selected file out of the active tab', async () => {
			mockedApi.gitStageFile.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree
				.mockResolvedValueOnce({
					root: [
						{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
						{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
					],
					hasCommits: true,
				})
				.mockResolvedValueOnce({
					root: [
						{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: true, hasUnstaged: false },
						{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
					],
					hasCommits: true,
				});
			mockedApi.getGitFileReviewData.mockImplementation(
				async (_project, filePath, mode = 'working') =>
					makeReviewData(filePath as string, mode === 'staged' ? 'staged' : 'working'),
			);

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
			expect(mockedApi.getGitFileReviewData).toHaveBeenLastCalledWith(
				'/project',
				'b.ts',
				'unstaged',
				5,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		});

		it('unstages entire file', async () => {
			mockedApi.gitStageFile.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });

			const result = await wb.unstageFile('/project', 'a.ts');

			expect(result).toBe(true);
			expect(mockedApi.gitStageFile).toHaveBeenCalledWith('/project', 'a.ts', 'unstage');
		});
	});

	describe('commit workflow', () => {
		it('commits index and clears message', async () => {
			wb.commitMessage = 'feat: add login';
			mockedApi.gitCommitIndex.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });

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
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });

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
			mockedApi.getGitFileReviewData.mockResolvedValue(makeReviewData('staged.ts', 'staged'));

			await wb.selectFile('/project', 'staged.ts');

			expect(wb.activeTab).toBe('staged');
			expect(wb.selectedFile).toBe('staged.ts');
			expect(wb.diffScrollRequest?.filePath).toBe('staged.ts');
		});
	});

		describe('target refresh lifecycle', () => {
		it('defaults to selected-file mode and hydrates stats after first selected file load', async () => {
			mockedApi.getGitChangesTree.mockResolvedValue({
				root: [{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true }],
				hasCommits: true,
				statsState: 'pending',
			});

			await wb.setTarget({
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				source: 'chat-project',
			});

			expect(wb.reviewScope).toBe('selected-file');
			expect(mockedApi.getGitFileReviewDataBatch).not.toHaveBeenCalled();
			expect(mockedApi.getGitFileReviewData).toHaveBeenCalledWith(
				'/project',
				'a.ts',
				'unstaged',
				5,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
				await vi.waitFor(() => {
					expect(mockedApi.getGitChangesStats).toHaveBeenCalledWith(
						'/project',
						expect.objectContaining({ signal: expect.any(AbortSignal) }),
					);
				});
			});

		it('logs first-load timing when the workbench trace flag is enabled', async () => {
			const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
			vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
				key === 'garcon.gitWorkbenchTrace' ? '1' : 'claude',
			);
			mockedApi.getGitChangesTree.mockResolvedValue({
				root: [{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true }],
				hasCommits: true,
				statsState: 'pending',
			});

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
					reviewScope: 'selected-file',
					treeMs: expect.any(Number),
					selectedFileMs: expect.any(Number),
					firstRenderableMs: expect.any(Number),
				}),
			);
		});

		it('preserves commit draft on same-target refresh', async () => {
			mockedApi.getGitChangesTree.mockResolvedValue({
				root: [{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true }],
				hasCommits: true,
			});

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
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });

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
