import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GitTargetSessionController,
	type GitTargetChangeReason,
	type GitTargetSessionDeps,
} from '$lib/git/targets/git-target-session.svelte.js';
import { GitProjectInvalidationStore } from '$lib/git/surface/git-project-invalidation.svelte.js';
import {
	GitBranchSelectorState,
	type GitBranchSelectorStateOptions,
} from '$lib/git/targets/git-branch-selector-state.svelte.js';
import type { GitTargetCandidate } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
}));

const api = vi.mocked(await import('$lib/api/git.js'));

function candidate(
	projectPath: string,
	overrides: Partial<GitTargetCandidate> = {},
): GitTargetCandidate {
	return {
		projectPath,
		repoRoot: '/repo',
		worktreePath: projectPath,
		label: projectPath.split('/').pop() ?? projectPath,
		branch: 'main',
		source: 'chat-project',
		isCurrent: true,
		isMissing: false,
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createSession(options: {
	kind?: 'git' | 'git-history' | 'git-compare' | 'commit';
	canChangeTarget?: () => boolean;
	invalidationVersion?: GitTargetSessionDeps['invalidationVersion'];
	runMutation?: GitBranchSelectorStateOptions['runMutation'];
	afterCheckout?: (projectPath: string) => void | Promise<void>;
}) {
	const changes: Array<{
		path: string | null;
		identity: string | null;
		reason: GitTargetChangeReason;
		identityChanged: boolean;
	}> = [];
	const selectors: GitBranchSelectorState[] = [];
	const session = new GitTargetSessionController({
		kind: options.kind ?? 'git-history',
		createBranchSelector: () => {
			const selector = new GitBranchSelectorState({
				runMutation: options.runMutation,
			});
			selectors.push(selector);
			return selector;
		},
		invalidationVersion: options.invalidationVersion ?? (() => 0),
		canChangeTarget: options.canChangeTarget ?? (() => true),
		afterCheckout: options.afterCheckout,
		onTargetChanged: (target, identity, reason, identityChanged) => {
			changes.push({
				path: target?.projectPath ?? null,
				identity,
				reason,
				identityChanged,
			});
		},
	});
	return { session, changes, selector: selectors[0]! };
}

function setProject(
	session: GitTargetSessionController,
	projectPath: string,
	effectiveProjectKey = projectPath,
	executorId = 'local',
	executorContextKey = 'session-a',
): void {
	session.setProjectState({
		kind: 'available',
		project: {
			chatId: effectiveProjectKey,
			executorId,
			executorContextKey,
			projectPath,
			effectiveProjectKey,
		},
	});
}

describe('GitTargetSessionController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getGitTargetCandidates.mockReset();
		api.getGitTargetCandidates.mockResolvedValue({ targets: [] });
	});

	it('fences held same-path discovery when switching executors', async () => {
		const local = deferred<{ targets: GitTargetCandidate[] }>();
		api.getGitTargetCandidates
			.mockReturnValueOnce(local.promise)
			.mockResolvedValueOnce({ targets: [candidate('/repo', { branch: 'remote' })] });
		const { session } = createSession({});
		setProject(session, '/repo', 'chat', 'local');
		session.setPresentationVisible(true);
		const localActivation = session.activate();
		setProject(session, '/repo', 'chat', 'remote');
		await session.activate();
		local.resolve({ targets: [candidate('/repo', { branch: 'local' })] });
		await localActivation;
		expect(session.activeTarget).toMatchObject({ executorId: 'remote', branch: 'remote' });
		expect(api.getGitTargetCandidates.mock.calls.map(([target]) => target.executorId)).toEqual([
			'local',
			'remote',
		]);
		session.dispose();
	});

	it.each([true, false])(
		'reloads a replacement executor session without changing target (visible=%s)',
		async (visible) => {
			const { session, changes } = createSession({});
			setProject(session, '/repo', 'chat', 'remote', 'instance-a');
			session.setPresentationVisible(true);
			await session.activate();
			const identity = session.identity;
			session.setPresentationVisible(visible);
			setProject(session, '/repo', 'chat', 'remote', 'instance-b');
			if (!visible) {
				expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(1);
				session.setPresentationVisible(true);
			}
			await session.activate();
			expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
			expect(session.identity).toBe(identity);
			expect(changes.at(-1)).toMatchObject({ reason: 'session', identityChanged: false });
			session.dispose();
		},
	);

	it('keeps discovery gated by visibility and applies the chat fallback once', async () => {
		const { session, changes } = createSession({});
		setProject(session, '/chat');

		expect(session.activeProjectPath).toBe('/chat');
		expect(api.getGitTargetCandidates).not.toHaveBeenCalled();

		session.setPresentationVisible(true);
		await session.activate();

		expect(api.getGitTargetCandidates).toHaveBeenCalledOnce();
		expect(api.getGitRefs).not.toHaveBeenCalled();
		expect(changes).toEqual([
			expect.objectContaining({
				path: '/chat',
				reason: 'project',
				identityChanged: true,
			}),
		]);
	});

	it('does not publish discovery that resolves while project identity is pending', async () => {
		const load = deferred<{ targets: GitTargetCandidate[] }>();
		let signal: AbortSignal | undefined;
		api.getGitTargetCandidates
			.mockImplementationOnce((_projectPath, options) => {
				signal = options?.signal ?? undefined;
				return load.promise;
			})
			.mockResolvedValueOnce({ targets: [candidate('/old/worktree')] });
		const { session, changes } = createSession({});
		setProject(session, '/old', 'chat-old');
		session.setPresentationVisible(true);
		const activation = session.activate();
		session.projectSelection.showFolderDialog = true;
		session.branches.showBranchDropdown = true;

		session.setProjectState({
			kind: 'resolving',
			context: {
				chatId: 'draft',
				projectPath: '/new',
			},
		});
		expect(signal?.aborted).toBe(true);
		expect(session.projectSelection.showFolderDialog).toBe(false);
		expect(session.branches.showBranchDropdown).toBe(false);
		load.resolve({ targets: [candidate('/old/worktree')] });
		await activation;

		expect(session.activeProjectPath).toBe('/old');
		expect(changes).toEqual([]);

		setProject(session, '/old', 'chat-old');
		await session.activate();

		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
		expect(session.activeProjectPath).toBe('/old/worktree');
		expect(session.isLoadingTargets).toBe(false);
	});

	it('aborts discovery and closes dialogs for a definitive unavailable project', async () => {
		const load = deferred<{ targets: GitTargetCandidate[] }>();
		let signal: AbortSignal | undefined;
		api.getGitTargetCandidates.mockImplementationOnce((_projectPath, options) => {
			signal = options?.signal ?? undefined;
			return load.promise;
		});
		const { session, changes } = createSession({});
		setProject(session, '/project', 'chat-project');
		session.setPresentationVisible(true);
		const activation = session.activate();
		session.projectSelection.showFolderDialog = true;
		session.branches.showBranchDropdown = true;

		session.setProjectState({
			kind: 'unavailable',
			context: { chatId: 'chat-project', projectPath: '/project' },
			reason: 'not-found',
		});

		expect(signal?.aborted).toBe(true);
		expect(session.projectSelection.showFolderDialog).toBe(false);
		expect(session.branches.showBranchDropdown).toBe(false);
		expect(session.isLoadingTargets).toBe(false);
		load.resolve({ targets: [candidate('/stale')] });
		await activation;
		expect(changes).toEqual([]);
		expect(session.activeProjectPath).toBe('/project');
		expect(session.targets).toEqual([]);
	});

	it('starts a new activation when the same project recovers after a definitive failure', async () => {
		api.getGitTargetCandidates
			.mockImplementationOnce((_projectPath, options) => {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					);
				});
			})
			.mockResolvedValueOnce({ targets: [candidate('/project')] });
		const { session, changes } = createSession({});
		setProject(session, '/project', 'chat-project');
		session.setPresentationVisible(true);
		void session.activate();
		await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(1));

		session.setProjectState({
			kind: 'request-failed',
			context: { chatId: 'chat-project', projectPath: '/project' },
			message: 'Project check failed',
		});
		setProject(session, '/project', 'chat-project');
		await session.activate();

		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
		expect(changes.filter((change) => change.reason === 'session')).toHaveLength(1);
	});

	it.each(['unavailable', 'request-failed'] as const)(
		'does not apply an invalidation after project identity becomes %s',
		async (kind) => {
			api.getGitTargetCandidates.mockResolvedValueOnce({ targets: [candidate('/project')] });
			const { session, changes } = createSession({});
			setProject(session, '/project', 'chat-project');
			session.setPresentationVisible(true);
			await session.activate();
			api.getGitTargetCandidates.mockImplementationOnce((_projectPath, options) => {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					);
				});
			});

			const refreshing = session.refreshForInvalidation('chat-project', 1);
			await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2));
			session.setProjectState(
				kind === 'unavailable'
					? {
							kind,
							context: { chatId: 'chat-project', projectPath: '/project' },
							reason: 'not-found',
						}
					: {
							kind,
							context: { chatId: 'chat-project', projectPath: '/project' },
							message: 'Project check failed',
						},
			);
			setProject(session, '/project', 'chat-project');

			await expect(refreshing).resolves.toBe(false);
			expect(changes.filter((change) => change.reason === 'invalidation')).toEqual([]);
		},
	);

	it('does not apply a manual target refresh after project identity fails', async () => {
		const recovery = deferred<{ targets: GitTargetCandidate[] }>();
		api.getGitTargetCandidates.mockResolvedValueOnce({ targets: [candidate('/project')] });
		const { session, changes } = createSession({});
		setProject(session, '/project', 'chat-project');
		session.setPresentationVisible(true);
		await session.activate();
		api.getGitTargetCandidates.mockImplementationOnce((_projectPath, options) => {
			return new Promise((_resolve, reject) => {
				options?.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('Aborted', 'AbortError')),
					{ once: true },
				);
			});
		});
		api.getGitTargetCandidates.mockReturnValueOnce(recovery.promise);

		const refreshing = session.refreshTargets();
		await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2));
		session.setProjectState({
			kind: 'unavailable',
			context: { chatId: 'chat-project', projectPath: '/project' },
			reason: 'not-found',
		});
		setProject(session, '/project', 'chat-project');
		const recoveryActivation = session.activate();

		await refreshing;
		expect(changes.map((change) => change.reason)).toEqual(['project']);
		recovery.resolve({ targets: [candidate('/recovered')] });
		await recoveryActivation;
		expect(changes.map((change) => change.reason)).toEqual(['project', 'session']);
		expect(session.activeProjectPath).toBe('/recovered');
	});

	it('retains an explicit worktree across chat switches and returns to the actual chat project', async () => {
		api.getGitTargetCandidates
			.mockResolvedValueOnce({
				targets: [
					candidate('/chat-a'),
					candidate('/repo/worktree-a', { isCurrent: false, source: 'worktree' }),
				],
			})
			.mockResolvedValueOnce({
				targets: [
					candidate('/chat-a'),
					candidate('/repo/worktree-a', { isCurrent: false, source: 'worktree' }),
				],
			})
			.mockResolvedValueOnce({ targets: [candidate('/chat-b')] })
			.mockResolvedValueOnce({
				targets: [
					candidate('/chat-a'),
					candidate('/repo/worktree-a', { isCurrent: false, source: 'worktree' }),
				],
			});
		const { session } = createSession({});
		setProject(session, '/chat-a', 'chat-a');
		session.setPresentationVisible(true);
		await session.activate();
		await session.selectTarget(
			candidate('/repo/worktree-a', { isCurrent: false, source: 'worktree' }),
		);
		await vi.waitFor(() => {
			expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
		});

		setProject(session, '/chat-b', 'chat-b');
		await session.activate();
		expect(session.activeProjectPath).toBe('/repo/worktree-a');

		setProject(session, '/chat-a', 'chat-a');
		await session.activate();
		expect(session.activeProjectPath).toBe('/repo/worktree-a');
		api.getGitTargetCandidates.mockReset();
		api.getGitTargetCandidates.mockResolvedValue({ targets: [candidate('/chat-a')] });
		session.goToChatProject();
		await session.activate();
		expect(session.activeProjectPath).toBe('/chat-a');
	});

	it('keeps an explicitly selected repository as the discovery anchor', async () => {
		const chatTarget = candidate('/chat', { repoRoot: '/chat' });
		const selectedTarget = candidate('/selected', { repoRoot: '/selected' });
		api.getGitTargetCandidates.mockImplementation(async ({ projectPath }) => ({
			targets: projectPath === '/selected' ? [selectedTarget] : [chatTarget],
		}));
		const { session } = createSession({});
		setProject(session, '/chat', 'chat');
		session.setPresentationVisible(true);
		await session.activate();

		await session.selectTarget(selectedTarget);
		await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(session.isLoadingTargets).toBe(false));

		expect(api.getGitTargetCandidates.mock.calls.map(([{ projectPath }]) => projectPath)).toEqual([
			'/chat',
			'/selected',
		]);
		expect(session.activeProjectPath).toBe('/selected');

		await session.refreshForInvalidation('/selected', 1);

		expect(api.getGitTargetCandidates.mock.calls.map(([{ projectPath }]) => projectPath)).toEqual([
			'/chat',
			'/selected',
			'/selected',
		]);
		expect(session.activeProjectPath).toBe('/selected');
	});

	it('reconciles fresh branch metadata and consumes each invalidation once', async () => {
		api.getGitTargetCandidates
			.mockResolvedValueOnce({ targets: [candidate('/chat')] })
			.mockResolvedValueOnce({
				targets: [candidate('/chat', { branch: 'feature' })],
			});
		const { session, changes } = createSession({});
		setProject(session, '/chat', 'chat');
		session.setPresentationVisible(true);
		await session.activate();

		await expect(session.refreshForInvalidation('chat', 1)).resolves.toBe(true);
		await expect(session.refreshForInvalidation('chat', 1)).resolves.toBe(false);

		expect(session.activeTarget?.branch).toBe('feature');
		expect(changes.at(-1)).toEqual(
			expect.objectContaining({
				reason: 'invalidation',
				identityChanged: false,
			}),
		);
		expect(changes.filter((change) => change.reason === 'invalidation')).toHaveLength(1);
	});

	it('uses the owning singleton for checkout and applies checkout once', async () => {
		const runMutation = vi.fn(
			async (
				surfaceId: string,
				_executorId: string,
				projectPath: string,
				effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean }>,
			) => execute(),
		);
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [candidate('/chat', { branch: 'feature' })],
		});
		const { session, changes } = createSession({
			kind: 'git-compare',
			runMutation,
		});
		setProject(session, '/chat', 'chat');
		session.setPresentationVisible(true);
		await session.activate();

		await expect(session.switchBranch('feature', 'local-branch')).resolves.toBe(true);

		expect(runMutation).toHaveBeenCalledWith(
			'singleton:git-compare',
			'local',
			'/chat',
			'chat',
			expect.any(Function),
		);
		expect(changes.filter((change) => change.reason === 'checkout')).toHaveLength(1);
		expect(session.branches.currentBranch).toBe('feature');
	});

	it.each([
		{ executorId: 'local', projectPath: '/other' },
		{ executorId: 'remote', projectPath: '/repo' },
	])('retains handled invalidations when returning from $executorId:$projectPath', async (other) => {
		const invalidations = new GitProjectInvalidationStore();
		const localVersion = invalidations.markChanged('local');
		const otherVersion =
			other.executorId === 'local' ? localVersion : invalidations.markChanged(other.executorId);
		const { session, changes } = createSession({
			invalidationVersion: (executorId) => invalidations.version(executorId),
		});
		setProject(session, '/repo');
		session.setPresentationVisible(true);
		await session.activate();
		await expect(session.refreshForInvalidation('/repo', localVersion)).resolves.toBe(true);
		setProject(session, other.projectPath, other.projectPath, other.executorId);
		await session.activate();
		await expect(session.refreshForInvalidation(other.projectPath, otherVersion)).resolves.toBe(
			true,
		);

		for (let visit = 0; visit < 3; visit++) {
			setProject(session, '/repo');
			await session.activate();
			await expect(session.refreshForInvalidation('/repo', localVersion)).resolves.toBe(false);
			setProject(session, other.projectPath, other.projectPath, other.executorId);
			await session.activate();
			await expect(session.refreshForInvalidation(other.projectPath, otherVersion)).resolves.toBe(
				false,
			);
		}
		expect(changes.filter((change) => change.reason === 'invalidation')).toHaveLength(2);
		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(10);
		const nextVersion = invalidations.markChanged(other.executorId);
		await expect(session.refreshForInvalidation(other.projectPath, nextVersion)).resolves.toBe(
			true,
		);
		session.dispose();
	});

	it('bounds retained invalidations to the recent target cache', async () => {
		const { session } = createSession({});
		for (let index = 0; index < 9; index++) {
			setProject(session, `/repo-${index}`);
			session.setPresentationVisible(true);
			await session.activate();
			await expect(session.refreshForInvalidation(`/repo-${index}`, 1)).resolves.toBe(true);
		}
		setProject(session, '/repo-1');
		await session.activate();
		await expect(session.refreshForInvalidation('/repo-1', 1)).resolves.toBe(false);
		setProject(session, '/repo-0');
		await session.activate();
		await expect(session.refreshForInvalidation('/repo-0', 1)).resolves.toBe(true);
		session.dispose();
	});

	it('keeps same-path pending invalidations separate across executors', async () => {
		const local = deferred<{ targets: GitTargetCandidate[] }>();
		const remote = deferred<{ targets: GitTargetCandidate[] }>();
		const { session, changes } = createSession({});
		setProject(session, '/repo');
		session.setPresentationVisible(true);
		await session.activate();
		api.getGitTargetCandidates.mockReturnValueOnce(local.promise);
		const localRefresh = session.refreshForInvalidation('/repo', 1);
		setProject(session, '/repo', '/repo', 'remote');
		await session.activate();
		api.getGitTargetCandidates.mockReturnValueOnce(remote.promise);
		const remoteRefresh = session.refreshForInvalidation('/repo', 1);
		local.resolve({ targets: [candidate('/repo')] });
		await expect(localRefresh).resolves.toBe(false);
		await expect(session.refreshForInvalidation('/repo', 1)).resolves.toBe(false);
		remote.resolve({ targets: [candidate('/repo')] });
		await expect(remoteRefresh).resolves.toBe(true);
		expect(changes.filter((change) => change.reason === 'invalidation')).toHaveLength(1);
		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(4);
		session.dispose();
	});

	it('coalesces its branch invalidation into the direct checkout reconciliation', async () => {
		const invalidations = new GitProjectInvalidationStore();
		invalidations.markChanged('remote');
		const context: { session?: GitTargetSessionController } = {};
		const runMutation = vi.fn(
			async (
				_surfaceId: string,
				executorId: string,
				_projectPath: string,
				effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean }>,
			) => {
				const result = await execute();
				if (result.success) {
					const version = invalidations.markChanged(executorId);
					await context.session?.refreshForInvalidation(effectiveProjectKey, version);
				}
				return result;
			},
		);
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [candidate('/chat', { branch: 'feature' })],
		});
		const created = createSession({
			runMutation,
			invalidationVersion: (executorId) => invalidations.version(executorId),
		});
		context.session = created.session;
		setProject(created.session, '/chat', 'chat');
		created.session.setPresentationVisible(true);
		await created.session.activate();

		await expect(created.session.switchBranch('feature', 'local-branch')).resolves.toBe(true);
		await expect(
			created.session.refreshForInvalidation('chat', invalidations.version('local')),
		).resolves.toBe(false);

		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
		expect(created.changes.filter((change) => change.reason === 'checkout')).toHaveLength(1);
		expect(created.changes.filter((change) => change.reason === 'invalidation')).toHaveLength(0);
	});

	it('retains invalidations arriving after checkout while its reconciliation is pending', async () => {
		const invalidations = new GitProjectInvalidationStore();
		const entered = deferred<void>();
		const release = deferred<void>();
		const { session, changes } = createSession({
			invalidationVersion: (executorId) => invalidations.version(executorId),
			runMutation: async (_surface, executorId, _projectPath, _key, execute) => {
				const result = await execute();
				if (result.success) invalidations.markChanged(executorId);
				return result;
			},
			afterCheckout: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		setProject(session, '/repo');
		session.setPresentationVisible(true);
		await session.activate();
		const switching = session.switchBranch('feature', 'local-branch');
		await entered.promise;
		const version = invalidations.markChanged('local');
		await expect(session.refreshForInvalidation('/repo', version)).resolves.toBe(false);
		release.resolve();
		await expect(switching).resolves.toBe(true);
		expect(changes.map((change) => change.reason)).toEqual(['project', 'checkout', 'invalidation']);
		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(3);
		await expect(session.refreshForInvalidation('/repo', version)).resolves.toBe(false);
		session.dispose();
	});

	it('replays checkout invalidation after project availability interrupts reconciliation', async () => {
		let invalidationVersion = 0;
		const afterCheckout = vi.fn();
		api.getGitTargetCandidates
			.mockResolvedValueOnce({ targets: [candidate('/chat')] })
			.mockImplementationOnce((_projectPath, options) => {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						'abort',
						() => reject(new DOMException('Aborted', 'AbortError')),
						{ once: true },
					);
				});
			})
			.mockResolvedValue({ targets: [candidate('/chat', { branch: 'feature' })] });
		const runMutation = vi.fn(
			async (
				_surfaceId: string,
				_executorId: string,
				_projectPath: string,
				_effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean }>,
			) => {
				const result = await execute();
				if (result.success) invalidationVersion += 1;
				return result;
			},
		);
		const { session, changes } = createSession({
			runMutation,
			invalidationVersion: () => invalidationVersion,
			afterCheckout,
		});
		setProject(session, '/chat', 'chat');
		session.setPresentationVisible(true);
		await session.activate();

		const switching = session.switchBranch('feature', 'local-branch');
		await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2));
		session.setProjectState({
			kind: 'unavailable',
			context: { chatId: 'chat', projectPath: '/chat' },
			reason: 'not-found',
		});
		await expect(switching).resolves.toBe(true);

		expect(afterCheckout).not.toHaveBeenCalled();
		expect(changes.filter((change) => change.reason === 'checkout')).toEqual([]);
		setProject(session, '/chat', 'chat');
		await session.activate();
		await expect(session.refreshForInvalidation('chat', invalidationVersion)).resolves.toBe(true);

		expect(changes.filter((change) => change.reason === 'invalidation')).toHaveLength(1);
	});

	it('rejects target and branch changes while the owner is busy', async () => {
		const { session } = createSession({ canChangeTarget: () => false });
		setProject(session, '/chat');
		session.setPresentationVisible(true);
		await session.activate();

		await expect(session.selectTarget(candidate('/other'))).resolves.toBe(false);
		await expect(session.switchBranch('feature', 'local-branch')).resolves.toBe(false);
		expect(session.openNewBranchDialog()).toBe(false);
	});

	it('keeps separate sessions independent for the same chat', async () => {
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [
				candidate('/chat'),
				candidate('/repo/a', { isCurrent: false, source: 'worktree' }),
				candidate('/repo/b', { isCurrent: false, source: 'worktree' }),
			],
		});
		const first = createSession({}).session;
		const second = createSession({}).session;
		setProject(first, '/chat', 'chat');
		setProject(second, '/chat', 'chat');
		first.setPresentationVisible(true);
		second.setPresentationVisible(true);
		await Promise.all([first.activate(), second.activate()]);

		await first.selectTarget(candidate('/repo/a', { isCurrent: false, source: 'worktree' }));
		await second.selectTarget(candidate('/repo/b', { isCurrent: false, source: 'worktree' }));

		expect(first.activeProjectPath).toBe('/repo/a');
		expect(second.activeProjectPath).toBe('/repo/b');
		expect(first.branches).not.toBe(second.branches);
	});

	it('aborts discovery and closes dialogs on hide and dispose', async () => {
		const load = deferred<{ targets: GitTargetCandidate[] }>();
		api.getGitTargetCandidates.mockReturnValueOnce(load.promise);
		const { session } = createSession({});
		setProject(session, '/chat');
		session.projectSelection.showFolderDialog = true;
		session.branches.showBranchDropdown = true;
		session.setPresentationVisible(true);
		const activation = session.activate();

		session.setPresentationVisible(false);
		load.resolve({ targets: [candidate('/chat')] });
		await activation;

		expect(session.isLoadingTargets).toBe(false);
		expect(session.projectSelection.showFolderDialog).toBe(false);
		expect(session.branches.showBranchDropdown).toBe(false);
		session.dispose();
		expect(session.activeTarget).toBeNull();
		expect(session.effectiveProjectKey).toBeNull();
	});
});
