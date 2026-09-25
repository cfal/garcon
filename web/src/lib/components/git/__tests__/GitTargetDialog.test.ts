import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitTargetDialog from './GitTargetDialogTestHost.svelte';
import * as chatsApi from '$lib/api/chats';
import * as gitApi from '$lib/api/git';
import type { GitTargetCandidate, GitWorktreeItem } from '$lib/api/git';
import { flushSync } from 'svelte';
import {
	localExecutor,
	remoteExecutor,
} from '$lib/executors/__tests__/fixtures.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { ApiError } from '$lib/api/client.js';

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
		executorId: 'local',
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
		lastModifiedAt: null,
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
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('GitTargetDialog', () => {
	it('notifies creation uncertainty after the selected executor disconnects', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [makeWorktree('/workspace/repo', 'main', true)],
		});
		const creation = deferred<Awaited<ReturnType<typeof gitApi.gitCreateWorktree>>>();
		vi.mocked(gitApi.gitCreateWorktree).mockReturnValueOnce(creation.promise);
		const remote = {
			...remoteExecutor,
			machineServices: { ...remoteExecutor.machineServices, git: true },
		};
		const notifications = new NotificationsStore();
		let executors!: ExecutorsStore;
		renderDialog({
			executorId: remote.id,
			executors: [localExecutor, remote],
			notifications,
			onExecutors: (store: ExecutorsStore) => {
				executors = store;
			},
		});
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Select a different worktree' }),
		);
		await screen.findByRole('option', { name: /main/ });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		await fireEvent.input(screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)'), {
			target: { value: 'feature' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		expect((screen.getByRole('button', { name: 'Refresh worktrees' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		flushSync(() =>
			executors.applySnapshot([localExecutor, { ...remote, availability: 'offline' }]),
		);
		creation.reject(
			new ApiError(503, 'Worktree creation outcome unknown', 'GIT_MUTATION_OUTCOME_UNKNOWN'),
		);
		await waitFor(() => expect(notifications.items).toHaveLength(1));
		expect(notifications.items[0].message).toBe(
			`${remote.label}: /workspace/repo: Worktree creation outcome unknown`,
		);
		expect(screen.queryByText('Worktree creation outcome unknown')).toBeNull();
	});

	it('retains remote worktree creation through unrelated executor snapshot changes', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: true });
		vi.mocked(gitApi.getGitWorktrees).mockResolvedValue({
			worktrees: [makeWorktree('/workspace/repo', 'main', true)],
		});
		const creation = deferred<Awaited<ReturnType<typeof gitApi.gitCreateWorktree>>>();
		vi.mocked(gitApi.gitCreateWorktree).mockReturnValueOnce(creation.promise);
		const remote = {
			...remoteExecutor,
			machineServices: { ...remoteExecutor.machineServices, git: true },
		};
		let executors!: ExecutorsStore;
		renderDialog({
			executorId: remote.id,
			executors: [localExecutor, remote],
			onExecutors: (store: ExecutorsStore) => {
				executors = store;
			},
		});
		await fireEvent.click(
			await screen.findByRole('button', { name: 'Select a different worktree' }),
		);
		await screen.findByRole('option', { name: /main/ });
		await fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
		await fireEvent.input(screen.getByPlaceholderText('Branch name (e.g. fix/login-bug)'), {
			target: { value: 'feature' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		expect(gitApi.gitCreateWorktree).toHaveBeenCalledOnce();
		const validations = vi.mocked(chatsApi.validateStart).mock.calls.length;
		flushSync(() =>
			executors.applySnapshot([{ ...localExecutor, availability: 'offline' }, remote]),
		);
		creation.resolve({ success: true, worktreePath: '/workspace/repo/.worktrees/feature' });
		await screen.findByRole('dialog', { name: 'Git target' });
		expect((screen.getByLabelText('Project Path') as HTMLInputElement).value).toBe(
			'/workspace/repo/.worktrees/feature',
		);
		expect(vi.mocked(chatsApi.validateStart).mock.calls.length).toBe(validations);
	});

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
			worktrees: [
				makeWorktree('/workspace/repo', 'main', true),
				makeWorktree(selectedPath, 'feature'),
			],
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
		const browseButton = screen.getByRole('button', {
			name: 'Browse folders',
		}) as HTMLButtonElement;
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
