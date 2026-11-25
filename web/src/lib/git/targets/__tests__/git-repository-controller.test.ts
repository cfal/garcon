import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitRemoteStatus } from '$lib/api/git.js';
import { GitRepositoryController } from '$lib/git/targets/git-repository-controller.svelte.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import { ApiError } from '$lib/api/client.js';

vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
});

vi.mock('$lib/api/git.js', () => ({
	getGitStatus: vi.fn(),
	getRemoteStatus: vi.fn().mockResolvedValue({}),
	getGitRemotes: vi
		.fn()
		.mockResolvedValue({ remotes: [{ name: 'origin', url: 'git@github.com:user/repo.git' }] }),
	gitPush: vi.fn(),
}));

import { getGitStatus, getRemoteStatus, gitPush } from '$lib/api/git.js';

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
	let branches: GitBranchSelectorState;
	let controller: GitRepositoryController;

	beforeEach(() => {
		vi.clearAllMocks();
		branches = new GitBranchSelectorState();
		controller = new GitRepositoryController(branches);
		controller.resetForProject(
			{ executorId: 'local', projectPath: '/project' },
			{ deferMetadata: true },
		);
	});

	afterEach(() => controller.dismissError());

	describe('remote status loading', () => {
		it('ignores stale remote status responses after a newer fetch starts', async () => {
			const stale = deferred<GitRemoteStatus>();
			const current = deferred<GitRemoteStatus>();
			vi.mocked(getRemoteStatus)
				.mockReturnValueOnce(stale.promise)
				.mockReturnValueOnce(current.promise);

			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-a' },
				{ deferMetadata: true },
			);
			const staleLoad = controller.fetchRemoteStatus({
				executorId: 'local',
				projectPath: '/project-a',
			});
			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-b' },
				{ deferMetadata: true },
			);
			const currentLoad = controller.fetchRemoteStatus({
				executorId: 'local',
				projectPath: '/project-b',
			});

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

			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-a' },
				{ deferMetadata: true },
			);
			const staleLoad = controller.fetchRemoteStatus({
				executorId: 'local',
				projectPath: '/project-a',
			});
			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-b' },
				{ deferMetadata: true },
			);

			stale.resolve(makeRemoteStatus('stale'));
			await staleLoad;

			expect(controller.remoteStatus).toBeNull();
		});

		it('uses remote status branch when deferred metadata has no branch yet', async () => {
			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project' },
				{ deferMetadata: true },
			);
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await controller.fetchRemoteStatus({ executorId: 'local', projectPath: '/project' });

			expect(branches.currentBranch).toBe('main');
		});

		it('does not overwrite an explicit current branch from remote status', async () => {
			branches.currentBranch = 'feature';
			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project' },
				{ deferMetadata: true },
			);
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));

			await controller.fetchRemoteStatus({ executorId: 'local', projectPath: '/project' });

			expect(branches.currentBranch).toBe('feature');
		});

		it('clears remote status without logging an executor outage', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			controller.remoteStatus = makeRemoteStatus('main');
			vi.mocked(getRemoteStatus).mockRejectedValueOnce(
				new ApiError(503, 'Executor is unavailable', 'EXECUTOR_UNAVAILABLE', undefined, true),
			);

			await controller.fetchRemoteStatus({ executorId: 'local', projectPath: '/project' });

			expect(controller.remoteStatus).toBeNull();
			expect(consoleError).not.toHaveBeenCalled();
			consoleError.mockRestore();
		});

		it('logs other remote status failures', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const failure = new ApiError(500, 'Remote status failed', 'INTERNAL_ERROR');
			vi.mocked(getRemoteStatus).mockRejectedValueOnce(failure);

			await controller.fetchRemoteStatus({ executorId: 'local', projectPath: '/project' });

			expect(controller.remoteStatus).toBeNull();
			expect(consoleError).toHaveBeenCalledWith('[Git] Error fetching remote status:', failure);
			consoleError.mockRestore();
		});
	});

	describe('project retargeting', () => {
		it('clears project-scoped presentation and draft state', () => {
			controller.pushPrompt = {
				project: { executorId: 'local', projectPath: '/project' },
				branch: 'main',
				remotes: [{ name: 'origin', url: 'git@example.com:a.git' }],
				selectedRemote: 'origin',
			};

			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-b' },
				{ deferMetadata: true },
			);

			expect(controller.pushPrompt).toBeNull();
		});

		it('does not publish an accepted action from the previous project', async () => {
			const action = deferred<{ success: boolean }>();
			vi.mocked(gitPush).mockReturnValueOnce(action.promise);
			const pending = controller.handlePush({ executorId: 'local', projectPath: '/project' });

			controller.resetForProject(
				{ executorId: 'local', projectPath: '/project-b' },
				{ deferMetadata: true },
			);
			action.resolve({ success: true });
			await expect(pending).resolves.toBe(true);

			expect(getGitStatus).not.toHaveBeenCalled();
			expect(getRemoteStatus).not.toHaveBeenCalled();
			expect(controller.isPushing).toBe(false);
		});
	});

	describe('handlePush', () => {
		it.each(['suspend', 'switch'] as const)(
			'publishes uncertain push failures for the captured target after %s',
			async (transition) => {
				const project = { executorId: 'remote', projectPath: '/project' };
				controller.resetForProject(project, { deferMetadata: true });
				const push = deferred<Awaited<ReturnType<typeof gitPush>>>();
				vi.mocked(gitPush).mockReturnValueOnce(push.promise);
				const onMutationError = vi.fn();
				const onChanged = vi.fn();
				const mutations = new GitMutationCoordinator({ onMutationError, onChanged });
				const failure = new ApiError(
					503,
					'Push outcome is unknown. Inspect the remote.',
					'GIT_MUTATION_OUTCOME_UNKNOWN',
				);
				const pending = mutations.run({
					...project,
					surfaceId: 'singleton:git',
					effectiveProjectKey: '/project',
					execute: () => controller.handlePush(project),
				});
				const rejected = expect(pending).rejects.toBe(failure);
				if (transition === 'suspend') controller.suspend();
				else
					controller.resetForProject(
						{ executorId: 'local', projectPath: '/other' },
						{ deferMetadata: true },
					);
				push.reject(failure);
				await rejected;
				expect(onMutationError).toHaveBeenCalledExactlyOnceWith(failure, 'remote', '/project');
				expect(onChanged).toHaveBeenCalledExactlyOnceWith('remote', '/project', '/project');
				expect(controller.lastError).toBeNull();
				expect(mutations.pendingCount('singleton:git')).toBe(0);
			},
		);

		it('refreshes remote status only after a successful push', async () => {
			const project = { executorId: 'local', projectPath: '/project' };
			vi.mocked(gitPush).mockResolvedValueOnce({ success: true });
			vi.mocked(getRemoteStatus).mockResolvedValueOnce(makeRemoteStatus('main'));
			await expect(controller.handlePush(project, 'origin', 'main')).resolves.toBe(true);
			expect(getRemoteStatus).toHaveBeenCalledExactlyOnceWith(project);
			expect(getGitStatus).not.toHaveBeenCalled();
		});

		it('sends the confirmed branch so the executor can reject a changed HEAD', async () => {
			const project = { executorId: 'local', projectPath: '/project' };
			vi.mocked(gitPush).mockResolvedValue({ success: false, error: 'Branch changed' });
			expect(await controller.handlePush(project, 'origin', 'main')).toBe(false);
			expect(gitPush).toHaveBeenCalledWith(project, 'origin', 'main');
			expect(controller.lastError).toBe('Branch changed');
		});

		it('cancels the error timer on dismiss, suspend and reset', async () => {
			vi.useFakeTimers();
			try {
				const project = { executorId: 'local', projectPath: '/project' };
				for (const clear of [
					() => controller.dismissError(),
					() => controller.suspend(),
					() => controller.resetForProject(project, { deferMetadata: true }),
				]) {
					vi.mocked(gitPush).mockResolvedValueOnce({ success: false, error: 'rejected' });
					await expect(controller.handlePush(project)).resolves.toBe(false);
					expect(controller.lastError).toBe('rejected');
					expect(vi.getTimerCount()).toBe(1);
					clear();
					expect(vi.getTimerCount()).toBe(0);
					expect(controller.lastError).toBeNull();
				}
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('preparePush', () => {
		it('captures the branch and selects the default remote', async () => {
			branches.currentBranch = 'main';
			controller.remoteStatus = {
				hasRemote: true,
				hasUpstream: true,
				branch: 'main',
				remoteName: 'origin',
				ahead: 3,
				behind: 0,
				isUpToDate: false,
			};
			await controller.preparePush({
				executorId: 'local',
				projectPath: '/project',
			});
			expect(controller.pushPrompt).toMatchObject({ branch: 'main', selectedRemote: 'origin' });
		});

		it('prepares push data when no upstream exists', async () => {
			branches.currentBranch = 'feature-branch';
			controller.remoteStatus = {
				hasRemote: true,
				hasUpstream: false,
				branch: 'feature-branch',
				remoteName: 'origin',
				ahead: 0,
				behind: 0,
				isUpToDate: false,
			};
			await controller.preparePush({ executorId: 'local', projectPath: '/project' });
			expect(controller.pushPrompt?.branch).toBe('feature-branch');
		});

		it('does nothing when no remote', async () => {
			controller.remoteStatus = null;
			await controller.preparePush({ executorId: 'local', projectPath: '/project' });
			expect(controller.pushPrompt).toBeNull();
		});
	});
});
