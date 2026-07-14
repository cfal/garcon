import { describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '../git/git-branch-selector-state.svelte';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte';

function createRegistry() {
	const commits: Array<{
		setContext: ReturnType<typeof vi.fn>;
		setPresentationVisible: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	}> = [];
	const pullRequestsStores: Array<{
		setCapability: ReturnType<typeof vi.fn>;
		setVisible: ReturnType<typeof vi.fn>;
		disposeSurface: ReturnType<typeof vi.fn>;
	}> = [];
	const registry = new SingletonSurfaceRegistry({
		createCommit: () => {
			const controller = {
				setContext: vi.fn(async () => undefined),
				setPresentationVisible: vi.fn(async () => undefined),
				dispose: vi.fn(),
			};
			commits.push(controller);
			return controller as never;
		},
		createPullRequests: () => {
			const controller = {
				setCapability: vi.fn(),
				setVisible: vi.fn(),
				disposeSurface: vi.fn(),
			};
			pullRequestsStores.push(controller);
			return controller as never;
		},
		gitBranchActions: new GitBranchSelectorState(),
		gitMutations: { run: vi.fn() } as never,
		getCurrentEffectiveProjectKey: () => '/canonical/project',
	});
	return { registry, commits, pullRequestsStores };
}

describe('SingletonSurfaceRegistry', () => {
	it('retains one Git and Files controller across presentation changes', () => {
		const { registry } = createRegistry();
		registry.setPresentationVisible('git', true);
		registry.setPresentationVisible('files', true);
		const git = registry.git();
		const files = registry.files();
		git.showTargetDialog = true;

		registry.setPresentationVisible('git', false);
		registry.setPresentationVisible('files', false);

		expect(registry.git()).toBe(git);
		expect(registry.files()).toBe(files);
		expect(git.presentationVisible).toBe(false);
		expect(git.showTargetDialog).toBe(true);
		expect(files.presentationVisible).toBe(false);
	});

	it('consumes each project invalidation once across Git placement remounts', () => {
		const { registry } = createRegistry();
		const git = registry.git();

		expect(git.takeInvalidationRefresh('/project', 1)).toBe(true);
		expect(git.takeInvalidationRefresh('/project', 1)).toBe(false);
		registry.setPresentationVisible('git', false);
		registry.setPresentationVisible('git', true);
		expect(registry.git()).toBe(git);
		expect(git.takeInvalidationRefresh('/project', 1)).toBe(false);
		expect(git.takeInvalidationRefresh('/project', 2)).toBe(true);
	});

	it('disposes only on destructive Close and creates a fresh controller on reopen', () => {
		const { registry } = createRegistry();
		const firstGit = registry.git();
		const firstFiles = registry.files();
		const firstPullRequests = registry.pullRequests();
		const firstCommit = registry.commit();

		registry.disposeSurface('git');
		registry.disposeSurface('files');
		registry.disposeSurface('pull-requests');
		registry.disposeSurface('commit');

		expect(registry.git()).not.toBe(firstGit);
		expect(registry.files()).not.toBe(firstFiles);
		expect(registry.pullRequests()).not.toBe(firstPullRequests);
		expect(registry.commit()).not.toBe(firstCommit);
		expect(firstPullRequests.disposeSurface).toHaveBeenCalledOnce();
		expect(firstCommit.dispose).toHaveBeenCalledOnce();
	});

	it('routes visibility for every singleton through one lifecycle owner', () => {
		const { registry, pullRequestsStores, commits } = createRegistry();
		registry.pullRequests();
		registry.commit();
		const pullRequests = pullRequestsStores[0]!;
		const commit = commits[0]!;
		pullRequests.setVisible.mockClear();
		commit.setPresentationVisible.mockClear();

		registry.setPresentationVisible('pull-requests', true);
		registry.setPresentationVisible('commit', true);
		registry.setPresentationVisible('pull-requests', false);
		registry.setPresentationVisible('commit', false);

		expect(pullRequests.setVisible.mock.calls).toEqual([[true], [false]]);
		expect(commit.setPresentationVisible.mock.calls).toEqual([[true], [false]]);
	});
});
