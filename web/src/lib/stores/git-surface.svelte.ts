import { getGitTargetCandidates, type GitTargetCandidate } from '$lib/api/git.js';
import { GitPanelStore } from './git-panel.svelte.js';
import {
	GitWorkbenchStore,
	type GitDiffTab,
	type GitWorkbenchTarget,
} from './git-workbench.svelte.js';
import type { GitBranchSelectorState } from './git/git-branch-selector-state.svelte.js';
import type { GitHistoryRevertTarget, GitHistoryScreen } from './git/git-history.svelte.js';
import type { GitMutationCoordinator } from './git-mutations.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export interface GitSurfaceControllerDeps {
	gitBranchActions: GitBranchSelectorState;
	gitMutations: GitMutationCoordinator;
	getCurrentEffectiveProjectKey(): string | null;
}

interface GitProjectSnapshot {
	activeTarget: GitWorkbenchTarget | null;
	activeView: 'changes' | 'history';
	historyScreen: GitHistoryScreen;
	selectedFile: string | null;
	diffTab: GitDiffTab;
}

interface PendingSelectionRestore {
	projectKey: string;
	selectedFile: string | null;
}

export class GitSurfaceController {
	readonly panel: GitPanelStore;
	readonly workbench: GitWorkbenchStore;
	presentationVisible = $state(false);
	targets = $state<GitTargetCandidate[]>([]);
	activeTarget = $state<GitWorkbenchTarget | null>(null);
	isLoadingTargets = $state(false);
	showTargetDialog = $state(false);
	showRevertModal = $state(false);
	pendingRevertCommit = $state<GitHistoryRevertTarget | null>(null);
	isRevertingCommit = $state(false);
	historyScreen = $state<GitHistoryScreen>('list');
	historyRefreshToken = $state(0);
	projectIdentityPending = $state(false);
	#baseProjectPath = $state<string | null>(null);
	#effectiveProjectKey = $state<string | null>(null);
	#lastTargetFetchKey: string | null = null;
	#appliedTargetKey: string | null = null;
	#targetRequestGeneration = 0;
	#contextGeneration = 0;
	#targetRequestAbort: AbortController | null = null;
	#handledInvalidationVersions = new Map<string, number>();
	#projectSnapshots = new Map<string, GitProjectSnapshot>();
	#pendingSelectionRestore: PendingSelectionRestore | null = null;

	constructor(deps: GitSurfaceControllerDeps) {
		this.panel = new GitPanelStore(deps.gitBranchActions);
		this.workbench = new GitWorkbenchStore({
			runMutation: (projectPath, execute) =>
				deps.gitMutations.run({
					surfaceId: 'singleton:git',
					effectiveProjectKey: deps.getCurrentEffectiveProjectKey() ?? projectPath,
					projectPath,
					execute,
				}),
		});
	}

	setPresentationVisible(visible: boolean): void {
		if (this.presentationVisible === visible) return;
		this.presentationVisible = visible;
		if (!visible) {
			if (this.#targetRequestAbort) this.#lastTargetFetchKey = null;
			this.#targetRequestAbort?.abort();
			this.#targetRequestAbort = null;
			this.#targetRequestGeneration += 1;
			this.isLoadingTargets = false;
			return;
		}
		if (!this.projectIdentityPending) void this.#activateCurrentContext();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		if (projectState.kind === 'resolving') {
			this.projectIdentityPending = true;
			return;
		}
		const previousKey = this.#effectiveProjectKey;
		this.projectIdentityPending = false;
		if (projectState.kind === 'absent') {
			this.setContext(null, null);
			return;
		}
		const { project } = projectState;
		this.setContext(project.projectPath, project.effectiveProjectKey);
		if (previousKey === project.effectiveProjectKey && this.presentationVisible) {
			void this.#activateCurrentContext();
		}
	}

	setContext(projectPath: string | null, effectiveProjectKey: string | null): void {
		this.#saveCurrentSnapshot();
		this.#baseProjectPath = projectPath;
		if (effectiveProjectKey === this.#effectiveProjectKey) return;
		this.showTargetDialog = false;
		this.showRevertModal = false;
		this.pendingRevertCommit = null;
		this.isRevertingCommit = false;
		this.#targetRequestAbort?.abort();
		this.#targetRequestAbort = null;
		this.#targetRequestGeneration += 1;
		this.isLoadingTargets = false;
		this.#effectiveProjectKey = effectiveProjectKey;
		this.#contextGeneration += 1;
		this.#lastTargetFetchKey = null;
		this.#appliedTargetKey = null;
		this.targets = [];
		const snapshot = effectiveProjectKey ? this.#takeProjectSnapshot(effectiveProjectKey) : null;
		this.activeTarget = snapshot?.activeTarget ?? this.fallbackTarget;
		this.panel.activeView = snapshot?.activeView ?? 'changes';
		this.historyScreen = snapshot?.historyScreen ?? 'list';
		this.workbench.files.activeTab = snapshot?.diffTab ?? 'unstaged';
		this.#pendingSelectionRestore = effectiveProjectKey
			? { projectKey: effectiveProjectKey, selectedFile: snapshot?.selectedFile ?? null }
			: null;
		if (!projectPath || !effectiveProjectKey) {
			this.#pendingSelectionRestore = null;
			this.panel.resetForProject(null);
			void this.workbench.setTarget(null);
			return;
		}
		if (this.presentationVisible) {
			void this.#activateCurrentContext();
		}
	}

	get effectiveProjectKey(): string | null {
		return this.#effectiveProjectKey;
	}

	get baseProjectPath(): string | null {
		return this.#baseProjectPath;
	}

	get fallbackTarget(): GitWorkbenchTarget | null {
		const projectPath = this.#baseProjectPath;
		if (!projectPath) return null;
		return {
			projectPath,
			repoRoot: projectPath,
			worktreePath: projectPath,
			label: projectPath.split('/').pop() || projectPath,
			branch: '',
			source: 'chat-project',
		};
	}

	get activeProjectPath(): string | null {
		return this.activeTarget?.projectPath ?? this.#baseProjectPath;
	}

	get activeWorktreePath(): string | null {
		return (this.activeTarget ?? this.fallbackTarget)?.worktreePath ?? null;
	}

	takeInvalidationRefresh(effectiveProjectKey: string, version: number): boolean {
		if (version <= (this.#handledInvalidationVersions.get(effectiveProjectKey) ?? 0)) {
			return false;
		}
		this.#handledInvalidationVersions.delete(effectiveProjectKey);
		this.#handledInvalidationVersions.set(effectiveProjectKey, version);
		while (this.#handledInvalidationVersions.size > 8) {
			const oldest = this.#handledInvalidationVersions.keys().next().value;
			if (oldest === undefined) break;
			this.#handledInvalidationVersions.delete(oldest);
		}
		return version > 0;
	}

	async ensureTargets(force = false): Promise<void> {
		const projectPath = this.#baseProjectPath;
		const projectKey = this.#effectiveProjectKey;
		if (this.projectIdentityPending || !this.presentationVisible || !projectPath || !projectKey)
			return;
		if (!force && this.#lastTargetFetchKey === projectKey) return;
		this.#targetRequestAbort?.abort();
		const controller = new AbortController();
		this.#targetRequestAbort = controller;
		const generation = ++this.#targetRequestGeneration;
		this.#lastTargetFetchKey = projectKey;
		this.isLoadingTargets = true;
		try {
			const result = await getGitTargetCandidates(projectPath, { signal: controller.signal });
			if (!this.#isCurrentTargetRequest(generation, controller.signal)) return;
			this.targets = result.targets;
			const current =
				result.targets.find((candidate) => candidate.isCurrent && !candidate.isMissing) ??
				result.targets.find((candidate) => !candidate.isMissing) ??
				null;
			if (
				!this.activeTarget ||
				!result.targets.some(
					(candidate) =>
						candidate.worktreePath === this.activeTarget?.worktreePath && !candidate.isMissing,
				)
			) {
				this.activeTarget = current ? toWorkbenchTarget(current) : this.fallbackTarget;
				await this.applyActiveTarget();
			}
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentTargetRequest(generation, controller.signal)) {
				return;
			}
			this.workbench.reportError(
				`Failed to load Git targets: ${error instanceof Error ? error.message : String(error)}`,
			);
			const fallback = this.fallbackTarget;
			this.targets = fallback ? [toTargetCandidate(fallback)] : [];
			this.activeTarget = fallback;
			await this.applyActiveTarget();
		} finally {
			if (this.#isCurrentTargetRequest(generation, controller.signal)) {
				this.isLoadingTargets = false;
				this.#targetRequestAbort = null;
			}
		}
	}

	async selectTarget(candidate: GitTargetCandidate): Promise<void> {
		if (this.projectIdentityPending) return;
		this.activeTarget = toWorkbenchTarget(candidate);
		this.targets = [
			candidate,
			...this.targets.filter((target) => target.worktreePath !== candidate.worktreePath),
		];
		this.showTargetDialog = false;
		await this.applyActiveTarget();
		void this.ensureTargets(true);
	}

	async applyActiveTarget(): Promise<void> {
		if (this.projectIdentityPending || !this.presentationVisible) return;
		const contextGeneration = this.#contextGeneration;
		const projectKey = this.#effectiveProjectKey;
		const target = this.activeTarget ?? this.fallbackTarget;
		const targetKey = target
			? JSON.stringify([target.projectPath, target.repoRoot, target.worktreePath])
			: null;
		if (targetKey === this.#appliedTargetKey) return;
		this.#appliedTargetKey = targetKey;
		const projectPath = target?.projectPath ?? null;
		this.panel.resetForProject(projectPath, {
			deferMetadata: true,
			currentBranch: target?.branch,
			effectiveProjectKey: this.#effectiveProjectKey,
		});
		await this.workbench.setTarget(target);
		const currentTarget = this.activeTarget ?? this.fallbackTarget;
		const currentTargetKey = currentTarget
			? JSON.stringify([
					currentTarget.projectPath,
					currentTarget.repoRoot,
					currentTarget.worktreePath,
				])
			: null;
		if (
			contextGeneration !== this.#contextGeneration ||
			projectKey !== this.#effectiveProjectKey ||
			targetKey !== currentTargetKey
		)
			return;
		const pendingSelection = this.#pendingSelectionRestore;
		if (
			pendingSelection?.projectKey === this.#effectiveProjectKey &&
			projectPath &&
			pendingSelection.selectedFile &&
			this.workbench.files.filePaths.includes(pendingSelection.selectedFile)
		) {
			await this.workbench.selectFile(projectPath, pendingSelection.selectedFile);
		}
		if (pendingSelection?.projectKey === this.#effectiveProjectKey) {
			this.#pendingSelectionRestore = null;
		}
		if (projectPath) void this.panel.fetchRemoteStatus(projectPath);
	}

	dispose(): void {
		this.presentationVisible = false;
		this.#targetRequestAbort?.abort();
		this.#targetRequestAbort = null;
		this.#targetRequestGeneration += 1;
		this.isLoadingTargets = false;
		this.targets = [];
		this.activeTarget = null;
		this.#baseProjectPath = null;
		this.#effectiveProjectKey = null;
		this.#contextGeneration += 1;
		this.#lastTargetFetchKey = null;
		this.#appliedTargetKey = null;
		this.#handledInvalidationVersions.clear();
		this.#projectSnapshots.clear();
		this.#pendingSelectionRestore = null;
		this.panel.resetForProject(null);
		this.workbench.reset();
	}

	async #activateCurrentContext(): Promise<void> {
		if (this.projectIdentityPending) return;
		const projectKey = this.#effectiveProjectKey;
		if (!projectKey) return;
		await this.ensureTargets();
		if (
			this.projectIdentityPending ||
			!this.presentationVisible ||
			this.#effectiveProjectKey !== projectKey
		)
			return;
		await this.applyActiveTarget();
	}

	#saveCurrentSnapshot(): void {
		const projectKey = this.#effectiveProjectKey;
		if (!projectKey) return;
		this.#projectSnapshots.delete(projectKey);
		this.#projectSnapshots.set(projectKey, {
			activeTarget: this.activeTarget ? { ...this.activeTarget } : null,
			activeView: this.panel.activeView,
			historyScreen: this.historyScreen,
			selectedFile: this.workbench.files.selectedFile,
			diffTab: this.workbench.files.activeTab,
		});
		while (this.#projectSnapshots.size > 8) {
			const oldest = this.#projectSnapshots.keys().next().value;
			if (!oldest) break;
			this.#projectSnapshots.delete(oldest);
		}
	}

	#takeProjectSnapshot(projectKey: string): GitProjectSnapshot | null {
		const snapshot = this.#projectSnapshots.get(projectKey);
		if (!snapshot) return null;
		this.#projectSnapshots.delete(projectKey);
		this.#projectSnapshots.set(projectKey, snapshot);
		return snapshot;
	}

	#isCurrentTargetRequest(generation: number, signal: AbortSignal): boolean {
		return !signal.aborted && generation === this.#targetRequestGeneration;
	}
}

function toWorkbenchTarget(candidate: GitTargetCandidate): GitWorkbenchTarget {
	return {
		projectPath: candidate.projectPath,
		repoRoot: candidate.repoRoot,
		worktreePath: candidate.worktreePath,
		label: candidate.label,
		branch: candidate.branch,
		source: candidate.source,
	};
}

function toTargetCandidate(target: GitWorkbenchTarget): GitTargetCandidate {
	return {
		projectPath: target.projectPath,
		repoRoot: target.repoRoot,
		worktreePath: target.worktreePath,
		label: target.label,
		branch: target.branch ?? '',
		source: target.source,
		isCurrent: true,
		isMissing: false,
	};
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}
