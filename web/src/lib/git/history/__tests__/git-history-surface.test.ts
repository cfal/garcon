import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type { GitTargetCandidate } from '$lib/api/git.js';
import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import { GitProjectInvalidationStore } from '$lib/git/surface/git-project-invalidation.svelte.js';
import { GitReviewDisplaySettingsStore } from '$lib/git/review/git-review-display-settings.svelte.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	getGitHistoryCommits: vi.fn().mockResolvedValue({
		project: '/project',
		ref: 'HEAD',
		commits: [],
		nextOffset: null,
	}),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
	gitRevertCommit: vi.fn(),
}));

const api = vi.mocked(await import('$lib/api/git.js'));

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

function setProject(controller: GitHistorySurfaceController): void {
	controller.setProjectState({
		kind: 'available',
		project: {
			chatId: 'chat',
			projectPath: '/project',
			effectiveProjectKey: 'chat',
		},
	});
}

describe('GitHistorySurfaceController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getGitTargetCandidates.mockResolvedValue({
			targets: [candidate()],
		});
		api.gitRevertCommit.mockResolvedValue({ success: true });
	});

	it('loads History once when the default target becomes visible', async () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledOnce());
		expect(api.getGitHistoryCommits).toHaveBeenCalledWith(
			'/project',
			expect.objectContaining({ offset: 0 }),
		);
	});

	it('opens a complete commit selection inside History with shared review settings', async () => {
		const deps = createGitSurfaceTestDeps();
		deps.reviewDisplay.setDiffMode('split');
		deps.reviewDisplay.setContextLines(9);
		const controller = new GitHistorySurfaceController(deps);
		const openComparison = vi
			.spyOn(controller.history, 'openComparison')
			.mockImplementation(() => undefined);
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		controller.comparisonSelection.begin();
		controller.comparisonSelection.select('older');
		controller.comparisonSelection.select('newer');

		expect(controller.openSelectedComparison()).toBe(true);
		expect(openComparison).toHaveBeenCalledWith(
			'/project',
			{
				fromRevision: 'older',
				toKind: 'revision',
				toRevision: 'newer',
			},
			{ diffMode: 'split', contextLines: 9 },
		);
		expect(controller.comparisonSelection).toMatchObject({
			active: true,
			from: 'older',
			to: 'newer',
		});
	});

	it('rejects incomplete local comparison selections', async () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		const openComparison = vi.spyOn(controller.history, 'openComparison');
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		controller.comparisonSelection.begin();
		controller.comparisonSelection.select('older');

		expect(controller.openSelectedComparison()).toBe(false);
		expect(openComparison).not.toHaveBeenCalled();
	});

	it('uses the active local comparison document for context-change guards', () => {
		const deps = createGitSurfaceTestDeps();
		const controller = new GitHistorySurfaceController(deps);
		controller.setPresentationVisible(true);
		controller.history.screen = 'comparison';
		controller.history.comparison.document.openCommentComposer('src/a.ts', 'after', 12);
		controller.history.comparison.document.setCommentBody('Keep this comment');

		expect(deps.reviewDisplay.setContextLines(12)).toBe(false);
		expect(controller.history.comparison.document.commentComposer.body).toBe('Keep this comment');
		expect(controller.history.comparison.document.commentError).toBe(
			'Add or close this comment before changing context lines.',
		);
	});

	it('reloads once for an invalidation and does not consume it twice', async () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledOnce());

		await controller.refreshForInvalidation('chat', 1);
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledTimes(2));
		await controller.refreshForInvalidation('chat', 1);

		expect(api.getGitHistoryCommits).toHaveBeenCalledTimes(2);
	});

	it('reloads once when its own branch checkout also publishes invalidation', async () => {
		const invalidations = new GitProjectInvalidationStore();
		const context: { controller?: GitHistorySurfaceController } = {};
		const gitMutations = new GitMutationCoordinator({
			onChanged: async (effectiveProjectKey) => {
				invalidations.markChanged(effectiveProjectKey);
				await context.controller?.refreshForInvalidation(
					effectiveProjectKey,
					invalidations.version(effectiveProjectKey),
				);
			},
		});
		const deps = {
			createGitBranchSelector: () =>
				new GitBranchSelectorState({
					runMutation: (surfaceId, projectPath, effectiveProjectKey, execute) =>
						gitMutations.run({
							surfaceId,
							projectPath,
							effectiveProjectKey,
							execute,
							didMutate: (result) => result.success,
						}),
				}),
			gitMutations,
			invalidationVersion: (effectiveProjectKey: string) =>
				invalidations.version(effectiveProjectKey),
			reviewDisplay: new GitReviewDisplaySettingsStore(),
		} satisfies GitSurfaceControllerDeps;
		const controller = new GitHistorySurfaceController(deps);
		context.controller = controller;
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledOnce());

		await expect(controller.target.switchBranch('feature', 'local-branch')).resolves.toBe(true);
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledTimes(2));

		expect(api.getGitHistoryCommits).toHaveBeenCalledTimes(2);
	});

	it('pauses an initial list request while hidden and resumes it once', async () => {
		let resolve!: (value: { project: string; ref: string; commits: []; nextOffset: null }) => void;
		const pending = new Promise<{
			project: string;
			ref: string;
			commits: [];
			nextOffset: null;
		}>((promiseResolve) => {
			resolve = promiseResolve;
		});
		api.getGitHistoryCommits.mockReturnValueOnce(pending);
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledOnce());

		controller.setPresentationVisible(false);
		expect(controller.history.listLoading).toBe(false);
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledTimes(2));
		resolve({ project: '/project', ref: 'HEAD', commits: [], nextOffset: null });
	});

	it('keeps revert confirmation and exposes a failed revert', async () => {
		api.gitRevertCommit.mockResolvedValueOnce({
			success: false,
			error: 'conflict in src/a.ts',
		});
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		controller.pendingRevertCommit = {
			hash: 'abc',
			shortHash: 'abc',
			subject: 'Change',
		};

		await expect(controller.revertPendingCommit()).resolves.toBe(false);
		expect(controller.pendingRevertCommit?.hash).toBe('abc');
		expect(controller.lastError).toContain('conflict');
		expect(controller.isRevertingCommit).toBe(false);
	});

	it('owns successful revert mutations and relies on invalidation for reload', async () => {
		const deps = createGitSurfaceTestDeps();
		const run = vi.spyOn(deps.gitMutations, 'run');
		const controller = new GitHistorySurfaceController(deps);
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(api.getGitHistoryCommits).toHaveBeenCalledOnce());
		controller.pendingRevertCommit = {
			hash: 'abc',
			shortHash: 'abc',
			subject: 'Change',
		};

		await expect(controller.revertPendingCommit()).resolves.toBe(true);

		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				surfaceId: 'singleton:git-history',
				effectiveProjectKey: 'chat',
				projectPath: '/project',
			}),
		);
		expect(controller.pendingRevertCommit).toBeNull();
		expect(api.getGitHistoryCommits).toHaveBeenCalledOnce();
	});

	it('clears range and revert state on disposal', () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		controller.comparisonSelection.begin();
		controller.pendingRevertCommit = {
			hash: 'abc',
			shortHash: 'abc',
			subject: 'Change',
		};
		controller.dispose();
		expect(controller.comparisonSelection.active).toBe(false);
		expect(controller.pendingRevertCommit).toBeNull();
	});

	it('clears a local comparison and its selection when the target changes', async () => {
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		setProject(controller);
		controller.setPresentationVisible(true);
		await controller.target.activate();
		controller.comparisonSelection.begin();
		controller.comparisonSelection.select('older');
		controller.comparisonSelection.select('newer');
		controller.history.screen = 'comparison';

		await controller.target.selectTarget(
			candidate('/other', {
				worktreePath: '/other',
				label: 'other',
				isCurrent: false,
			}),
		);

		expect(controller.history.screen).toBe('list');
		expect(controller.comparisonSelection.active).toBe(false);
	});
});
