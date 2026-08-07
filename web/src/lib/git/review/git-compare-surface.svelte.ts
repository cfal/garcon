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

export const DEFAULT_GIT_COMPARISON: GitComparisonSpecification = {
	fromRevision: 'HEAD',
	toKind: 'working-tree',
	mode: 'direct',
};

interface GitCompareSurfaceControllerDeps extends GitSurfaceControllerDeps {
	comparisonPreferences: GitComparisonPreferences;
}

interface GitComparisonSessionIdentity {
	readonly chatId: string;
	readonly targetIdentity: string;
}

interface ActiveGitComparisonSession {
	identity: GitComparisonSessionIdentity;
	projectPath: string;
}

export class GitCompareSurfaceController implements PortableSingletonController {
	readonly comparison = new GitComparisonController();
	readonly target: GitTargetSessionController;
	presentationVisible = $state(false);

	#chatId: string | null = null;
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
				this.#rememberConfirmedComparison();
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
				const projectPath = this.target.activeProjectPath;
				if (projectPath && this.comparison.snapshot) {
					this.comparison.setDisplayOptions(projectPath, diffMode, contextLines);
				}
			},
		});
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		const nextChatId = projectStateChatId(projectState);
		const chatChanged = nextChatId !== this.#chatId;
		if (chatChanged) {
			this.#rememberConfirmedComparison();
			this.comparison.reset();
			this.#loadedSessionIdentity = null;
			this.#chatId = nextChatId;
		}
		const wasProjectIdentityPending = this.target.projectIdentityPending;
		this.target.setProjectState(projectState);
		const completedProjectResolution =
			wasProjectIdentityPending && projectState.kind === 'available';
		if (this.presentationVisible && (chatChanged || completedProjectResolution)) {
			void this.#activateComparison();
		}
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

	async compareCurrentSpecification(): Promise<boolean> {
		const active = this.#activeSession();
		if (!active) return false;

		const requestIdentity = active.identity;
		this.#loadedSessionIdentity = requestIdentity;
		const loaded = await this.comparison.compare(active.projectPath);
		if (this.#loadedSessionIdentity !== requestIdentity) return false;
		if (loaded) this.#rememberConfirmedComparison(requestIdentity);
		return loaded;
	}

	closeComparisonDialog(): void {
		this.comparison.closeDialog();
		// Keeps an empty cancelled session retryable on the next activation.
		if (!this.comparison.snapshot) this.#loadedSessionIdentity = null;
	}

	dispose(): void {
		this.#rememberConfirmedComparison();
		this.#unregisterReviewDisplay();
		this.target.dispose();
		this.comparison.reset();
		this.#chatId = null;
		this.#loadedSessionIdentity = null;
	}

	async #activateComparison(): Promise<void> {
		if (!this.presentationVisible) return;
		const active = this.#activeSession();
		if (!active) return;
		if (sameSession(this.#loadedSessionIdentity, active.identity)) return;

		const specification =
			this.deps.comparisonPreferences.recall(active.identity.chatId) ?? DEFAULT_GIT_COMPARISON;
		this.comparison.setSpecification(specification, {
			diffMode: this.deps.reviewDisplay.diffMode,
			contextLines: this.deps.reviewDisplay.contextLines,
		});
		// Marked before the await so a concurrent activation for the same
		// session does not start a second load.
		const activationIdentity = active.identity;
		this.#loadedSessionIdentity = activationIdentity;
		const loaded = await this.comparison.compare(active.projectPath);
		if (this.#loadedSessionIdentity !== activationIdentity) return;
		// A failed default load must stay retryable on the next visibility or
		// activation pass; a superseded session keeps the newer marker.
		if (!loaded) {
			this.#loadedSessionIdentity = null;
			return;
		}
		this.#rememberConfirmedComparison(activationIdentity);
	}

	#activeSession(): ActiveGitComparisonSession | null {
		const chatId = this.#chatId;
		const projectPath = this.target.activeProjectPath;
		const targetIdentity = this.target.appliedIdentity;
		if (
			!chatId ||
			!projectPath ||
			!targetIdentity ||
			this.target.projectIdentityPending ||
			targetIdentity !== this.target.identity
		) {
			return null;
		}
		return {
			identity: { chatId, targetIdentity },
			projectPath,
		};
	}

	#rememberConfirmedComparison(identity = this.#loadedSessionIdentity): void {
		const specification = this.comparison.confirmedSpecification;
		if (!identity || !specification) return;
		this.deps.comparisonPreferences.remember(identity.chatId, specification);
	}
}

function projectStateChatId(projectState: WorkspaceProjectState): string | null {
	if (projectState.kind === 'absent') return null;
	return projectState.kind === 'resolving'
		? projectState.context.chatId
		: projectState.project.chatId;
}

function sameSession(
	left: GitComparisonSessionIdentity | null,
	right: GitComparisonSessionIdentity,
): boolean {
	return left?.chatId === right.chatId && left.targetIdentity === right.targetIdentity;
}
