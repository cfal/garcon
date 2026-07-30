import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
import {
	GitComparisonController,
	type GitComparisonDialogDefaults,
} from './git-comparison.svelte.js';

export const DEFAULT_GIT_COMPARISON: GitComparisonDialogDefaults = {
	fromRevision: 'HEAD',
	toKind: 'working-tree',
};

export class GitCompareSurfaceController implements PortableSingletonController {
	readonly comparison = new GitComparisonController();
	readonly target: GitTargetSessionController;
	presentationVisible = $state(false);

	#loadedTargetIdentity: string | null = null;
	#unregisterReviewDisplay: () => void;

	get isLoading(): boolean {
		return (
			this.comparison.isLoading ||
			(!this.comparison.snapshot &&
				(this.target.projectIdentityPending || this.target.isLoadingTargets))
		);
	}

	constructor(private readonly deps: GitSurfaceControllerDeps) {
		this.target = new GitTargetSessionController({
			kind: 'git-compare',
			createBranchSelector: deps.createGitBranchSelector,
			invalidationVersion: deps.invalidationVersion,
			canChangeTarget: () =>
				deps.gitMutations.pendingCount(singletonSurfaceId('git-compare')) === 0,
			onTargetChanged: (_target, _identity, reason, identityChanged) => {
				if (reason === 'invalidation' && !identityChanged) {
					const projectPath = this.target.activeProjectPath;
					if (projectPath && this.presentationVisible) {
						void this.comparison.checkFreshness(projectPath);
					}
					return;
				}
				this.comparison.reset();
				this.#loadedTargetIdentity = null;
				if (this.presentationVisible) {
					void this.#activateComparison();
				}
			},
		});
		this.#unregisterReviewDisplay = deps.reviewDisplay.register(
			singletonSurfaceId('git-compare'),
			{
				isVisible: () => this.presentationVisible,
				hasOpenCommentComposer: () => this.comparison.document.commentComposer.open,
				markContextChangeBlocked: () =>
					this.comparison.document.markContextChangeBlocked(),
				apply: (diffMode, contextLines) => {
					const projectPath = this.target.activeProjectPath;
					if (projectPath && this.comparison.snapshot) {
						this.comparison.setDisplayOptions(projectPath, diffMode, contextLines);
					}
				},
			},
		);
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.target.setProjectState(projectState);
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
		this.target.setPresentationVisible(visible);
		if (visible) {
			if (this.target.appliedIdentity === this.target.identity) {
				this.deps.reviewDisplay.reconcile(singletonSurfaceId('git-compare'));
			}
			void this.#activateComparison();
		}
	}

	refreshForInvalidation(effectiveProjectKey: string, version: number): Promise<boolean> {
		return this.target.refreshForInvalidation(effectiveProjectKey, version);
	}

	dispose(): void {
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.comparison.reset();
		this.#loadedTargetIdentity = null;
	}

	async #activateComparison(): Promise<void> {
		if (
			!this.presentationVisible ||
			this.target.projectIdentityPending ||
			!this.target.activeProjectPath ||
			!this.target.appliedIdentity ||
			this.target.appliedIdentity !== this.target.identity
		) {
			return;
		}

		const projectPath = this.target.activeProjectPath;
		const targetIdentity = this.target.appliedIdentity;
		if (!projectPath || !targetIdentity) return;
		if (this.#loadedTargetIdentity === targetIdentity) return;
		this.comparison.setSpecification(DEFAULT_GIT_COMPARISON, {
			diffMode: this.deps.reviewDisplay.diffMode,
			contextLines: this.deps.reviewDisplay.contextLines,
		});
		this.#loadedTargetIdentity = targetIdentity;
		await this.comparison.compare(projectPath);
	}
}
