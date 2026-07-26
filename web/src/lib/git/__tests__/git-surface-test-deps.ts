import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import { GitProjectInvalidationStore } from '$lib/git/surface/git-project-invalidation.svelte.js';
import { GitReviewDisplaySettingsStore } from '$lib/git/review/git-review-display-settings.svelte.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';

export function createGitSurfaceTestDeps(): GitSurfaceControllerDeps {
	const invalidations = new GitProjectInvalidationStore();
	return {
		createGitBranchSelector: () => new GitBranchSelectorState(),
		gitMutations: new GitMutationCoordinator({
			onChanged: (effectiveProjectKey) => invalidations.markChanged(effectiveProjectKey),
		}),
		invalidationVersion: (effectiveProjectKey) => invalidations.version(effectiveProjectKey),
		reviewDisplay: new GitReviewDisplaySettingsStore(),
	};
}
