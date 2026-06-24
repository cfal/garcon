import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitTargetDialog from '../GitTargetDialog.svelte';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitTargetCandidate, GitWorktreeItem } from '$lib/api/git';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn(),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
	getGitTargetCandidates: vi.fn(),
}));

function renderDialog(overrides: Record<string, unknown> = {}) {
	return render(GitTargetDialog, {
		initialPath: '/workspace/repo',
		projectBasePath: '/workspace',
		isMobile: false,
		onConfirm: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	});
}

function makeWorktree(path: string, branch: string, isCurrent = false): GitWorktreeItem {
	return {
		name: branch,
		path,
		branch,
		isCurrent,
		isMain: branch === 'main',
		isPathMissing: false,
	};
}

function makeTarget(path: string, branch: string): GitTargetCandidate {
	return {
		projectPath: path,
		repoRoot: '/workspace/repo',
		worktreePath: path,
		label: path,
		branch,
		source: 'worktree',
		isCurrent: true,
		isMissing: false,
	};
}

afterEach(async () => {
	cleanup();
	// Allows bits-ui's delayed body-scroll cleanup to run before happy-dom teardown.
	await new Promise((resolve) => window.setTimeout(resolve, 30));
	vi.clearAllMocks();
});

describe('GitTargetDialog', () => {
	it('rejects valid folders that are not Git repositories', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });
		const onConfirm = vi.fn();

		renderDialog({ initialPath: '/workspace/plain-folder', onConfirm });

		expect(await screen.findByText('Not a Git repository.')).toBeTruthy();
		const okButton = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;

		expect(okButton.disabled).toBe(true);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('returns from worktree selection to the folder dialog and applies only on OK', async () => {
		const selectedPath = '/workspace/repo-feature';
		const target = makeTarget(selectedPath, 'feature');
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [makeWorktree('/workspace/repo', 'main', true), makeWorktree(selectedPath, 'feature')],
		});
		vi.mocked(gitApi.getGitTargetCandidates).mockResolvedValue({ targets: [target] });
		const onConfirm = vi.fn();

		renderDialog({ onConfirm });

		const selectWorktree = await screen.findByRole('button', {
			name: 'Select a different worktree',
		});
		await fireEvent.click(selectWorktree);

		const worktreeDialog = await screen.findByRole('dialog', { name: 'Select worktree' });
		expect(worktreeDialog).toBeTruthy();
		await fireEvent.click(await screen.findByRole('option', { name: /feature/ }));

		const folderDialog = await screen.findByRole('dialog', { name: 'Git target' });
		expect(folderDialog).toBeTruthy();
		expect((screen.getByLabelText('Project Path') as HTMLInputElement).value).toBe(selectedPath);
		expect(onConfirm).not.toHaveBeenCalled();

		const okButton = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;
		await waitFor(() => {
			expect(okButton.disabled).toBe(false);
		});
		await fireEvent.click(okButton);

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledWith(target);
		});
	});
});
