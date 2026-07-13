import { describe, expect, it, vi } from 'vitest';
import { GitBranchSelectorState } from '../git/git-branch-selector-state.svelte';
import { SingletonSurfaceRegistry } from '../singleton-surfaces.svelte';

function createRegistry() {
	const quickGit = {
		setPresentationVisible: vi.fn(async () => undefined),
		resetAfterClose: vi.fn(),
		dispose: vi.fn(),
	};
	const pullRequests = {
		setVisible: vi.fn(),
		disposeSurface: vi.fn(),
	};
	const registry = new SingletonSurfaceRegistry({
		quickGit: quickGit as never,
		pullRequests: pullRequests as never,
		gitBranchActions: new GitBranchSelectorState(),
		gitMutations: { run: vi.fn() } as never,
		getCurrentEffectiveProjectKey: () => '/canonical/project',
	});
	return { registry, quickGit, pullRequests };
}

describe('SingletonSurfaceRegistry', () => {
	it('retains one Git and Files controller across presentation changes', () => {
		const { registry } = createRegistry();
		registry.setPresentationVisible('git', true);
		registry.setPresentationVisible('files', true);
		const git = registry.git();
		const files = registry.files();

		registry.setPresentationVisible('git', false);
		registry.setPresentationVisible('files', false);

		expect(registry.git()).toBe(git);
		expect(registry.files()).toBe(files);
		expect(git.presentationVisible).toBe(false);
		expect(files.presentationVisible).toBe(false);
	});

	it('disposes only on destructive Close and creates a fresh controller on reopen', () => {
		const { registry, quickGit, pullRequests } = createRegistry();
		const firstGit = registry.git();
		const firstFiles = registry.files();

		registry.disposeSurface('git');
		registry.disposeSurface('files');
		registry.disposeSurface('pull-requests');
		registry.disposeSurface('quick-git');

		expect(registry.git()).not.toBe(firstGit);
		expect(registry.files()).not.toBe(firstFiles);
		expect(pullRequests.disposeSurface).toHaveBeenCalledOnce();
		expect(quickGit.resetAfterClose).toHaveBeenCalledOnce();
	});

	it('routes visibility for every singleton through one lifecycle owner', () => {
		const { registry, quickGit, pullRequests } = createRegistry();

		registry.setPresentationVisible('pull-requests', true);
		registry.setPresentationVisible('quick-git', true);
		registry.setPresentationVisible('pull-requests', false);
		registry.setPresentationVisible('quick-git', false);

		expect(pullRequests.setVisible.mock.calls).toEqual([[true], [false]]);
		expect(quickGit.setPresentationVisible.mock.calls).toEqual([[true], [false]]);
	});
});
