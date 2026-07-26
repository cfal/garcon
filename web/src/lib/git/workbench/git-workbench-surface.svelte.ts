import type { GitDiffTab } from '$lib/api/git.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import type {
	GitTarget,
} from '$lib/git/targets/git-target.js';
import {
	GitTargetSessionController,
	type GitTargetChangeReason,
} from '$lib/git/targets/git-target-session.svelte.js';
import { GitRepositoryController } from '$lib/git/targets/git-repository-controller.svelte.js';
import { GitWorkbenchStore } from './git-workbench.svelte.js';

interface GitWorkbenchSelectionSnapshot {
	selectedFile: string | null;
	diffTab: GitDiffTab;
}

const SELECTION_CACHE_LIMIT = 8;

export class GitWorkbenchSurfaceController implements PortableSingletonController {
	readonly target: GitTargetSessionController;
	readonly repository: GitRepositoryController;
	readonly workbench: GitWorkbenchStore;
	presentationVisible = $state(false);

	#selectionByTarget = new Map<string, GitWorkbenchSelectionSnapshot>();
	#loadedIdentity: string | null = null;
	#unregisterReviewDisplay: () => void;

	constructor(private readonly deps: GitSurfaceControllerDeps) {
		this.workbench = new GitWorkbenchStore({
			runMutation: (projectPath, execute) =>
				deps.gitMutations.run({
					surfaceId: singletonSurfaceId('git'),
					effectiveProjectKey: this.target.effectiveProjectKey ?? projectPath,
					projectPath,
					execute,
				}),
		});
		this.target = new GitTargetSessionController({
			kind: 'git',
			createBranchSelector: deps.createGitBranchSelector,
			invalidationVersion: deps.invalidationVersion,
			canChangeTarget: () =>
				deps.gitMutations.pendingCount(singletonSurfaceId('git')) === 0,
			beforeCheckout: () => this.workbench.ensureFreshForGitMutation(),
			runCheckoutReconciliation: (projectPath, execute) =>
				this.workbench.runLocalGitReconciliation(projectPath, execute),
			afterCheckout: async () => {
				await this.workbench.refresh({
					reason: 'branch-change',
					preserveSelection: false,
				});
			},
			onTargetChanged: (target, identity, reason, identityChanged) =>
				this.#applyTarget(target, identity, reason, identityChanged),
		});
		this.repository = new GitRepositoryController({
			branches: this.target.branches,
			surfaceId: singletonSurfaceId('git'),
		});
		this.#unregisterReviewDisplay = deps.reviewDisplay.register(
			singletonSurfaceId('git'),
			{
				isVisible: () => this.presentationVisible,
				hasOpenCommentComposer: () => this.workbench.drafts.commentComposer.open,
				markContextChangeBlocked: () =>
					this.workbench.drafts.markContextChangeBlocked(),
				apply: (diffMode, contextLines) =>
					this.workbench.setDisplayOptions(diffMode, contextLines, { refresh: true }),
			},
		);
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.target.setProjectState(projectState);
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
		this.target.setPresentationVisible(visible);
		if (visible && this.target.appliedIdentity === this.target.identity) {
			this.deps.reviewDisplay.reconcile(singletonSurfaceId('git'));
		}
	}

	refreshForInvalidation(effectiveProjectKey: string, version: number): Promise<boolean> {
		return this.target.refreshForInvalidation(effectiveProjectKey, version);
	}

	dispose(): void {
		this.#saveSelection();
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.repository.resetForProject(null);
		this.workbench.reset();
		this.#selectionByTarget.clear();
		this.#loadedIdentity = null;
	}

	async #applyTarget(
		target: GitTarget | null,
		identity: string | null,
		reason: GitTargetChangeReason,
		identityChanged: boolean,
	): Promise<void> {
		const projectPath = target?.projectPath ?? null;
		if (identityChanged) {
			this.#saveSelection();
			const snapshot = identity ? takeMostRecent(this.#selectionByTarget, identity) : null;
			this.workbench.files.activeTab = snapshot?.diffTab ?? 'unstaged';
			this.workbench.setDisplayOptions(
				this.deps.reviewDisplay.diffMode,
				this.deps.reviewDisplay.contextLines,
				{ refresh: false },
			);
			this.repository.resetForProject(projectPath, { deferMetadata: true });
			await this.workbench.setTarget(target);
			this.#loadedIdentity = identity;
			if (
				projectPath &&
				snapshot?.selectedFile &&
				this.workbench.files.filePaths.includes(snapshot.selectedFile)
			) {
				await this.workbench.selectFile(projectPath, snapshot.selectedFile);
			}
			if (projectPath) void this.repository.fetchRemoteStatus(projectPath);
			return;
		}

		if (!projectPath) {
			this.repository.resetForProject(null);
			await this.workbench.setTarget(null);
			return;
		}
		this.repository.refreshDeferredMetadata(projectPath);
		if (reason === 'invalidation') {
			await this.workbench.refresh({
				reason: 'git-action',
				preserveSelection: true,
				preferSelectedFile: true,
			});
		}
	}

	#saveSelection(): void {
		const identity = this.#loadedIdentity;
		if (!identity) return;
		storeMostRecent(this.#selectionByTarget, identity, {
			selectedFile: this.workbench.files.selectedFile,
			diffTab: this.workbench.files.activeTab,
		});
	}
}

function storeMostRecent<V>(entries: Map<string, V>, key: string, value: V): void {
	entries.delete(key);
	entries.set(key, value);
	while (entries.size > SELECTION_CACHE_LIMIT) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
}

function takeMostRecent<V>(entries: Map<string, V>, key: string): V | null {
	const value = entries.get(key);
	if (value === undefined) return null;
	storeMostRecent(entries, key, value);
	return value;
}
