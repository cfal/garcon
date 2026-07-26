import { gitRevertCommit } from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
import {
	GitHistoryController,
	type GitHistoryRevertTarget,
} from './git-history.svelte.js';
import { GitHistoryComparisonSelectionState } from './git-history-comparison-selection.svelte.js';

export class GitHistorySurfaceController implements PortableSingletonController {
	readonly history = new GitHistoryController();
	readonly comparisonSelection = new GitHistoryComparisonSelectionState();
	readonly target: GitTargetSessionController;
	presentationVisible = $state(false);
	pendingRevertCommit = $state<GitHistoryRevertTarget | null>(null);
	isRevertingCommit = $state(false);
	lastError = $state<string | null>(null);

	#unregisterReviewDisplay: () => void;

	constructor(private readonly deps: GitSurfaceControllerDeps) {
		this.target = new GitTargetSessionController({
			kind: 'git-history',
			createBranchSelector: deps.createGitBranchSelector,
			canChangeTarget: () =>
				!this.isRevertingCommit &&
				deps.gitMutations.pendingCount(singletonSurfaceId('git-history')) === 0,
			onTargetChanged: (target, _identity, reason, identityChanged) => {
				if (reason === 'invalidation' && !identityChanged) {
					if (target && this.presentationVisible) {
						this.history.loadInitial(target.projectPath);
					}
					return;
				}
				this.comparisonSelection.cancel();
				this.pendingRevertCommit = null;
				this.lastError = null;
				this.history.resetForProject(target?.projectPath ?? null);
				if (target && this.presentationVisible) {
					this.deps.reviewDisplay.reconcile(singletonSurfaceId('git-history'));
					this.history.loadInitial(target.projectPath);
				}
			},
		});
		this.#unregisterReviewDisplay = deps.reviewDisplay.register(
			singletonSurfaceId('git-history'),
			{
				isVisible: () => this.presentationVisible,
				hasOpenCommentComposer: () => this.history.document.commentComposer.open,
				markContextChangeBlocked: () =>
					this.history.document.markContextChangeBlocked(),
				apply: (diffMode, contextLines) =>
					this.history.setDisplayOptions(
						this.target.activeProjectPath,
						diffMode,
						contextLines,
					),
			},
		);
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.target.setProjectState(projectState);
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
		this.target.setPresentationVisible(visible);
		if (!visible) {
			this.history.pauseListLoading();
			return;
		}
		const projectPath = this.target.activeProjectPath;
		if (projectPath && this.target.appliedIdentity) {
			this.history.ensureInitialLoaded(projectPath);
		}
		if (this.target.appliedIdentity === this.target.identity) {
			this.deps.reviewDisplay.reconcile(singletonSurfaceId('git-history'));
		}
	}

	refreshForInvalidation(effectiveProjectKey: string, version: number): Promise<boolean> {
		return this.target.refreshForInvalidation(effectiveProjectKey, version);
	}

	async revertPendingCommit(): Promise<boolean> {
		const target = this.pendingRevertCommit;
		const projectPath = this.target.activeProjectPath;
		const effectiveProjectKey = this.target.effectiveProjectKey;
		if (!target || !projectPath || !effectiveProjectKey || this.isRevertingCommit) {
			return false;
		}
		const identity = this.target.identity;
		this.isRevertingCommit = true;
		try {
			const result = await this.deps.gitMutations.run({
				surfaceId: singletonSurfaceId('git-history'),
				effectiveProjectKey,
				projectPath,
				execute: () => gitRevertCommit(projectPath, target.hash),
				didMutate: (response) => response.success,
			});
			if (identity !== this.target.identity) return false;
			if (!result.success) {
				this.lastError = result.error ?? m.git_history_revert_failed();
				return false;
			}
			this.lastError = null;
			this.pendingRevertCommit = null;
			return true;
		} catch (error) {
			if (identity === this.target.identity) {
				this.lastError = m.git_history_revert_failed_detail({
					detail: error instanceof Error ? error.message : String(error),
				});
			}
			return false;
		} finally {
			this.isRevertingCommit = false;
		}
	}

	dispose(): void {
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.history.resetForProject(null);
		this.comparisonSelection.cancel();
		this.pendingRevertCommit = null;
		this.isRevertingCommit = false;
		this.lastError = null;
	}
}
