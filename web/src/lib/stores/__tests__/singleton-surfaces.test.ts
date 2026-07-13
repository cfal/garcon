import { describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '../git/git-branch-selector-state.svelte';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte';

function createRegistry() {
	const quickGits: Array<{
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
		createQuickGit: () => {
			const controller = {
				setContext: vi.fn(async () => undefined),
				setPresentationVisible: vi.fn(async () => undefined),
				dispose: vi.fn(),
			};
			quickGits.push(controller);
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
	return { registry, quickGits, pullRequestsStores };
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

	it('disposes only on destructive Close and creates a fresh controller on reopen', () => {
		const { registry } = createRegistry();
		const firstGit = registry.git();
		const firstFiles = registry.files();
		const firstPullRequests = registry.pullRequests();
		const firstQuickGit = registry.quickGit();

		registry.disposeSurface('git');
		registry.disposeSurface('files');
		registry.disposeSurface('pull-requests');
		registry.disposeSurface('quick-git');

		expect(registry.git()).not.toBe(firstGit);
		expect(registry.files()).not.toBe(firstFiles);
		expect(registry.pullRequests()).not.toBe(firstPullRequests);
		expect(registry.quickGit()).not.toBe(firstQuickGit);
		expect(firstPullRequests.disposeSurface).toHaveBeenCalledOnce();
		expect(firstQuickGit.dispose).toHaveBeenCalledOnce();
	});

	it('routes visibility for every singleton through one lifecycle owner', () => {
		const { registry } = createRegistry();
		const pullRequests = registry.pullRequests();
		const quickGit = registry.quickGit();

		registry.setPresentationVisible('pull-requests', true);
		registry.setPresentationVisible('quick-git', true);
		registry.setPresentationVisible('pull-requests', false);
		registry.setPresentationVisible('quick-git', false);

		expect(pullRequests.setVisible.mock.calls).toEqual([[true], [false]]);
		expect(quickGit.setPresentationVisible.mock.calls).toEqual([[true], [false]]);
	});
});
