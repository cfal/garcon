import type { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import type { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import type { GitReviewDisplaySettingsStore } from '$lib/git/review/git-review-display-settings.svelte.js';
import type { GitProjectSelectionDeps } from '$lib/git/targets/git-project-selection.svelte.js';

export interface GitSurfaceControllerDeps {
	projectSelection?: GitProjectSelectionDeps;
	createGitBranchSelector(): GitBranchSelectorState;
	gitMutations: GitMutationCoordinator;
	invalidationVersion(nodeId: string): number;
	reviewDisplay: GitReviewDisplaySettingsStore;
}
