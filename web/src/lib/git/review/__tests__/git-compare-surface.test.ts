import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type { GitTargetCandidate } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
}));

const api = vi.mocked(await import('$lib/api/git.js'));

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

function setProject(controller: GitCompareSurfaceController): void {
	controller.setProjectState({
		kind: 'available',
		project: {
			chatId: 'chat',
			projectPath: '/project',
			effectiveProjectKey: 'chat',
		},
	});
}

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

		expect(compare).toHaveBeenCalledWith('/project');
		expect(controller.comparison.fromRevision).toBe('HEAD');
		expect(controller.comparison.toKind).toBe('working-tree');
		expect(controller.comparison.mode).toBe('direct');
		expect(controller.comparison.dialogOpen).toBe(false);
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

		await controller.refreshForInvalidation('chat', 1);
		await vi.waitFor(() => expect(freshness).toHaveBeenCalledOnce());
		await controller.refreshForInvalidation('chat', 1);

		expect(controller.comparison.fromRevision).toBe('main');
		expect(controller.comparison.toRevision).toBe('feature');
		expect(freshness).toHaveBeenCalledOnce();
	});

	it('disposal cancels future activation', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		const compare = vi.spyOn(controller.comparison, 'compare').mockResolvedValue(true);
		setProject(controller);
		controller.dispose();
		controller.setPresentationVisible(true);
		await controller.target.activate();
		expect(compare).not.toHaveBeenCalled();
	});
});
