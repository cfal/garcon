import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitWorkbenchStore, type GitWorkbenchDeps } from '../git-workbench.svelte';
import { ApiError } from '$lib/api/client.js';

const mockDeps: GitWorkbenchDeps = {
	getSettings: vi.fn().mockResolvedValue({ ui: {} }),
};

// Mock the git API module
vi.mock('$lib/api/git.js', () => ({
	getGitChangesTree: vi.fn(),
	getGitFileReviewData: vi.fn(),
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

describe('GitWorkbenchStore', () => {
	let wb: GitWorkbenchStore;

	beforeEach(() => {
		wb = new GitWorkbenchStore(undefined, mockDeps);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('tree loading', () => {
		it('loads tree and sets hasCommits from response', async () => {
			const tree = [
				{ path: 'a.ts', name: 'a.ts', kind: 'file' as const, staged: false, hasUnstaged: true, changeKind: 'modified' as const },
			];
			mockedApi.getGitChangesTree.mockResolvedValue({ root: tree, hasCommits: true });

			await wb.loadTree('/project');

			expect(wb.tree).toEqual(tree);
			expect(wb.hasCommits).toBe(true);
			expect(wb.isLoadingTree).toBe(false);
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
	});

	describe('file review data', () => {
		it('loads review data with active tab', async () => {
			const reviewData = {
				path: 'a.ts', isBinary: false,
				truncated: false, contentBefore: '', contentAfter: '',
				diffOps: [], hunks: [],
			};
			mockedApi.getGitFileReviewData.mockResolvedValue(reviewData);

			await wb.loadFileReviewData('/project', 'a.ts');

			expect(mockedApi.getGitFileReviewData).toHaveBeenCalledWith(
				'/project', 'a.ts', 'unstaged', 5,
			);
			expect(wb.reviewDataByPath['a.ts']).toEqual(reviewData);
		});

		it('requestFilesLoaded fetches uncached files', async () => {
			mockedApi.getGitFileReviewData.mockImplementation(async (_project, file) => ({
				path: file as string,
				isBinary: false,
				truncated: false,
				contentBefore: '',
				contentAfter: '',
				diffOps: [],
				hunks: [],
			}) as any);

			wb.requestFilesLoaded('/project', ['a.ts', 'src/b.ts']);

			// Allow microtasks to resolve
			await vi.waitFor(() => {
				expect(Object.keys(wb.reviewDataByPath)).toEqual(
					expect.arrayContaining(['a.ts', 'src/b.ts']),
				);
			});
			expect(mockedApi.getGitFileReviewData).toHaveBeenCalledTimes(2);
		});

		it('requestFilesLoaded deduplicates in-flight requests', async () => {
			let callCount = 0;
			mockedApi.getGitFileReviewData.mockImplementation(async (_project, file) => {
				callCount++;
				return {
					path: file as string, isBinary: false, truncated: false,
					contentBefore: '', contentAfter: '', diffOps: [], hunks: [],
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

	describe('line selection', () => {
		it('toggles line selection', () => {
			wb.toggleLineSelection('before:0');

			expect(wb.selectedLineKeys.has('before:0')).toBe(true);
			expect(wb.hasSelection).toBe(true);

			wb.toggleLineSelection('before:0');

			expect(wb.selectedLineKeys.has('before:0')).toBe(false);
			expect(wb.hasSelection).toBe(false);
		});

		it('selects line range', () => {
			const allKeys = ['before:0', 'after:1', 'before:2', 'after:3'];

			wb.selectLineRange('before:0', 'before:2', allKeys);

			expect(wb.selectedLineKeys.size).toBe(3);
			expect(wb.selectedLineKeys.has('before:0')).toBe(true);
			expect(wb.selectedLineKeys.has('after:1')).toBe(true);
			expect(wb.selectedLineKeys.has('before:2')).toBe(true);
		});

		it('clears selection', () => {
			wb.toggleLineSelection('before:0');
			wb.toggleLineSelection('after:1');

			wb.clearSelection();

			expect(wb.hasSelection).toBe(false);
		});

	});

	describe('staging', () => {
		it('stages selected lines and refreshes', async () => {
			wb.selectedFile = 'a.ts';
			wb.selectedLineKeys = new Set(['before:0', 'after:1']);
			mockedApi.gitStageSelection.mockResolvedValue({ success: true });
			mockedApi.getGitChangesTree.mockResolvedValue({ root: [], hasCommits: true });
			mockedApi.getGitFileReviewData.mockResolvedValue({
				path: 'a.ts', isBinary: false,
				truncated: false, contentBefore: '', contentAfter: '',
				diffOps: [], hunks: [],
			} as any);

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
					path: 'src', name: 'src', kind: 'directory', staged: true, hasUnstaged: false,
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

		it('totalChangedFiles counts files recursively', () => {
			wb.tree = [
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
				{
					path: 'src', name: 'src', kind: 'directory', staged: false, hasUnstaged: true,
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
					path: 'a', name: 'a', kind: 'directory', staged: false, hasUnstaged: true,
					children: [{
						path: 'a/b', name: 'b', kind: 'directory', staged: false, hasUnstaged: true,
						children: [{
							path: 'a/b/c', name: 'c', kind: 'directory', staged: false, hasUnstaged: true,
							children: [
								{ path: 'a/b/c/file.ts', name: 'file.ts', kind: 'file', staged: false, hasUnstaged: true },
							],
						}],
					}],
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
					path: 'src', name: 'src', kind: 'directory', staged: false, hasUnstaged: true,
					children: [{
						path: 'src/lib', name: 'lib', kind: 'directory', staged: false, hasUnstaged: true,
						children: [
							{ path: 'src/lib/a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
							{ path: 'src/lib/b.ts', name: 'b.ts', kind: 'file', staged: false, hasUnstaged: true },
						],
					}],
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
					path: 'src', name: 'src', kind: 'directory', staged: false, hasUnstaged: true,
					children: [
						{ path: 'src/index.ts', name: 'index.ts', kind: 'file', staged: false, hasUnstaged: true },
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
					path: 'a', name: 'a', kind: 'directory', staged: true, hasUnstaged: false,
					children: [{
						path: 'a/b', name: 'b', kind: 'directory', staged: false, hasUnstaged: true,
						children: [
							{ path: 'a/b/file.ts', name: 'file.ts', kind: 'file', staged: true, hasUnstaged: true },
						],
					}],
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
				filePath: 'a.ts', side: 'after', line: 10,
				body: 'Needs refactoring', severity: 'warning',
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
			wb.addDraftComment({ filePath: 'a.ts', side: 'after', line: 1, body: 'one', severity: 'note' });
			wb.addDraftComment({ filePath: 'b.ts', side: 'after', line: 2, body: 'two', severity: 'note' });
			wb.addDraftComment({ filePath: 'a.ts', side: 'before', line: 5, body: 'three', severity: 'blocker' });

			const grouped = wb.commentsByFile;
			expect(Object.keys(grouped)).toEqual(['a.ts', 'b.ts']);
			expect(grouped['a.ts']).toHaveLength(2);
			expect(grouped['b.ts']).toHaveLength(1);
		});

		it('builds finalized review message', () => {
			wb.reviewSummary = 'Overall good';
			wb.addDraftComment({ filePath: 'a.ts', side: 'after', line: 10, body: 'Fix this', severity: 'warning' });

			const msg = wb.buildFinalizedReviewMessage();

			expect(msg).toContain('Summary:');
			expect(msg).toContain('Overall good');
			expect(msg).toContain('[warning] a.ts:10');
			expect(msg).toContain('Fix this');
		});

		it('finalizeReviewToAgent calls send and clears on success', async () => {
			wb.addDraftComment({ filePath: 'a.ts', side: 'after', line: 1, body: 'test', severity: 'note' });
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
			expect(spy).toHaveBeenCalledWith('git.treePaneWidthPx', '400');
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
			wb.toggleLineSelection('before:0');
			expect(wb.hasSelection).toBe(true);

			wb.setActiveTab('staged');

			expect(wb.activeTab).toBe('staged');
			expect(wb.hasSelection).toBe(false);
		});

		it('setActiveTab is no-op when same tab', () => {
			wb.toggleLineSelection('before:0');
			wb.setActiveTab('unstaged');

			expect(wb.hasSelection).toBe(true);
		});

		it('unstagedFileCount counts files with hasUnstaged or untracked', () => {
			wb.tree = [
				{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true },
				{ path: 'b.ts', name: 'b.ts', kind: 'file', staged: true, hasUnstaged: false },
				{ path: 'c.ts', name: 'c.ts', kind: 'file', staged: false, hasUnstaged: false, changeKind: 'untracked' },
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
					path: 'src', name: 'src', kind: 'directory', staged: false, hasUnstaged: true,
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
					path: 'src', name: 'src', kind: 'directory', staged: true, hasUnstaged: true,
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
					path: 'src', name: 'src', kind: 'directory', staged: false, hasUnstaged: false,
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
	});

	describe('reset', () => {
		it('clears all state including activeTab', () => {
			wb.tree = [{ path: 'a.ts', name: 'a.ts', kind: 'file', staged: false, hasUnstaged: true }] as any;
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
