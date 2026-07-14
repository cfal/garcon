import { untrack } from 'svelte';
import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte.js';
import type { GhCapabilityStore } from '$lib/stores/gh-capability.svelte.js';
import type { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte.js';
import { gitProjectInvalidations } from '$lib/stores/git/git-project-invalidation.svelte.js';
import type { GitQuickSummaryStore } from '$lib/stores/git/git-quick-summary.svelte.js';
import type { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { SingletonSurfaceRegistry } from '$lib/stores/singleton-surfaces.svelte.js';
import type { WorkspaceContextStore } from './workspace-context.svelte.js';

interface WorkspaceDomainBindingsDeps {
	workspaceContext: WorkspaceContextStore;
	chatSessions: ChatSessionsStore;
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
				const processing = deps.chatSessions.selectedChat?.isProcessing ?? false;
				deps.gitQuickSummary.setEnabled(deps.localSettings.showQuickCommitTray);
				deps.gitQuickSummary.setProcessing(processing);
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
				return untrack(() => deps.gitQuickSummary.startPolling());
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
