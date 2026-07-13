import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '../git/git-branch-selector-state.svelte';
import { getGitRefs, gitCheckoutRef, gitCreateBranch } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitRefs: vi.fn(),
	gitCheckoutRef: vi.fn(),
	gitCreateBranch: vi.fn(),
}));

describe('GitBranchSelectorState', () => {
	let branchSelector: GitBranchSelectorState;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getGitRefs).mockResolvedValue({
			refs: [
				{ name: 'main', ref: 'refs/heads/main', kind: 'local-branch', isCurrent: true },
				{ name: 'feature', ref: 'refs/heads/feature', kind: 'local-branch' },
				{ name: 'origin/main', ref: 'refs/remotes/origin/main', kind: 'remote-branch' },
			],
		});
		branchSelector = new GitBranchSelectorState();
	});

	it('reuses branch data for the same project and resets on project changes', () => {
		branchSelector.setProject('/project-a', 'main');
		branchSelector.branches = ['main'];
		branchSelector.showBranchDropdown = true;

		branchSelector.setProject('/project-a', 'feature');

		expect(branchSelector.currentBranch).toBe('feature');
		expect(branchSelector.branches).toEqual(['main']);
		expect(branchSelector.showBranchDropdown).toBe(true);

		branchSelector.setProject('/project-b', 'main');

		expect(branchSelector.currentProjectPath).toBe('/project-b');
		expect(branchSelector.currentBranch).toBe('main');
		expect(branchSelector.branches).toEqual([]);
		expect(branchSelector.showBranchDropdown).toBe(false);
	});

	it('switches branches, refreshes branches, and notifies after mutation', async () => {
		const onMutation = vi.fn();
		branchSelector = new GitBranchSelectorState({ onMutation });
		branchSelector.showBranchDropdown = true;
		branchSelector.refs = [{ name: 'feature', ref: 'refs/heads/feature', kind: 'local-branch' }];
		vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });

		const ok = await branchSelector.switchBranch('/project', 'feature');

		expect(ok).toBe(true);
			expect(gitCheckoutRef).toHaveBeenCalledWith('/project', 'refs/heads/feature', 'local-branch');
		expect(getGitRefs).toHaveBeenCalledWith('/project', { query: '', limit: 200 });
		expect(onMutation).toHaveBeenCalledWith('/project', 'switch', '/project');
		expect(branchSelector.currentBranch).toBe('feature');
		expect(branchSelector.showBranchDropdown).toBe(false);
	});

	it('checks out remote refs using their full ref value', async () => {
		branchSelector.refs = [
			{ name: 'origin/main', ref: 'refs/remotes/origin/main', kind: 'remote-branch' },
		];
		vi.mocked(gitCheckoutRef).mockResolvedValue({ success: true });

		const ok = await branchSelector.switchBranch('/project', 'origin/main');

		expect(ok).toBe(true);
			expect(gitCheckoutRef).toHaveBeenCalledWith('/project', 'refs/remotes/origin/main', 'remote-branch');
		expect(branchSelector.currentBranch).toBe('origin/main');
	});

	it('creates trimmed branches and clears modal state after success', async () => {
		const onMutation = vi.fn();
		branchSelector = new GitBranchSelectorState({ onMutation });
		branchSelector.showNewBranchModal = true;
		branchSelector.newBranchName = '  feature/new-ui  ';
		branchSelector.newBranchBaseRef = 'refs/remotes/origin/main';
		vi.mocked(gitCreateBranch).mockResolvedValue({ success: true });

		const ok = await branchSelector.createBranch('/project');

		expect(ok).toBe(true);
		expect(gitCreateBranch).toHaveBeenCalledWith('/project', 'feature/new-ui', {
			baseRef: 'refs/remotes/origin/main',
		});
		expect(getGitRefs).toHaveBeenCalledWith('/project', { query: '', limit: 200 });
		expect(onMutation).toHaveBeenCalledWith('/project', 'create', '/project');
		expect(branchSelector.currentBranch).toBe('feature/new-ui');
		expect(branchSelector.showNewBranchModal).toBe(false);
		expect(branchSelector.newBranchName).toBe('');
		expect(branchSelector.newBranchBaseRef).toBe('');
	});
});
