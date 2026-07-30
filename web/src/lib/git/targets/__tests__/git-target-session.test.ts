import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GitTargetSessionController,
	type GitTargetChangeReason,
} from '$lib/git/targets/git-target-session.svelte.js';
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
	invalidationVersion?: (effectiveProjectKey: string) => number;
	runMutation?: GitBranchSelectorStateOptions['runMutation'];
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
): void {
	session.setProjectState({
		kind: 'available',
		project: {
			chatId: effectiveProjectKey,
			projectPath,
			effectiveProjectKey,
		},
	});
}

describe('GitTargetSessionController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getGitTargetCandidates.mockResolvedValue({ targets: [] });
	});

	it('keeps discovery gated by visibility and applies the chat fallback once', async () => {
		const { session, changes } = createSession({});
		setProject(session, '/chat');

		expect(session.activeProjectPath).toBe('/chat');
		expect(api.getGitTargetCandidates).not.toHaveBeenCalled();

		session.setPresentationVisible(true);
		await session.activate();

		expect(api.getGitTargetCandidates).toHaveBeenCalledOnce();
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
		api.getGitTargetCandidates.mockReturnValueOnce(load.promise);
		const { session, changes } = createSession({});
		setProject(session, '/old', 'chat-old');
		session.setPresentationVisible(true);
		const activation = session.activate();

		session.setProjectState({
			kind: 'resolving',
			context: {
				chatId: 'draft',
				projectPath: '/new',
				effectiveProjectKey: null,
			},
		});
		load.resolve({ targets: [candidate('/old/worktree')] });
		await activation;

		expect(session.activeProjectPath).toBe('/old');
		expect(changes).toEqual([]);
	});

	it('restores only its own cached target when switching chat projects', async () => {
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
		expect(session.activeProjectPath).toBe('/chat-b');

		setProject(session, '/chat-a', 'chat-a');
		await session.activate();
		expect(session.activeProjectPath).toBe('/repo/worktree-a');
	});

	it('keeps an explicitly selected repository as the discovery anchor', async () => {
		const chatTarget = candidate('/chat', { repoRoot: '/chat' });
		const selectedTarget = candidate('/selected', { repoRoot: '/selected' });
		api.getGitTargetCandidates.mockImplementation(async (projectPath) => ({
			targets: projectPath === '/selected' ? [selectedTarget] : [chatTarget],
		}));
		const { session } = createSession({});
		setProject(session, '/chat', 'chat');
		session.setPresentationVisible(true);
		await session.activate();

		await session.selectTarget(selectedTarget);
		await vi.waitFor(() => expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(session.isLoadingTargets).toBe(false));

		expect(api.getGitTargetCandidates.mock.calls.map(([projectPath]) => projectPath)).toEqual([
			'/chat',
			'/selected',
		]);
		expect(session.activeProjectPath).toBe('/selected');

		await session.refreshForInvalidation('chat', 1);

		expect(api.getGitTargetCandidates.mock.calls.map(([projectPath]) => projectPath)).toEqual([
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
			'/chat',
			'chat',
			expect.any(Function),
		);
		expect(changes.filter((change) => change.reason === 'checkout')).toHaveLength(1);
		expect(session.branches.currentBranch).toBe('feature');
	});

	it('coalesces its branch invalidation into the direct checkout reconciliation', async () => {
		let invalidationVersion = 0;
		const context: { session?: GitTargetSessionController } = {};
		const runMutation = vi.fn(
			async (
				_surfaceId: string,
				_projectPath: string,
				effectiveProjectKey: string,
				execute: () => Promise<{ success: boolean }>,
			) => {
				const result = await execute();
				if (result.success) {
					invalidationVersion += 1;
					await context.session?.refreshForInvalidation(
						effectiveProjectKey,
						invalidationVersion,
					);
				}
				return result;
			},
		);
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [candidate('/chat', { branch: 'feature' })],
		});
		const created = createSession({
			runMutation,
			invalidationVersion: () => invalidationVersion,
		});
		context.session = created.session;
		setProject(created.session, '/chat', 'chat');
		created.session.setPresentationVisible(true);
		await created.session.activate();

		await expect(
			created.session.switchBranch('feature', 'local-branch'),
		).resolves.toBe(true);
		await expect(
			created.session.refreshForInvalidation('chat', invalidationVersion),
		).resolves.toBe(false);

		expect(api.getGitTargetCandidates).toHaveBeenCalledTimes(2);
		expect(created.changes.filter((change) => change.reason === 'checkout')).toHaveLength(1);
		expect(created.changes.filter((change) => change.reason === 'invalidation')).toHaveLength(
			0,
		);
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

		await first.selectTarget(
			candidate('/repo/a', { isCurrent: false, source: 'worktree' }),
		);
		await second.selectTarget(
			candidate('/repo/b', { isCurrent: false, source: 'worktree' }),
		);

		expect(first.activeProjectPath).toBe('/repo/a');
		expect(second.activeProjectPath).toBe('/repo/b');
		expect(first.branches).not.toBe(second.branches);
	});

	it('aborts discovery and closes dialogs on hide and dispose', async () => {
		const load = deferred<{ targets: GitTargetCandidate[] }>();
		api.getGitTargetCandidates.mockReturnValueOnce(load.promise);
		const { session } = createSession({});
		setProject(session, '/chat');
		session.showTargetDialog = true;
		session.branches.showBranchDropdown = true;
		session.setPresentationVisible(true);
		const activation = session.activate();

		session.setPresentationVisible(false);
		load.resolve({ targets: [candidate('/chat')] });
		await activation;

		expect(session.isLoadingTargets).toBe(false);
		expect(session.showTargetDialog).toBe(false);
		expect(session.branches.showBranchDropdown).toBe(false);
		session.dispose();
		expect(session.activeTarget).toBeNull();
		expect(session.effectiveProjectKey).toBeNull();
	});
});
