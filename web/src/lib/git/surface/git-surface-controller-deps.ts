import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import type { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import type { GitReviewDisplaySettingsStore } from '$lib/git/review/git-review-display-settings.svelte.js';

export interface GitSurfaceControllerDeps {
	createGitBranchSelector(): GitBranchSelectorState;
	gitMutations: GitMutationCoordinator;
	reviewDisplay: GitReviewDisplaySettingsStore;
}
