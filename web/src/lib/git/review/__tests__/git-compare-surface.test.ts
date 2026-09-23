import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type { GitTargetCandidate } from '$lib/api/git.js';
import {
	getGitComparisonSnapshot,
	type GitComparisonSnapshotReady,
} from '$lib/api/git-comparison.js';
import { GIT_REVIEW_DOCUMENT_LIMITS } from '$shared/git';
import type { GitComparisonSpecification } from '$lib/git/review/git-comparison.svelte.js';
import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
import {
	LocalGitComparisonPreferences,
	type GitComparisonPreferences,
	type GitComparisonPreferencePersistence,
} from '$lib/git/review/git-comparison-preferences.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
}));

const api = vi.mocked(await import('$lib/api/git.js'));

vi.mock('$lib/api/git-comparison.js', () => ({
	getGitComparisonSnapshot: vi.fn(),
	getGitComparisonFreshness: vi.fn(),
	getGitComparisonFileBodies: vi.fn(),
}));

function comparisonSnapshot(fromRevision: string): GitComparisonSnapshotReady {
	return {
		document: { nodeId: 'local', instanceId: 'test-instance', documentId: 'comparison-doc' },
		status: 'ready',
		project: '/project',
		repoRoot: '/project',
		documentId: 'comparison-doc',
		mode: 'direct',
		from: {
			kind: 'revision',
			requestedRevision: fromRevision,
			label: fromRevision,
			hash: 'a'.repeat(40),
			shortHash: 'aaaaaaa',
		},
		to: {
			kind: 'revision',
			requestedRevision: 'HEAD',
			label: 'HEAD',
			hash: 'b'.repeat(40),
			shortHash: 'bbbbbbb',
		},
		effectiveFromHash: 'a'.repeat(40),
		files: [],
		firstBodyCandidates: [],
		limits: GIT_REVIEW_DOCUMENT_LIMITS,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function candidate(
	projectPath = '/project',
	overrides: Partial<GitTargetCandidate> = {},
): GitTargetCandidate {
	return {
		projectPath,
		repoRoot: '/repo',
		worktreePath: projectPath,
		label: 'project',
		branch: 'main',
		source: 'chat-project',
		isCurrent: true,
		isMissing: false,
		...overrides,
	};
}

function setProject(
	controller: GitCompareSurfaceController,
	chatId = 'chat',
	projectPath = '/project',
	effectiveProjectKey = '/canonical/project',
): void {
	controller.setProjectState({
		kind: 'available',
		project: {
			chatId,
			projectPath,
			effectiveProjectKey,
		},
	});
}

function createComparisonPersistence() {
	let value: string | null = null;
	const persistence = {
		read: () => value,
		write: (nextValue: string) => {
			value = nextValue;
		},
	} satisfies GitComparisonPreferencePersistence;
	return persistence;
}

function recallPreference(
	preferences: GitComparisonPreferences,
	chatId: string,
	projectPath = '/project',
): GitComparisonSpecification | null {
	return preferences.recall({ nodeId: 'local', chatId, projectPath });
}

const revisionComparison: GitComparisonSpecification = {
	fromRevision: 'origin/main',
	toKind: 'revision',
	toRevision: 'HEAD',
	mode: 'direct',
};

const mergeBaseComparison: GitComparisonSpecification = {
	fromRevision: 'origin/main',
	toKind: 'revision',
	toRevision: 'feature',
	mode: 'merge-base',
};

describe('GitCompareSurfaceController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [candidate()],
		});
	});

	it('loads HEAD to working tree once on first visibility without opening the dialog', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller);

		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		expect(compare).toHaveBeenCalledWith(
			expect.objectContaining({ nodeId: 'local', projectPath: '/project' }),
		);
		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');
		expect(controller.comparison.mode).toBe('direct');
		expect(controller.comparison.dialogOpen).toBe(false);
	});

	it('does not load without a selected project', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);

		controller.setPresentationVisible(true);
		await controller.target.activate();

		expect(compare).not.toHaveBeenCalled();
	});

	it('compares without a chat and retains the selected project when a chat opens', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		controller.setPresentationVisible(true);
		await controller.target.selectTarget(candidate());
		expect(compare).toHaveBeenCalledOnce();
		expect(compare).toHaveBeenCalledWith(
			expect.objectContaining({ nodeId: 'local', projectPath: '/project', chatId: null }),
		);
		setProject(controller, 'different-chat', '/other');
		await controller.target.activate();
		expect(compare).toHaveBeenCalledOnce();
		expect(controller.target.activeProjectPath).toBe('/project');
		controller.dispose();
	});

	it('restores independent ranges for chats sharing the same target', async () => {
		const deps = createGitSurfaceTestDeps();
		const workingTreeComparison: GitComparisonSpecification = {
			fromRevision: 'release',
			toKind: 'working-tree',
			mode: 'direct',
		};
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-b' },
			workingTreeComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);

		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
		expect(controller.comparison.toRevision).toBe('HEAD');

		setProject(controller, 'chat-b');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		expect(controller.comparison.fromRevision).toBe('release');
		expect(controller.comparison.toKind).toBe('working-tree');

		setProject(controller, 'chat-a');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3));
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
		expect(controller.comparison.toRevision).toBe('HEAD');
	});

	it.each(['folder', 'node'] as const)(
		'loads project preferences once when pinning the current %s and retains edits on refocus',
		async (choice) => {
			const deps = createGitSurfaceTestDeps();
			const resolution = new ProjectResolutionStore(async (target) => ({
				target,
				resolution: { kind: 'available', effectiveProjectKey: '/project' },
			}));
			deps.projectSelection = {
				projectResolution: resolution,
				projectBasePath: () => '/project',
			};
			deps.comparisonPreferences.rememberUserSelection(
				{ nodeId: 'local', chatId: null, projectPath: '/project' },
				{ ...revisionComparison, fromRevision: 'project-only' },
			);
			deps.comparisonPreferences.rememberChat(
				{ nodeId: 'local', chatId: 'chat' },
				{ ...revisionComparison, fromRevision: 'chat-only' },
			);
			const controller = new GitCompareSurfaceController(deps);
			const readSnapshot = vi.mocked(getGitComparisonSnapshot);
			readSnapshot.mockImplementation(async (_project, from) => comparisonSnapshot(from.revision));
			const pendingSnapshot = Promise.withResolvers<GitComparisonSnapshotReady>();
			try {
				setProject(controller, 'chat', '/project', '/project');
				controller.setPresentationVisible(true);
				await controller.target.activate();
				await vi.waitFor(() => expect(controller.comparison.snapshot).not.toBeNull());
				expect(controller.comparison.fromRevision).toBe('chat-only');
				readSnapshot.mockImplementationOnce((_project, _from, _to, _mode, options) => {
					options?.signal?.addEventListener(
						'abort',
						() => {
							pendingSnapshot.reject(new DOMException('Aborted', 'AbortError'));
						},
						{ once: true },
					);
					return pendingSnapshot.promise;
				});
				if (choice === 'folder') await controller.target.selectTarget(candidate());
				else {
					const pendingTargets = deferred<{ targets: GitTargetCandidate[] }>();
					api.getGitTargetCandidates.mockReturnValueOnce(pendingTargets.promise);
					await controller.target.selectNode('local');
					expect(readSnapshot).toHaveBeenCalledOnce();
					pendingTargets.resolve({ targets: [candidate()] });
				}
				await controller.target.activate();
				await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
				expect(controller.target.projectSelection.followingChat).toBe(false);
				expect(controller.comparison.fromRevision).toBe('project-only');
				expect(readSnapshot.mock.calls[1][4]?.signal?.aborted).toBe(false);
				pendingSnapshot.resolve(comparisonSnapshot('project-only'));
				await vi.waitFor(() => expect(controller.comparison.isLoading).toBe(false));
				expect(controller.comparison.snapshot?.from.requestedRevision).toBe('project-only');

				controller.comparison.openDialog({
					fromRevision: 'unfinished-edit',
					toKind: 'working-tree',
				});
				controller.setPresentationVisible(false);
				controller.setPresentationVisible(true);
				await controller.target.activate();
				expect(readSnapshot).toHaveBeenCalledTimes(2);
				expect(controller.comparison.dialogOpen).toBe(true);
				expect(controller.comparison.fromRevision).toBe('unfinished-edit');
			} finally {
				controller.dispose();
				resolution.destroy();
			}
		},
	);

	it('restores merge-base mode with revision endpoints', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			mergeBaseComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);

		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
		expect(controller.comparison.toRevision).toBe('feature');
		expect(controller.comparison.mode).toBe('merge-base');
	});

	it('inherits the nearest project default without pinning it to a new worktree chat', async () => {
		const worktreePath = '/repo/.worktrees/abc';
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [
				candidate(worktreePath, {
					repoRoot: '/repo',
					worktreePath,
					label: 'abc',
					branch: 'feature',
				}),
			],
		});
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberUserSelection(
			{ nodeId: 'local', chatId: 'seed-root', projectPath: '/repo' },
			revisionComparison,
		);
		const rememberUserSelection = vi.spyOn(deps.comparisonPreferences, 'rememberUserSelection');
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);

		setProject(controller, 'chat-a', worktreePath, '/canonical/repo');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
		expect(rememberUserSelection).not.toHaveBeenCalled();

		const updatedDefault: GitComparisonSpecification = {
			fromRevision: 'release',
			toKind: 'working-tree',
			mode: 'direct',
		};
		deps.comparisonPreferences.rememberUserSelection(
			{ nodeId: 'local', chatId: 'seed-updated', projectPath: '/repo' },
			updatedDefault,
		);
		rememberUserSelection.mockClear();
		setProject(controller, 'chat-b', worktreePath, '/canonical/repo');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));

		expect(controller.comparison.fromRevision).toBe('release');
		expect(controller.comparison.toKind).toBe('working-tree');
		expect(rememberUserSelection).not.toHaveBeenCalled();
	});

	it('uses project preferences rather than chat preferences after explicit target selection', async () => {
		const projectTarget = candidate();
		const otherTarget = candidate('/other', {
			repoRoot: '/other-repo',
			worktreePath: '/other',
			label: 'other',
			branch: 'feature',
			isCurrent: false,
		});
		api.getGitTargetCandidates.mockResolvedValue({ targets: [projectTarget, otherTarget] });
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
		expect(controller.comparison.fromRevision).toBe('origin/main');

		await controller.target.selectTarget(otherTarget);
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');

		await controller.target.selectTarget(projectTarget);
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3));
		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');
	});

	it('remembers confirmed chat state before switching targets', async () => {
		const projectTarget = candidate();
		const otherTarget = candidate('/other', {
			repoRoot: '/other-repo',
			worktreePath: '/other',
			label: 'other',
			branch: 'feature',
			isCurrent: false,
		});
		api.getGitTargetCandidates.mockResolvedValue({ targets: [projectTarget, otherTarget] });
		const deps = createGitSurfaceTestDeps();
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockReturnValue(
			revisionComparison,
		);

		await controller.target.selectTarget(otherTarget);
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));

		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');
	});

	it('remembers only a successful user comparison for the active session', async () => {
		const deps = createGitSurfaceTestDeps();
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockReturnValue(
			revisionComparison,
		);
		controller.comparison.setSpecification(revisionComparison);
		expect(recallPreference(deps.comparisonPreferences, 'new-chat', '/project/child')).toBeNull();

		expect(await controller.compareCurrentSpecification()).toBe(true);

		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
		expect(recallPreference(deps.comparisonPreferences, 'new-chat', '/project/child')).toEqual(
			revisionComparison,
		);
	});

	it('does not replace remembered success after a failed user comparison', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		const failedSpecification: GitComparisonSpecification = {
			fromRevision: 'missing',
			toKind: 'working-tree',
			mode: 'direct',
		};
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockReturnValue(
			failedSpecification,
		);
		controller.comparison.setSpecification(failedSpecification);
		compare.mockResolvedValueOnce(false);

		expect(await controller.compareCurrentSpecification()).toBe(false);
		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
		expect(recallPreference(deps.comparisonPreferences, 'new-chat', '/project')).toBeNull();
	});

	it('does not remember unsubmitted dialog fields', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		controller.comparison.openDialog({
			fromRevision: 'unfinished',
			toKind: 'working-tree',
		});
		setProject(controller, 'chat-b');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));

		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
	});

	it('restores a range after controller and preference service recreation', async () => {
		const persistence = createComparisonPersistence();
		const firstDeps = createGitSurfaceTestDeps(new LocalGitComparisonPreferences(persistence));
		const first = new GitCompareSurfaceController(firstDeps);
		const firstCompare = vi.spyOn(first.comparison, 'compare').mockResolvedValue(true);
		setProject(first, 'chat-a');
		first.setPresentationVisible(true);
		await first.target.activate();
		await vi.waitFor(() => expect(firstCompare).toHaveBeenCalledOnce());
		vi.spyOn(first.comparison, 'confirmedSpecification', 'get').mockReturnValue(revisionComparison);

		first.dispose();

		const secondDeps = createGitSurfaceTestDeps(new LocalGitComparisonPreferences(persistence));
		const second = new GitCompareSurfaceController(secondDeps);
		const secondCompare = vi.spyOn(second.comparison, 'compare').mockResolvedValue(true);
		setProject(second, 'chat-a');
		second.setPresentationVisible(true);
		await second.target.activate();
		await vi.waitFor(() => expect(secondCompare).toHaveBeenCalledOnce());
		expect(second.comparison.fromRevision).toBe('origin/main');
		expect(second.comparison.toKind).toBe('revision');
		expect(second.comparison.toRevision).toBe('HEAD');
	});

	it('keeps separate browser storage areas isolated', async () => {
		const firstClient = createGitSurfaceTestDeps();
		firstClient.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const secondClient = createGitSurfaceTestDeps();
		const controller = new GitCompareSurfaceController(secondClient);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);

		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');
	});

	it('defers restoration while the project identity is resolving', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		controller.setProjectState({
			kind: 'resolving',
			context: {
				chatId: 'chat-a',
				projectPath: '/project',
			},
		});

		controller.setPresentationVisible(true);
		await controller.target.activate();
		expect(compare).not.toHaveBeenCalled();

		setProject(controller, 'chat-a');
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toRevision).toBe('HEAD');
	});

	it('does not load a restored chat while Compare is hidden', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-b' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		controller.setPresentationVisible(false);
		setProject(controller, 'chat-b');
		await controller.target.activate();
		expect(compare).toHaveBeenCalledOnce();

		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
	});

	it('retries a failed automatic restore without deleting remembered intent', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);

		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toRevision).toBe('HEAD');
	});

	it('does not retry a failed restore or discard a repair on project-state republish', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(false);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		controller.comparison.openDialog({
			fromRevision: 'origin/repaired',
			toKind: 'working-tree',
		});

		setProject(controller, 'chat-a');
		await controller.target.activate();
		await Promise.resolve();

		expect(compare).toHaveBeenCalledOnce();
		expect(controller.comparison.dialogOpen).toBe(true);
		expect(controller.comparison.fromRevision).toBe('origin/repaired');
	});

	it('keeps a cancelled repair without a snapshot retryable', async () => {
		const cancelled = deferred<boolean>();
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockResolvedValueOnce(false)
			.mockReturnValueOnce(cancelled.promise)
			.mockResolvedValueOnce(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		controller.comparison.editComparison();
		const submission = controller.compareCurrentSpecification();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		controller.closeComparisonDialog();
		cancelled.resolve(false);
		expect(await submission).toBe(false);

		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3));
	});

	it('does not persist a late explicit comparison after switching sessions', async () => {
		api.getGitTargetCandidates.mockImplementation(({ projectPath }) =>
			Promise.resolve({
				targets: [
					candidate(projectPath, {
						repoRoot: projectPath,
						worktreePath: projectPath,
					}),
				],
			}),
		);
		const deps = createGitSurfaceTestDeps();
		const rememberUserSelection = vi.spyOn(deps.comparisonPreferences, 'rememberUserSelection');
		const controller = new GitCompareSurfaceController(deps);
		const pendingSubmission = deferred<boolean>();
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockResolvedValueOnce(true)
			.mockReturnValueOnce(pendingSubmission.promise)
			.mockResolvedValueOnce(true);
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockReturnValue(
			revisionComparison,
		);
		setProject(controller, 'chat-a', '/project-a', '/canonical/a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		const submission = controller.compareCurrentSpecification();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		setProject(controller, 'chat-b', '/project-b', '/canonical/b');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3));
		pendingSubmission.resolve(true);

		expect(await submission).toBe(false);
		expect(rememberUserSelection).not.toHaveBeenCalled();
		expect(recallPreference(deps.comparisonPreferences, 'new-a', '/project-a')).toBeNull();
		expect(recallPreference(deps.comparisonPreferences, 'new-b', '/project-b')).toBeNull();
	});

	it('ignores a late comparison result after switching chats', async () => {
		const deps = createGitSurfaceTestDeps();
		const chatBComparison: GitComparisonSpecification = {
			fromRevision: 'release',
			toKind: 'working-tree',
			mode: 'direct',
		};
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		deps.comparisonPreferences.rememberChat({ nodeId: 'local', chatId: 'chat-b' }, chatBComparison);
		const controller = new GitCompareSurfaceController(deps);
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		let confirmed: GitComparisonSpecification | null = null;
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockImplementation(
			() => confirmed,
		);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		setProject(controller, 'chat-b');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		confirmed = chatBComparison;
		first.resolve(true);
		await first.promise;
		await Promise.resolve();

		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
		second.resolve(true);
		await second.promise;
	});

	it('ignores an old A continuation after switching A to B to A', async () => {
		const deps = createGitSurfaceTestDeps();
		const chatBComparison: GitComparisonSpecification = {
			fromRevision: 'release',
			toKind: 'working-tree',
			mode: 'direct',
		};
		const staleSpecification: GitComparisonSpecification = {
			fromRevision: 'stale-result',
			toKind: 'working-tree',
			mode: 'direct',
		};
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		deps.comparisonPreferences.rememberChat({ nodeId: 'local', chatId: 'chat-b' }, chatBComparison);
		const controller = new GitCompareSurfaceController(deps);
		const firstA = deferred<boolean>();
		const pendingB = deferred<boolean>();
		const finalA = deferred<boolean>();
		const compare = vi
			.spyOn(controller.comparison, 'compare')
			.mockReturnValueOnce(firstA.promise)
			.mockReturnValueOnce(pendingB.promise)
			.mockReturnValueOnce(finalA.promise);
		let confirmed: GitComparisonSpecification | null = null;
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockImplementation(
			() => confirmed,
		);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
		setProject(controller, 'chat-b');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
		setProject(controller, 'chat-a');
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(3));

		confirmed = staleSpecification;
		firstA.resolve(true);
		await firstA.promise;
		await Promise.resolve();
		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);

		confirmed = revisionComparison;
		finalA.resolve(true);
		pendingB.resolve(false);
		await Promise.all([finalA.promise, pendingB.promise]);

		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		expect(compare).toHaveBeenCalledTimes(3);
	});

	it('reports loading while target discovery delays the initial comparison', async () => {
		const targets = deferred<{ targets: GitTargetCandidate[] }>();
		api.getGitTargetCandidates.mockReturnValueOnce(targets.promise);
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller);

		controller.setPresentationVisible(true);

		expect(controller.target.isLoadingTargets).toBe(true);
		expect(controller.isLoading).toBe(true);
		expect(compare).not.toHaveBeenCalled();

		targets.resolve({ targets: [candidate()] });
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		expect(controller.isLoading).toBe(false);
	});

	it('preserves edited endpoints and issues no request on generic refocus', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		controller.comparison.setSpecification({
			fromRevision: 'main',
			toKind: 'revision',
			toRevision: 'feature',
		});

		controller.setPresentationVisible(false);
		controller.setPresentationVisible(true);
		await controller.target.activate();

		expect(compare).toHaveBeenCalledOnce();
		expect(controller.comparison.fromRevision).toBe('main');
		expect(controller.comparison.toRevision).toBe('feature');
	});

	it('checks freshness once for a same-target invalidation and preserves the specification', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		const freshness = vi
			.spyOn(controller.comparison, 'checkFreshness')
			.mockResolvedValue(undefined);
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		controller.comparison.setSpecification({
			fromRevision: 'main',
			toKind: 'revision',
			toRevision: 'feature',
		});

		await controller.refreshForInvalidation('/canonical/project', 1);
		await vi.waitFor(() => expect(freshness).toHaveBeenCalledOnce());
		await controller.refreshForInvalidation('/canonical/project', 1);

		expect(controller.comparison.fromRevision).toBe('main');
		expect(controller.comparison.toRevision).toBe('feature');
		expect(freshness).toHaveBeenCalledOnce();
	});

	it('loads the next chat when a same-target invalidation settles during activation', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-b' },
			{ ...revisionComparison, fromRevision: 'chat-b-revision' },
		);
		const readSnapshot = vi.mocked(getGitComparisonSnapshot);
		readSnapshot.mockImplementation(async (_project, from) => comparisonSnapshot(from.revision));
		const controller = new GitCompareSurfaceController(deps);
		try {
			setProject(controller, 'chat-a');
			controller.setPresentationVisible(true);
			await controller.target.activate();
			await vi.waitFor(() => expect(controller.comparison.snapshot).not.toBeNull());
			expect(readSnapshot).toHaveBeenCalledOnce();

			const pendingTargets = deferred<{ targets: GitTargetCandidate[] }>();
			api.getGitTargetCandidates.mockReturnValueOnce(pendingTargets.promise);
			const invalidation = controller.refreshForInvalidation('/canonical/project', 1);
			pendingTargets.resolve({ targets: [candidate()] });
			setProject(controller, 'chat-b');
			await invalidation;
			await controller.target.activate();

			await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
			expect(controller.comparison.snapshot?.from.requestedRevision).toBe('chat-b-revision');
		} finally {
			controller.dispose();
		}
	});

	it('restores the same symbolic range after branch checkout', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.comparisonPreferences.rememberChat(
			{ nodeId: 'local', chatId: 'chat-a' },
			revisionComparison,
		);
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller, 'chat-a');
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());

		expect(await controller.target.switchBranch('feature', 'local-branch')).toBe(true);
		await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(2));

		expect(controller.comparison.fromRevision).toBe('origin/main');
		expect(controller.comparison.toKind).toBe('revision');
		expect(controller.comparison.toRevision).toBe('HEAD');
		expect(recallPreference(deps.comparisonPreferences, 'chat-a')).toEqual(revisionComparison);
	});

	it('disposal remembers confirmed state and cancels future activation', async () => {
		const deps = createGitSurfaceTestDeps();
		const controller = new GitCompareSurfaceController(deps);
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(compare).toHaveBeenCalledOnce());
		vi.spyOn(controller.comparison, 'confirmedSpecification', 'get').mockReturnValue(
			revisionComparison,
		);
		controller.dispose();
		controller.setPresentationVisible(true);
		await controller.target.activate();
		expect(compare).toHaveBeenCalledOnce();
		expect(recallPreference(deps.comparisonPreferences, 'chat')).toEqual(revisionComparison);
	});
});
