import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitRemoteStatus } from '$lib/api/git.js';
import { GitPanelStore } from '../git-panel.svelte';

vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
});

vi.mock('$lib/api/git.js', () => ({
	getGitStatus: vi.fn(),
	getGitDiff: vi.fn().mockResolvedValue({}),
	getBranches: vi.fn().mockResolvedValue({ branches: [] }),
	getRemoteStatus: vi.fn().mockResolvedValue({}),
	getGitRemotes: vi
		.fn()
		.mockResolvedValue({ remotes: [{ name: 'origin', url: 'git@github.com:user/repo.git' }] }),
	generateCommitMessage: vi.fn(),
	gitCommit: vi.fn(),
	gitInitialCommit: vi.fn(),
	gitCheckout: vi.fn(),
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
	getBranches,
	getRemoteStatus,
	gitCommit,
	gitCheckout,
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

describe('GitPanelStore', () => {
	let store: GitPanelStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = new GitPanelStore();
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
			await store.fetchGitStatus('/project');
			expect(store.currentBranch).toBe('main');
			expect(store.gitStatus?.modified).toEqual(['a.txt', 'b.txt']);
			expect(store.isLoading).toBe(false);
		});

		it('sets error status on API error', async () => {
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
			await store.fetchGitStatus('/bad-path');
			expect(store.gitStatus?.error).toBe('Not a git repo');
			expect(store.currentBranch).toBe('');
		});
	});

	describe('deferred metadata', () => {
		it('does not fetch branch list or remote status during deferred project reset', () => {
			store.resetForProject('/project', { deferMetadata: true, currentBranch: 'main' });

			expect(store.currentBranch).toBe('main');
			expect(getGitStatus).not.toHaveBeenCalled();
			expect(getBranches).not.toHaveBeenCalled();
			expect(getRemoteStatus).not.toHaveBeenCalled();
		});

		it('loads branches when branch dropdown opens', async () => {
			await store.openBranchDropdown('/project');

			expect(store.showBranchDropdown).toBe(true);
			expect(getBranches).toHaveBeenCalledWith('/project');
		});
	});

	describe('remote status loading', () => {
		it('ignores stale remote status responses after a newer fetch starts', async () => {
			const stale = deferred<GitRemoteStatus>();
			const current = deferred<GitRemoteStatus>();
			vi.mocked(getRemoteStatus)
				.mockReturnValueOnce(stale.promise)
				.mockReturnValueOnce(current.promise);

			const staleLoad = store.fetchRemoteStatus('/project-a');
			const currentLoad = store.fetchRemoteStatus('/project-b');

			current.resolve(makeRemoteStatus('current'));
			await currentLoad;
			expect(store.remoteStatus?.branch).toBe('current');

			stale.resolve(makeRemoteStatus('stale'));
			await staleLoad;
			expect(store.remoteStatus?.branch).toBe('current');
		});

		it('ignores remote status responses invalidated by project reset', async () => {
			const stale = deferred<GitRemoteStatus>();
			vi.mocked(getRemoteStatus).mockReturnValueOnce(stale.promise);

			const staleLoad = store.fetchRemoteStatus('/project-a');
			store.resetForProject('/project-b', { deferMetadata: true });

			stale.resolve(makeRemoteStatus('stale'));
			await staleLoad;

			expect(store.remoteStatus).toBeNull();
		});

		it('uses remote status branch when deferred metadata has no branch yet', async () => {
			store.resetForProject('/project', { deferMetadata: true });
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await store.fetchRemoteStatus('/project');

			expect(store.currentBranch).toBe('main');
		});

		it('does not overwrite an explicit current branch from remote status', async () => {
			store.resetForProject('/project', { deferMetadata: true, currentBranch: 'feature' });
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await store.fetchRemoteStatus('/project');

			expect(store.currentBranch).toBe('feature');
		});
	});

	describe('file selection', () => {
		it('toggleFileSelected adds and removes', () => {
			store.toggleFileSelected('a.txt');
			expect(store.selectedFiles.has('a.txt')).toBe(true);
			store.toggleFileSelected('a.txt');
			expect(store.selectedFiles.has('a.txt')).toBe(false);
		});

		it('selectAllFiles selects all file types', () => {
			store.gitStatus = {
				branch: 'main',
				hasCommits: true,
				modified: ['a.txt'],
				added: ['b.txt'],
				deleted: ['c.txt'],
				untracked: ['d.txt'],
			};
			store.selectAllFiles();
			expect(store.selectedFiles.size).toBe(4);
		});

		it('deselectAllFiles clears selection', () => {
			store.selectedFiles = new Set(['a.txt', 'b.txt']);
			store.deselectAllFiles();
			expect(store.selectedFiles.size).toBe(0);
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
			store.commitMessage = 'test commit';
			store.selectedFiles = new Set(['a.txt']);

			await store.handleCommit('/project');

			expect(gitCommit).toHaveBeenCalledWith('/project', 'test commit', ['a.txt']);
			expect(store.commitMessage).toBe('');
			expect(store.selectedFiles.size).toBe(0);
		});

		it('does nothing when no files selected', async () => {
			store.commitMessage = 'test';
			store.selectedFiles = new Set();
			await store.handleCommit('/project');
			expect(gitCommit).not.toHaveBeenCalled();
		});

		it('does nothing when message is empty', async () => {
			store.commitMessage = '';
			store.selectedFiles = new Set(['a.txt']);
			await store.handleCommit('/project');
			expect(gitCommit).not.toHaveBeenCalled();
		});
	});

	describe('handleSwitchBranch', () => {
		it('updates currentBranch on success', async () => {
			vi.mocked(gitCheckout).mockResolvedValue({ success: true });
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: 'feature',
				hasCommits: true,
				modified: [],
				added: [],
				deleted: [],
				untracked: [],
			});
			await store.handleSwitchBranch('/project', 'feature');
			expect(store.currentBranch).toBe('feature');
			expect(store.showBranchDropdown).toBe(false);
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
			store.confirmAction = { type: 'pull' };

			const ok = await store.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitPull).toHaveBeenCalledWith('/project');
			expect(store.confirmAction).toBeNull();
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
			store.confirmAction = { type: 'push' };

			const ok = await store.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitPush).toHaveBeenCalledWith('/project', undefined, undefined);
			expect(store.confirmAction).toBeNull();
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
			store.selectedFiles = new Set(['a.txt']);
			store.confirmAction = { type: 'discard', file: 'a.txt' };

			const ok = await store.confirmAndExecute('/project');

			expect(ok).toBe(true);
			expect(gitDiscard).toHaveBeenCalledWith('/project', 'a.txt');
			expect(store.selectedFiles.has('a.txt')).toBe(false);
		});

		it('returns false and surfaces an error for a failed confirmed push', async () => {
			vi.mocked(gitPush).mockResolvedValue({ success: false, error: 'rejected' });
			store.confirmAction = { type: 'push' };

			const ok = await store.confirmAndExecute('/project');

			expect(ok).toBe(false);
			expect(store.lastError).toBe('rejected');
			expect(store.confirmAction).toBeNull();
		});
	});

	describe('handleToolbarPush', () => {
		it('shows push modal when remote exists', async () => {
			store.remoteStatus = {
				hasRemote: true,
				hasUpstream: true,
				branch: 'main',
				remoteName: 'origin',
				ahead: 3,
				behind: 0,
				isUpToDate: false,
			};
			await store.handleToolbarPush('/project');
			expect(store.showPushModal).toBe(true);
			expect(store.pushRemotes).toHaveLength(1);
			expect(store.pushRemotes[0].name).toBe('origin');
		});

		it('shows push modal when no upstream (replaces publish flow)', async () => {
			store.currentBranch = 'feature-branch';
			store.remoteStatus = {
				hasRemote: true,
				hasUpstream: false,
				branch: 'feature-branch',
				remoteName: 'origin',
				ahead: 0,
				behind: 0,
				isUpToDate: false,
			};
			await store.handleToolbarPush('/project');
			expect(store.showPushModal).toBe(true);
			expect(store.confirmAction).toBeNull();
		});

		it('does nothing when no remote', async () => {
			store.remoteStatus = null;
			await store.handleToolbarPush('/project');
			expect(store.showPushModal).toBe(false);
		});
	});

	describe('getStatusLabel', () => {
		it('returns correct labels for known statuses', () => {
			expect(store.getStatusLabel('M')).toBe('Modified');
			expect(store.getStatusLabel('A')).toBe('Added');
			expect(store.getStatusLabel('D')).toBe('Deleted');
			expect(store.getStatusLabel('U')).toBe('Untracked');
		});

		it('returns raw status for unknown codes', () => {
			expect(store.getStatusLabel('X')).toBe('X');
		});
	});
});
