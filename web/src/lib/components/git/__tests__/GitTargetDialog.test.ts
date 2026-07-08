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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
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

	it('shows pinned project paths and applies a selected path to the target input', async () => {
		const pinnedPath = '/workspace/pinned-repo';
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });

		renderDialog({ pinnedProjectPaths: [pinnedPath] });

		await fireEvent.click(screen.getByRole('button', { name: pinnedPath }));

		expect((screen.getByLabelText('Project Path') as HTMLInputElement).value).toBe(pinnedPath);
		await waitFor(() => {
			expect(chatsApi.validateStart).toHaveBeenCalledWith(
				pinnedPath,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		});
	});

	it('requests pinning the current target path', async () => {
		const onTogglePinnedProjectPath = vi.fn();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });

		renderDialog({ onTogglePinnedProjectPath });

		await fireEvent.click(screen.getByRole('button', { name: 'Pin project path' }));

		expect(onTogglePinnedProjectPath).toHaveBeenCalledWith('/workspace/repo');
	});

	it('shows a loading indicator while the pin update is pending', async () => {
		const pending = deferred<void>();
		const onTogglePinnedProjectPath = vi.fn(() => pending.promise);
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });

		renderDialog({ onTogglePinnedProjectPath });

		const toggleButton = screen.getByRole('button', { name: 'Pin project path' });
		await fireEvent.click(toggleButton);

		const pathInput = screen.getByLabelText('Project Path') as HTMLInputElement;
		const browseButton = screen.getByRole('button', { name: 'Browse folders' }) as HTMLButtonElement;
		const okButton = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;
		expect(toggleButton.getAttribute('aria-busy')).toBe('true');
		expect(toggleButton.querySelector('.animate-spin')).toBeTruthy();
		expect(pathInput.readOnly).toBe(true);
		expect(browseButton.disabled).toBe(true);
		await waitFor(() => {
			expect(okButton.disabled).toBe(false);
		});

		pending.resolve();
		await waitFor(() => {
			expect(toggleButton.getAttribute('aria-busy')).toBe('false');
		});
	});

	it('requests unpinning the current target path when it is already pinned', async () => {
		const onTogglePinnedProjectPath = vi.fn();
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });

		renderDialog({
			pinnedProjectPaths: ['/workspace/repo'],
			onTogglePinnedProjectPath,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Unpin project path' }));

		expect(onTogglePinnedProjectPath).toHaveBeenCalledWith('/workspace/repo');
	});
});
