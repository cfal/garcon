import { untrack } from 'svelte';
import { effectiveNodeId } from '$shared/execution-nodes';
import type { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';
import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
import type { GitQuickSummaryStore } from '$lib/git/surface/git-quick-summary.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';
import type {
	ProjectResolutionLease,
	ProjectResolutionStore,
} from './project-resolution-store.svelte.js';

interface WorkspaceDomainBindingsDeps {
	workspaceContext: WorkspaceContextStore;
	projectResolution: ProjectResolutionStore;
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
			const currentTargetKey = $derived.by(() => {
				const target = deps.workspaceContext.currentTarget;
				return target ? deps.projectResolution.lifecycleKey(target) : null;
			});

			$effect(() => {
				if (!currentTargetKey) return;
				const target = untrack(() => deps.workspaceContext.currentTarget);
				if (!target) return;
				const lease = untrack(() => deps.projectResolution.retain(target));
				return () => lease.release();
			});

			$effect(() => {
				if (!currentTargetKey) return;
				const hasDemand =
					deps.singletons.hasVisibleProjectSurface || deps.localSettings.showQuickCommitTray;
				if (!hasDemand) return;
				const target = untrack(() => deps.workspaceContext.currentTarget);
				if (!target) return;
				const lease: ProjectResolutionLease = untrack(() => {
					const retained = deps.projectResolution.retain(target);
					void retained.resolve();
					return retained;
				});
				return () => lease.release();
			});

			$effect(() => {
				const project = deps.workspaceContext.projectState;
				const filesProject = deps.workspaceContext.filesProjectState;
				untrack(() => deps.singletons.setProjectState(project, filesProject));
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
				const nodeId = effectiveNodeId(currentProject?.nodeId);
				const project = projectPath ? { nodeId, projectPath } : null;
				deps.gitQuickSummary.setProject(project);
				deps.gitBranchActions.setProject(
					projectPath,
					deps.gitQuickSummary.summaryFor(project)?.branch,
					currentProject?.effectiveProjectKey ?? null,
					nodeId,
				);
			});

			$effect(() => {
				const currentProject = deps.workspaceContext.currentProject;
				if (!currentProject) return;
				const nodeId = effectiveNodeId(currentProject.nodeId);
				const version = gitProjectInvalidations.version(nodeId);
				const key = JSON.stringify([nodeId, currentProject.effectiveProjectKey, version]);
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
