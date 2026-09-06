import { untrack } from 'svelte';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import type { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
import type { GitQuickSummaryStore } from '$lib/git/surface/git-quick-summary.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import type { ProjectResolutionLease, ProjectResolutionStore } from './project-resolution-store.svelte.js';

interface WorkspaceDomainBindingsDeps {
	workspaceContext: WorkspaceContextStore;
	projectResolution: ProjectResolutionStore;
	ghCapability: GhCapabilityStore;
	localSettings: LocalSettingsStore;
	singletons: SingletonSurfaceRegistry;
	gitQuickSummary: GitQuickSummaryStore;
	gitBranchActions: GitBranchSelectorState;
}

export class WorkspaceDomainBindings {
	readonly #destroyEffects: () => void;

	constructor(deps: WorkspaceDomainBindingsDeps) {
		let lastCommitInvalidationKey = '';
		// Bindings run for the application lifetime, so every sink tolerates absent pre-auth context.
		this.#destroyEffects = $effect.root(() => {
			$effect(() => {
				const target = deps.workspaceContext.currentTarget;
				if (!target) return;
				const lease = untrack(() => deps.projectResolution.retain(target));
				return () => lease.release();
			});

			$effect(() => {
				const target = deps.workspaceContext.currentTarget;
				const hasDemand = deps.singletons.hasVisibleProjectSurface
					|| deps.localSettings.showQuickCommitTray;
				if (!target || !hasDemand) return;
				const lease: ProjectResolutionLease = untrack(() => {
					const retained = deps.projectResolution.retain(target);
					void retained.resolve();
					return retained;
				});
				return () => lease.release();
			});

			$effect(() => {
				deps.singletons.setProjectState(deps.workspaceContext.projectState);
			});

			$effect(() => {
				deps.singletons.setPullRequestsCapability(
					deps.ghCapability.hasChecked,
					deps.ghCapability.available,
				);
			});

			$effect(() => {
				const projectState = deps.workspaceContext.projectState;
				deps.gitQuickSummary.setEnabled(deps.localSettings.showQuickCommitTray);
				if (projectState.kind === 'resolving') {
					untrack(() => deps.gitBranchActions.closeNewBranchDialog());
					return;
				}
				const currentProject = projectState.kind === 'available' ? projectState.project : null;
				const projectPath = currentProject?.projectPath ?? null;
				deps.gitQuickSummary.setProject(projectPath);
				deps.gitBranchActions.setProject(
					projectPath,
					deps.gitQuickSummary.summaryFor(projectPath)?.branch,
					currentProject?.effectiveProjectKey ?? null,
				);
			});

			$effect(() => {
				const currentProject = deps.workspaceContext.currentProject;
				if (!currentProject) return;
				const version = gitProjectInvalidations.version(currentProject.effectiveProjectKey);
				const key = `${currentProject.effectiveProjectKey}:${version}`;
				if (version === 0 || key === lastCommitInvalidationKey) return;
				lastCommitInvalidationKey = key;
				untrack(() => deps.gitQuickSummary.scheduleRefresh('invalidation', 100));
			});
		});
	}

	destroy(): void {
		this.#destroyEffects();
	}
}
