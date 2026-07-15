import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitRemoteStatus } from '$lib/api/git.js';
import { GitRepositoryController } from '$lib/git/targets/git-repository-controller.svelte.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';

vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
});

vi.mock('$lib/api/git.js', () => ({
	getGitStatus: vi.fn(),
	getGitDiff: vi.fn().mockResolvedValue({}),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	getRemoteStatus: vi.fn().mockResolvedValue({}),
	getGitRemotes: vi
		.fn()
		.mockResolvedValue({ remotes: [{ name: 'origin', url: 'git@github.com:user/repo.git' }] }),
	generateCommitMessage: vi.fn(),
	gitCommit: vi.fn(),
	gitInitialCommit: vi.fn(),
	gitCheckoutRef: vi.fn(),
	gitCreateBranch: vi.fn(),
	gitFetch: vi.fn(),
	gitPull: vi.fn(),
	gitPush: vi.fn(),
	gitDiscard: vi.fn(),
	gitDeleteUntracked: vi.fn(),
}));

vi.mock('$lib/paraglide/messages.js', () => ({
	git_changes_modified: () => 'Modified',
	git_changes_added: () => 'Added',
	git_changes_deleted: () => 'Deleted',
	git_changes_untracked: () => 'Untracked',
}));

import {
	getGitStatus,
	getGitRefs,
	getRemoteStatus,
	gitCommit,
	gitCheckoutRef,
	gitPull,
	gitPush,
	gitDiscard,
} from '$lib/api/git.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function makeRemoteStatus(branch: string): GitRemoteStatus {
	return {
		hasRemote: true,
		hasUpstream: true,
		branch,
		remoteName: 'origin',
		remoteBranch: `origin/${branch}`,
		ahead: 0,
		behind: 0,
		isUpToDate: true,
	};
}

describe('GitRepositoryController', () => {
	let controller: GitRepositoryController;

	beforeEach(() => {
		vi.clearAllMocks();
		controller = new GitRepositoryController(new GitBranchSelectorState());
		controller.resetForProject('/project', { deferMetadata: true });
	});

	describe('fetchGitStatus', () => {
		it('populates status and branch on success', async () => {
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'main',
				hasCommits: true,
				modified: ['a.txt', 'b.txt'],
				added: [],
				deleted: [],
				untracked: [],
			});
			await controller.fetchGitStatus('/project');
			expect(controller.currentBranch).toBe('main');
			expect(controller.gitStatus?.modified).toEqual(['a.txt', 'b.txt']);
			expect(controller.isLoading).toBe(false);
		});

		it('sets error status on API error', async () => {
			controller.resetForProject('/bad-path', { deferMetadata: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: '',
				hasCommits: false,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
				error: 'Not a git repo',
				details: 'fatal: not a git repository',
			});
			await controller.fetchGitStatus('/bad-path');
			expect(controller.gitStatus?.error).toBe('Not a git repo');
			expect(controller.currentBranch).toBe('');
		});
	});

	describe('deferred metadata', () => {
		it('does not fetch branch list or remote status during deferred project reset', () => {
			controller.resetForProject('/project', { deferMetadata: true, currentBranch: 'main' });

			expect(controller.currentBranch).toBe('main');
			expect(getGitStatus).not.toHaveBeenCalled();
			expect(getGitRefs).not.toHaveBeenCalled();
			expect(getRemoteStatus).not.toHaveBeenCalled();
		});

		it('loads branches when branch dropdown opens', async () => {
			await controller.openBranchDropdown('/project');

			expect(controller.showBranchDropdown).toBe(true);
			expect(getGitRefs).toHaveBeenCalledWith('/project', { query: '', limit: 200 });
		});
	});

	describe('remote status loading', () => {
		it('ignores stale remote status responses after a newer fetch starts', async () => {
			const stale = deferred<GitRemoteStatus>();
			const current = deferred<GitRemoteStatus>();
			vi.mocked(getRemoteStatus)
				.mockReturnValueOnce(stale.promise)
				.mockReturnValueOnce(current.promise);

			controller.resetForProject('/project-a', { deferMetadata: true });
			const staleLoad = controller.fetchRemoteStatus('/project-a');
			controller.resetForProject('/project-b', { deferMetadata: true });
			const currentLoad = controller.fetchRemoteStatus('/project-b');

			current.resolve(makeRemoteStatus('current'));
			await currentLoad;
			expect(controller.remoteStatus?.branch).toBe('current');

			stale.resolve(makeRemoteStatus('stale'));
			await staleLoad;
			expect(controller.remoteStatus?.branch).toBe('current');
		});

		it('ignores remote status responses invalidated by project reset', async () => {
			const stale = deferred<GitRemoteStatus>();
			vi.mocked(getRemoteStatus).mockReturnValueOnce(stale.promise);

			controller.resetForProject('/project-a', { deferMetadata: true });
			const staleLoad = controller.fetchRemoteStatus('/project-a');
			controller.resetForProject('/project-b', { deferMetadata: true });

			stale.resolve(makeRemoteStatus('stale'));
			await staleLoad;

			expect(controller.remoteStatus).toBeNull();
		});

		it('uses remote status branch when deferred metadata has no branch yet', async () => {
			controller.resetForProject('/project', { deferMetadata: true });
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await controller.fetchRemoteStatus('/project');

			expect(controller.currentBranch).toBe('main');
		});

		it('does not overwrite an explicit current branch from remote status', async () => {
			controller.resetForProject('/project', { deferMetadata: true, currentBranch: 'feature' });
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await controller.fetchRemoteStatus('/project');

			expect(controller.currentBranch).toBe('feature');
		});
	});

	describe('project retargeting', () => {
		it('clears project-scoped presentation and draft state', () => {
			controller.commitMessage = 'commit project A';
			controller.expandedFiles = new Set(['a.txt']);
			controller.selectedFiles = new Set(['a.txt']);
			controller.confirmAction = { type: 'discard', file: 'a.txt' };
			controller.showPushModal = true;
			controller.pushRemotes = [{ name: 'origin', url: 'git@example.com:a.git' }];

			controller.resetForProject('/project-b', { deferMetadata: true });

			expect(controller.commitMessage).toBe('');
			expect(controller.expandedFiles.size).toBe(0);
			expect(controller.selectedFiles.size).toBe(0);
			expect(controller.confirmAction).toBeNull();
			expect(controller.showPushModal).toBe(false);
			expect(controller.pushRemotes).toEqual([]);
		});

		it('does not publish an accepted action from the previous project', async () => {
			const action = deferred<{ success: boolean }>();
			vi.mocked(gitPull).mockReturnValueOnce(action.promise);
			const pending = controller.handlePull('/project');

			controller.resetForProject('/project-b', { deferMetadata: true });
			action.resolve({ success: true });
			await expect(pending).resolves.toBe(true);

			expect(getGitStatus).not.toHaveBeenCalled();
			expect(getRemoteStatus).not.toHaveBeenCalled();
			expect(controller.gitStatus).toBeNull();
			expect(controller.isPulling).toBe(false);
		});
	});

	describe('file selection', () => {
		it('toggleFileSelected adds and removes', () => {
			controller.toggleFileSelected('a.txt');
			expect(controller.selectedFiles.has('a.txt')).toBe(true);
			controller.toggleFileSelected('a.txt');
			expect(controller.selectedFiles.has('a.txt')).toBe(false);
		});

		it('selectAllFiles selects all file types', () => {
			controller.gitStatus = {
				branch: 'main',
				hasCommits: true,
				modified: ['a.txt'],
				added: ['b.txt'],
				deleted: ['c.txt'],
				untracked: ['d.txt'],
			};
			controller.selectAllFiles();
			expect(controller.selectedFiles.size).toBe(4);
		});

		it('deselectAllFiles clears selection', () => {
			controller.selectedFiles = new Set(['a.txt', 'b.txt']);
			controller.deselectAllFiles();
			expect(controller.selectedFiles.size).toBe(0);
		});
	});

	describe('handleCommit', () => {
		it('commits selected files and resets on success', async () => {
			vi.mocked(gitCommit).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'main',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			controller.commitMessage = 'test commit';
			controller.selectedFiles = new Set(['a.txt']);

			await controller.handleCommit('/project');

			expect(gitCommit).toHaveBeenCalledWith('/project', 'test commit', ['a.txt']);
			expect(controller.commitMessage).toBe('');
			expect(controller.selectedFiles.size).toBe(0);
		});

		it('does nothing when no files selected', async () => {
			controller.commitMessage = 'test';
			controller.selectedFiles = new Set();
			await controller.handleCommit('/project');
			expect(gitCommit).not.toHaveBeenCalled();
		});

		it('does nothing when message is empty', async () => {
			controller.commitMessage = '';
			controller.selectedFiles = new Set(['a.txt']);
			await controller.handleCommit('/project');
			expect(gitCommit).not.toHaveBeenCalled();
		});
	});

	describe('handleSwitchBranch', () => {
		it('updates currentBranch on success', async () => {
			vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'feature',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			await controller.handleSwitchBranch('/project', 'feature', undefined, '/project');
			expect(controller.currentBranch).toBe('feature');
			expect(controller.showBranchDropdown).toBe(false);
		});
	});

	describe('confirmAndExecute', () => {
		it('returns true for a successful confirmed pull', async () => {
			vi.mocked(gitPull).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'main',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			vi.mocked(getRemoteStatus).mockResolvedValue(makeRemoteStatus('main'));
			controller.confirmAction = { type: 'pull' };

			const ok = await controller.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitPull).toHaveBeenCalledWith('/project');
			expect(controller.confirmAction).toBeNull();
		});

		it('returns true for a successful confirmed push', async () => {
			vi.mocked(gitPush).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'main',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			vi.mocked(getRemoteStatus).mockResolvedValue(makeRemoteStatus('main'));
			controller.confirmAction = { type: 'push' };

			const ok = await controller.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitPush).toHaveBeenCalledWith('/project', undefined);
			expect(controller.confirmAction).toBeNull();
		});

		it('returns true for a successful confirmed discard', async () => {
			vi.mocked(gitDiscard).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'main',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			controller.selectedFiles = new Set(['a.txt']);
			controller.confirmAction = { type: 'discard', file: 'a.txt' };

			const ok = await controller.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitDiscard).toHaveBeenCalledWith('/project', 'a.txt');
			expect(controller.selectedFiles.has('a.txt')).toBe(false);
		});

		it('returns false and surfaces an error for a failed confirmed push', async () => {
			vi.mocked(gitPush).mockResolvedValue({ success: false, error: 'rejected' });
			controller.confirmAction = { type: 'push' };

			const ok = await controller.confirmAndExecute('/project');

			expect(ok).toBe(false);
			expect(controller.lastError).toBe('rejected');
			expect(controller.confirmAction).toBeNull();
		});
	});

	describe('prepareToolbarPush', () => {
		it('prepares push data when a remote exists without opening presentation state', async () => {
			controller.remoteStatus = {
				hasRemote: true,
				hasUpstream: true,
				branch: 'main',
				remoteName: 'origin',
				ahead: 3,
				behind: 0,
				isUpToDate: false,
			};
			await expect(controller.prepareToolbarPush('/project')).resolves.toBe(true);
			expect(controller.showPushModal).toBe(false);
			expect(controller.pushRemotes).toHaveLength(1);
			expect(controller.pushRemotes[0].name).toBe('origin');
		});

		it('prepares push data when no upstream exists', async () => {
			controller.currentBranch = 'feature-branch';
			controller.remoteStatus = {
				hasRemote: true,
				hasUpstream: false,
				branch: 'feature-branch',
				remoteName: 'origin',
				ahead: 0,
				behind: 0,
				isUpToDate: false,
			};
			await expect(controller.prepareToolbarPush('/project')).resolves.toBe(true);
			expect(controller.showPushModal).toBe(false);
			expect(controller.confirmAction).toBeNull();
		});

		it('does nothing when no remote', async () => {
			controller.remoteStatus = null;
			await expect(controller.prepareToolbarPush('/project')).resolves.toBe(false);
			expect(controller.showPushModal).toBe(false);
		});
	});

	describe('getStatusLabel', () => {
		it('returns correct labels for known statuses', () => {
			expect(controller.getStatusLabel('M')).toBe('Modified');
			expect(controller.getStatusLabel('A')).toBe('Added');
			expect(controller.getStatusLabel('D')).toBe('Deleted');
			expect(controller.getStatusLabel('U')).toBe('Untracked');
		});

		it('returns raw status for unknown codes', () => {
			expect(controller.getStatusLabel('X')).toBe('X');
		});
	});
});
