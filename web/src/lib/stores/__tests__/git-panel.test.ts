import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitPanelStore } from '../git-panel.svelte';

vi.stubGlobal('localStorage', {
	getItem: () => null, setItem: () => {}, removeItem: () => {},
});

vi.mock('$lib/api/git.js', () => ({
	getGitStatus: vi.fn(),
	getGitDiff: vi.fn().mockResolvedValue({}),
	getBranches: vi.fn().mockResolvedValue({ branches: [] }),
	getRemoteStatus: vi.fn().mockResolvedValue({}),
	getGitRemotes: vi.fn().mockResolvedValue({ remotes: [{ name: 'origin', url: 'git@github.com:user/repo.git' }] }),
	getCommitHistory: vi.fn().mockResolvedValue({ commits: [] }),
	getCommitDiff: vi.fn().mockResolvedValue({}),
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
	gitCommit,
	gitCheckout,
} from '$lib/api/git.js';

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
				added: [], deleted: [], untracked: [],
			});
			await store.fetchGitStatus('/project');
			expect(store.currentBranch).toBe('main');
			expect(store.gitStatus?.modified).toEqual(['a.txt', 'b.txt']);
			expect(store.isLoading).toBe(false);
		});

		it('sets error status on API error', async () => {
			vi.mocked(getGitStatus).mockResolvedValue({
				branch: '', hasCommits: false,
				modified: [], added: [], deleted: [], untracked: [],
				error: 'Not a git repo', details: 'fatal: not a git repository',
			});
			await store.fetchGitStatus('/bad-path');
			expect(store.gitStatus?.error).toBe('Not a git repo');
			expect(store.currentBranch).toBe('');
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
				branch: 'main', hasCommits: true,
				modified: ['a.txt'], added: ['b.txt'],
				deleted: ['c.txt'], untracked: ['d.txt'],
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
				branch: 'main', hasCommits: true,
				modified: [], added: [], deleted: [], untracked: [],
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
				branch: 'feature', hasCommits: true,
				modified: [], added: [], deleted: [], untracked: [],
			});
			await store.handleSwitchBranch('/project', 'feature');
			expect(store.currentBranch).toBe('feature');
			expect(store.showBranchDropdown).toBe(false);
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
