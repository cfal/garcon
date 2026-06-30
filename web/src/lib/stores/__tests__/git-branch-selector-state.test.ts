import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '../git/git-branch-selector-state.svelte';
import { getBranches, gitCheckout, gitCreateBranch } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getBranches: vi.fn(),
	gitCheckout: vi.fn(),
	gitCreateBranch: vi.fn(),
}));

describe('GitBranchSelectorState', () => {
	let branchSelector: GitBranchSelectorState;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getBranches).mockResolvedValue({ branches: ['main', 'feature'] });
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
		vi.mocked(gitCheckout).mockResolvedValue({ success: true });

		const ok = await branchSelector.switchBranch('/project', 'feature');

		expect(ok).toBe(true);
		expect(gitCheckout).toHaveBeenCalledWith('/project', 'feature');
		expect(getBranches).toHaveBeenCalledWith('/project');
		expect(onMutation).toHaveBeenCalledWith('/project', 'switch');
		expect(branchSelector.currentBranch).toBe('feature');
		expect(branchSelector.showBranchDropdown).toBe(false);
	});

	it('creates trimmed branches and clears modal state after success', async () => {
		const onMutation = vi.fn();
		branchSelector = new GitBranchSelectorState({ onMutation });
		branchSelector.showNewBranchModal = true;
		branchSelector.newBranchName = '  feature/new-ui  ';
		vi.mocked(gitCreateBranch).mockResolvedValue({ success: true });

		const ok = await branchSelector.createBranch('/project');

		expect(ok).toBe(true);
		expect(gitCreateBranch).toHaveBeenCalledWith('/project', 'feature/new-ui');
		expect(getBranches).toHaveBeenCalledWith('/project');
		expect(onMutation).toHaveBeenCalledWith('/project', 'create');
		expect(branchSelector.currentBranch).toBe('feature/new-ui');
		expect(branchSelector.showNewBranchModal).toBe(false);
		expect(branchSelector.newBranchName).toBe('');
	});
});
