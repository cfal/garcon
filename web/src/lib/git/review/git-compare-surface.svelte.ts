import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import type { GitTarget } from '$lib/git/targets/git-target.js';
import { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
import {
	GitComparisonController,
	type GitComparisonDialogDefaults,
} from './git-comparison.svelte.js';

export const DEFAULT_GIT_COMPARISON: GitComparisonDialogDefaults = {
	fromRevision: 'HEAD',
	toKind: 'working-tree',
};

export interface GitCompareLaunchIntent {
	source?: {
		effectiveProjectKey: string;
		target: GitTarget;
	};
	comparison?: GitComparisonDialogDefaults;
}

export class GitCompareSurfaceController implements PortableSingletonController {
	readonly comparison = new GitComparisonController();
	readonly target: GitTargetSessionController;
	presentationVisible = $state(false);

	#pendingLaunch: { token: number; intent: GitCompareLaunchIntent } | null = null;
	#nextLaunchToken = 0;
	#activationGeneration = 0;
	#loadedTargetIdentity: string | null = null;
	#externalTargetApplications = 0;
	#unregisterReviewDisplay: () => void;

	constructor(private readonly deps: GitSurfaceControllerDeps) {
		this.target = new GitTargetSessionController({
			kind: 'git-compare',
			createBranchSelector: deps.createGitBranchSelector,
			canChangeTarget: () =>
				deps.gitMutations.pendingCount(singletonSurfaceId('git-compare')) === 0,
			onTargetChanged: (_target, _identity, reason, identityChanged) => {
				if (
					reason === 'invalidation' &&
					!identityChanged &&
					!this.#pendingLaunch
				) {
					const projectPath = this.target.activeProjectPath;
					if (projectPath && this.presentationVisible) {
						void this.comparison.checkFreshness(projectPath);
					}
					return;
				}
				this.comparison.reset();
				this.#loadedTargetIdentity = null;
				if (this.presentationVisible && this.#externalTargetApplications === 0) {
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

	prepareLaunch(intent: GitCompareLaunchIntent): number {
		const token = ++this.#nextLaunchToken;
		this.#pendingLaunch = { token, intent };
		if (this.presentationVisible) void this.#activateComparison();
		return token;
	}

	cancelPreparedLaunch(token: number): void {
		if (this.#pendingLaunch?.token === token) this.#pendingLaunch = null;
	}

	dispose(): void {
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.comparison.reset();
		this.#pendingLaunch = null;
		this.#activationGeneration += 1;
		this.#loadedTargetIdentity = null;
	}

	async #activateComparison(): Promise<void> {
		const generation = ++this.#activationGeneration;
		let pending = this.#pendingLaunch;
		if (
			!this.presentationVisible ||
			this.target.projectIdentityPending ||
			!this.target.activeProjectPath ||
			!this.target.appliedIdentity ||
			this.target.appliedIdentity !== this.target.identity
		) {
			return;
		}

		if (pending?.intent.source) {
			const source = pending.intent.source;
			if (source.effectiveProjectKey !== this.target.effectiveProjectKey) {
				if (this.#pendingLaunch?.token === pending.token) {
					this.#pendingLaunch = null;
				}
				pending = null;
				this.comparison.reset();
				this.#loadedTargetIdentity = null;
			} else {
				this.#externalTargetApplications += 1;
				try {
					const applied = await this.target.applyExternalTarget(
						source.effectiveProjectKey,
						source.target,
					);
					if (!applied) return;
				} finally {
					this.#externalTargetApplications -= 1;
				}
			}
		}

		const projectPath = this.target.activeProjectPath;
		const targetIdentity = this.target.appliedIdentity;
		if (
			!this.presentationVisible ||
			!projectPath ||
			!targetIdentity ||
			generation !== this.#activationGeneration
		) {
			return;
		}
		if (!pending && this.#loadedTargetIdentity === targetIdentity) return;

		if (pending && this.#pendingLaunch?.token === pending.token) {
			this.#pendingLaunch = null;
		}
		this.comparison.setSpecification(
			pending?.intent.comparison ?? DEFAULT_GIT_COMPARISON,
			{
				diffMode: this.deps.reviewDisplay.diffMode,
				contextLines: this.deps.reviewDisplay.contextLines,
			},
		);
		this.#loadedTargetIdentity = targetIdentity;
		await this.comparison.compare(projectPath);
	}
}
