import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import GitTopToolbar from '../GitTopToolbar.svelte';
import type { GitRemoteStatus } from '$lib/api/git';

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

function renderToolbar(overrides: Record<string, unknown> = {}) {
	return render(GitTopToolbar, {
		isMobile: false,
		activeView: 'changes',
		currentBranch: 'main',
		branches: ['main', 'feature/search', 'bugfix/login'],
		remoteStatus: null,
		targets: [],
		activeWorktreePath: null,
		isLoadingTargets: false,
		showBranchDropdown: false,
		isLoading: false,
		isPushing: false,
		reviewCount: 0,
		canCommit: false,
		isCommitting: false,
		canPush: false,
		diffMode: 'unified',
		contextLines: 5,
		diffFontSize: '12',
		onToggleBranchDropdown: vi.fn(),
		onCloseBranchDropdown: vi.fn(),
		onShowNewBranchModal: vi.fn(),
		onSwitchBranch: vi.fn(),
		onViewCommits: vi.fn(),
		onViewChanges: vi.fn(),
		onOpenReview: vi.fn(),
		onCommit: vi.fn(),
		onPush: vi.fn(),
		onSetDiffMode: vi.fn(),
		onSetContextLines: vi.fn(),
		onSetDiffFontSize: vi.fn(),
		onOpenCommitSettings: vi.fn(),
		onRevert: vi.fn(),
		onRefresh: vi.fn(),
		...overrides,
	});
}

describe('GitTopToolbar', () => {
	it('uses the remote branch as the branch button label when current branch is not loaded yet', () => {
		renderToolbar({
			currentBranch: '',
			remoteStatus: makeRemoteStatus('main'),
		});

		expect(screen.getByRole('button', { name: /current branch main/i })).toBeTruthy();
		expect(screen.getByText('main')).toBeTruthy();
	});

	it('filters branches in the branch combobox and switches to the selected branch', async () => {
		const onSwitchBranch = vi.fn();
		renderToolbar({
			showBranchDropdown: true,
			onSwitchBranch,
		});

		const search = screen.getByRole('combobox', { name: 'Find a branch' });
		await fireEvent.input(search, { target: { value: 'feature' } });

		const branch = screen.getByRole('option', { name: 'feature/search' });
		expect(branch).toBeTruthy();
		expect(screen.queryByRole('option', { name: 'main' })).toBeNull();

		await fireEvent.click(branch);

		expect(onSwitchBranch).toHaveBeenCalledWith('feature/search');
	});
});
