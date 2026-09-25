import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitTargetSessionController } from '$lib/git/targets/git-target-session.svelte.js';
import {
	GitComparisonController,
	type GitComparisonSpecification,
} from './git-comparison.svelte.js';
import type { GitComparisonPreferences } from './git-comparison-preferences.js';
import type { GitProjectTarget } from '$lib/api/git-client.js';

export const DEFAULT_GIT_COMPARISON: GitComparisonSpecification = {
	fromRevision: 'HEAD',
	toKind: 'working-tree',
	mode: 'direct',
};

interface GitCompareSurfaceControllerDeps extends GitSurfaceControllerDeps {
	comparisonPreferences: GitComparisonPreferences;
}

interface GitComparisonSessionIdentity extends GitProjectTarget {
	readonly chatId: string | null;
	readonly targetIdentity: string;
}

export class GitCompareSurfaceController implements PortableSingletonController {
	readonly comparison = new GitComparisonController();
	readonly target: GitTargetSessionController;
	presentationVisible = $state(false);

	#chatId: string | null = null;
	#selectionPending = false;
	#selectionActivationGeneration = 0;
	#loadedSessionIdentity: GitComparisonSessionIdentity | null = null;
	#unregisterReviewDisplay: () => void;

	get isLoading(): boolean {
		return (
			this.comparison.isLoading ||
			(!this.comparison.snapshot &&
				(this.target.projectIdentityPending || this.target.isLoadingTargets))
		);
	}

	constructor(private readonly deps: GitCompareSurfaceControllerDeps) {
		this.target = new GitTargetSessionController({
			kind: 'git-compare',
			projectSelection: deps.projectSelection,
			createBranchSelector: deps.createGitBranchSelector,
			invalidationVersion: deps.invalidationVersion,
			onUnavailable: () => this.comparison.suspend(),
			onProjectSelectionChanged: () => this.#reconcileSelectionSession(),
			canChangeTarget: () =>
				deps.gitMutations.pendingCount(singletonSurfaceId('git-compare')) === 0,
			onTargetChanged: (_target, _identity, reason, identityChanged) => {
				if (reason === 'invalidation' && !identityChanged) {
					const project = this.target.requestTarget;
					if (project && this.presentationVisible) {
						void this.comparison.checkFreshness(project);
					}
					return;
				}
				this.#selectionActivationGeneration += 1;
				if (reason === 'session' && !identityChanged && _target) {
					if (this.#loadedSessionIdentity) this.comparison.refreshSession(_target);
					else void this.#activateComparison();
					return;
				}
				this.#rememberConfirmedChatComparison();
				this.comparison.reset();
				this.#loadedSessionIdentity = null;
				if (this.presentationVisible) {
					void this.#activateComparison();
				}
			},
		});
		this.#unregisterReviewDisplay = deps.reviewDisplay.register(singletonSurfaceId('git-compare'), {
			isVisible: () => this.presentationVisible,
			hasOpenCommentComposer: () => this.comparison.document.commentComposer.open,
			markContextChangeBlocked: () => this.comparison.document.markContextChangeBlocked(),
			apply: (diffMode, contextLines) => {
				const project = this.target.requestTarget;
				if (project && this.comparison.snapshot) {
					this.comparison.setDisplayOptions(project, diffMode, contextLines);
				}
			},
		});
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.target.setProjectState(projectState);
	}

	#reconcileSelectionSession(): void {
		const nextChatId = this.target.projectSelection.chatId;
		const chatChanged = this.#chatId !== nextChatId;
		const completedResolution = this.#selectionPending && !this.target.projectIdentityPending;
		this.#selectionPending = this.target.projectIdentityPending;
		if (chatChanged) {
			this.#rememberConfirmedChatComparison();
			this.comparison.reset();
			this.#loadedSessionIdentity = null;
			this.#chatId = nextChatId;
		}
		if (this.presentationVisible && (chatChanged || completedResolution)) {
			void this.#activateSelectionSession();
		}
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
		this.target.setPresentationVisible(visible);
		if (visible) {
			if (this.target.appliedIdentity === this.target.identity) {
				this.deps.reviewDisplay.reconcile(singletonSurfaceId('git-compare'));
			}
			void this.#activateSelectionSession();
		}
	}

	refreshForInvalidation(effectiveProjectKey: string, version: number): Promise<boolean> {
		return this.target.refreshForInvalidation(effectiveProjectKey, version);
	}

	async compareCurrentSpecification(): Promise<boolean> {
		const identity = this.#activeSessionIdentity();
		if (!identity) return false;

		this.#loadedSessionIdentity = identity;
		const loaded = await this.comparison.compare(identity);
		if (this.#loadedSessionIdentity !== identity) return false;
		if (loaded) this.#rememberConfirmedUserSelection(identity);
		return loaded;
	}

	closeComparisonDialog(): void {
		this.comparison.closeDialog();
		// Keeps an empty cancelled session retryable on the next activation.
		if (!this.comparison.snapshot) this.#loadedSessionIdentity = null;
	}

	dispose(): void {
		this.#selectionActivationGeneration += 1;
		this.#rememberConfirmedChatComparison();
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.comparison.reset();
		this.#chatId = null;
		this.#loadedSessionIdentity = null;
	}

	async #activateSelectionSession(): Promise<void> {
		const generation = ++this.#selectionActivationGeneration;
		await this.target.activate();
		// Target callbacks own any load or refresh required by the pending activation.
		if (generation === this.#selectionActivationGeneration) await this.#activateComparison();
	}

	async #activateComparison(): Promise<void> {
		if (!this.presentationVisible) return;
		const identity = this.#activeSessionIdentity();
		if (!identity) return;
		if (sameSession(this.#loadedSessionIdentity, identity)) return;

		const specification =
			this.deps.comparisonPreferences.recall({
				executorId: identity.executorId,
				chatId: identity.chatId,
				projectPath: identity.projectPath,
			}) ?? DEFAULT_GIT_COMPARISON;
		this.comparison.setSpecification(specification, {
			diffMode: this.deps.reviewDisplay.diffMode,
			contextLines: this.deps.reviewDisplay.contextLines,
		});
		// Marked before the await so a concurrent activation for the same
		// session does not start a second load.
		this.#loadedSessionIdentity = identity;
		const loaded = await this.comparison.compare(identity);
		if (this.#loadedSessionIdentity !== identity) return;
		// A failed default load must stay retryable on the next visibility or
		// activation pass; a superseded session keeps the newer marker.
		if (!loaded) {
			this.#loadedSessionIdentity = null;
			return;
		}
		this.#rememberConfirmedChatComparison(identity);
	}

	#activeSessionIdentity(): GitComparisonSessionIdentity | null {
		const chatId = this.target.projectSelection.chatId;
		const projectPath = this.target.activeProjectPath;
		const targetIdentity = this.target.appliedIdentity;
		if (
			!projectPath ||
			!targetIdentity ||
			this.target.projectIdentityPending ||
			targetIdentity !== this.target.identity
		) {
			return null;
		}
		return { chatId, targetIdentity, projectPath, executorId: this.target.executorId };
	}

	#rememberConfirmedChatComparison(identity = this.#loadedSessionIdentity): void {
		const specification = this.comparison.confirmedSpecification;
		if (!identity || !specification) return;
		this.deps.comparisonPreferences.rememberChat(identity, specification);
	}

	#rememberConfirmedUserSelection(identity: GitComparisonSessionIdentity): void {
		const specification = this.comparison.confirmedSpecification;
		if (!specification) return;
		this.deps.comparisonPreferences.rememberUserSelection(identity, specification);
	}
}

function sameSession(
	left: GitComparisonSessionIdentity | null,
	right: GitComparisonSessionIdentity,
): boolean {
	return (
		left?.chatId === right.chatId &&
		left.executorId === right.executorId &&
		left.targetIdentity === right.targetIdentity &&
		left.projectPath === right.projectPath
	);
}
