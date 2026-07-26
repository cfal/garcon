import {
	getGitTargetCandidates,
	type GitRefKind,
	type GitTargetCandidate,
} from '$lib/api/git.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import {
	singletonSurfaceId,
	type PortableSingletonKind,
} from '$lib/workspace/surface-types.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { GitBranchSelectorState } from './git-branch-selector-state.svelte.js';
import {
	gitTargetCandidateFromTarget,
	gitTargetFromCandidate,
	gitTargetIdentity,
	type GitTarget,
} from './git-target.js';

const TARGET_CACHE_LIMIT = 8;

export type GitTargetSurfaceKind = Extract<
	PortableSingletonKind,
	'git' | 'git-history' | 'git-compare' | 'commit'
>;
export type GitTargetChangeReason = 'project' | 'selection' | 'checkout' | 'invalidation';

export interface GitTargetSessionDeps {
	kind: GitTargetSurfaceKind;
	createBranchSelector(): GitBranchSelectorState;
	canChangeTarget(): boolean;
	beforeCheckout?(): boolean | Promise<boolean>;
	runCheckoutReconciliation?<T>(
		projectPath: string,
		execute: () => Promise<T>,
	): Promise<T>;
	afterCheckout?(projectPath: string): void | Promise<void>;
	onTargetChanged(
		target: GitTarget | null,
		identity: string | null,
		reason: GitTargetChangeReason,
		identityChanged: boolean,
	): void | Promise<void>;
}

export class GitTargetSessionController implements PortableSingletonController {
	readonly surfaceId: string;
	readonly branches: GitBranchSelectorState;
	presentationVisible = $state(false);
	projectIdentityPending = $state(false);
	targets = $state<GitTargetCandidate[]>([]);
	activeTarget = $state<GitTarget | null>(null);
	isLoadingTargets = $state(false);
	showTargetDialog = $state(false);
	lastError = $state<string | null>(null);
	baseProjectPath = $state<string | null>(null);
	effectiveProjectKey = $state<string | null>(null);

	#targetByProject = new Map<string, GitTarget>();
	#requestAbort: AbortController | null = null;
	#requestGeneration = 0;
	#contextGeneration = 0;
	#activation:
		| {
				contextGeneration: number;
				promise: Promise<void>;
		  }
		| null = null;
	#lastTargetFetchKey: string | null = null;
	#appliedIdentity: string | null = null;
	#handledInvalidationVersions = new Map<string, number>();
	#pendingInvalidationVersions = new Map<string, number>();

	constructor(private readonly deps: GitTargetSessionDeps) {
		this.surfaceId = singletonSurfaceId(deps.kind);
		this.branches = deps.createBranchSelector();
	}

	get fallbackTarget(): GitTarget | null {
		const path = this.baseProjectPath;
		return path
			? {
					projectPath: path,
					repoRoot: path,
					worktreePath: path,
					label: path.split('/').pop() || path,
					branch: '',
					source: 'chat-project',
				}
			: null;
	}

	get activeProjectPath(): string | null {
		return (this.activeTarget ?? this.fallbackTarget)?.projectPath ?? null;
	}

	get activeWorktreePath(): string | null {
		return (this.activeTarget ?? this.fallbackTarget)?.worktreePath ?? null;
	}

	get identity(): string | null {
		const key = this.effectiveProjectKey;
		const target = this.activeTarget ?? this.fallbackTarget;
		return key && target ? gitTargetIdentity(key, target) : null;
	}

	get appliedIdentity(): string | null {
		return this.#appliedIdentity;
	}

	get canChangeTarget(): boolean {
		return !this.projectIdentityPending && this.deps.canChangeTarget();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		if (projectState.kind === 'resolving') {
			this.projectIdentityPending = true;
			this.closeDialogs();
			this.#cancelTargetRequest();
			return;
		}
		this.projectIdentityPending = false;
		if (projectState.kind === 'absent') {
			this.#setContext(null, null);
			return;
		}
		this.#setContext(
			projectState.project.projectPath,
			projectState.project.effectiveProjectKey,
		);
	}

	setPresentationVisible(visible: boolean): void {
		if (this.presentationVisible === visible) return;
		this.presentationVisible = visible;
		if (!visible) {
			this.closeDialogs();
			this.#cancelTargetRequest();
			return;
		}
		if (!this.projectIdentityPending) void this.activate();
	}

	async activate(): Promise<void> {
		if (!this.presentationVisible || this.projectIdentityPending) return;
		const contextGeneration = this.#contextGeneration;
		if (this.#activation?.contextGeneration === contextGeneration) {
			return this.#activation.promise;
		}
		const activation = (async () => {
			await this.ensureTargets();
			if (
				!this.presentationVisible ||
				this.projectIdentityPending ||
				contextGeneration !== this.#contextGeneration
			) {
				return;
			}
			await this.#applyTarget('project');
		})();
		const tracked = activation.finally(() => {
			if (this.#activation?.promise === tracked) this.#activation = null;
		});
		this.#activation = { contextGeneration, promise: tracked };
		return tracked;
	}

	async selectTarget(candidate: GitTargetCandidate): Promise<boolean> {
		if (!this.canChangeTarget) return false;
		this.activeTarget = gitTargetFromCandidate(candidate);
		this.targets = [
			candidate,
			...this.targets.filter((target) => target.worktreePath !== candidate.worktreePath),
		];
		this.showTargetDialog = false;
		this.#rememberTarget();
		await this.#applyTarget('selection');
		void this.#reconcileSelectedTarget();
		return true;
	}

	async applyExternalTarget(
		effectiveProjectKey: string,
		target: GitTarget,
	): Promise<boolean> {
		if (
			this.projectIdentityPending ||
			effectiveProjectKey !== this.effectiveProjectKey
		) {
			return false;
		}
		this.activeTarget = { ...target };
		this.#rememberTarget();
		await this.#applyTarget('selection');
		return true;
	}

	async switchBranch(
		branch: string,
		refKind: GitRefKind | undefined,
	): Promise<boolean> {
		return this.#runBranchChange(() => {
			const projectPath = this.activeProjectPath;
			const effectiveProjectKey = this.effectiveProjectKey;
			if (!projectPath || !effectiveProjectKey) return Promise.resolve(false);
			return this.branches.switchBranch(
				projectPath,
				branch,
				refKind,
				this.surfaceId,
				effectiveProjectKey,
			);
		}, branch);
	}

	openNewBranchDialog(): boolean {
		const projectPath = this.activeProjectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		if (!projectPath || !effectiveProjectKey || !this.canChangeTarget) return false;
		this.branches.openNewBranchDialog(projectPath, this.surfaceId, effectiveProjectKey);
		return true;
	}

	async createBranch(): Promise<boolean> {
		return this.#runBranchChange(
			() => this.branches.createBranch(),
			() => this.branches.currentBranch,
		);
	}

	async ensureTargets(force = false): Promise<boolean> {
		const projectPath = this.baseProjectPath;
		const projectKey = this.effectiveProjectKey;
		if (
			this.projectIdentityPending ||
			!this.presentationVisible ||
			!projectPath ||
			!projectKey
		) {
			return false;
		}
		if (!force && this.#lastTargetFetchKey === projectKey) return false;
		this.#requestAbort?.abort();
		const controller = new AbortController();
		this.#requestAbort = controller;
		const generation = ++this.#requestGeneration;
		const contextGeneration = this.#contextGeneration;
		const previousIdentity = this.identity;
		this.#lastTargetFetchKey = projectKey;
		this.isLoadingTargets = true;
		try {
			const result = await getGitTargetCandidates(projectPath, {
				signal: controller.signal,
			});
			if (
				!this.#isCurrentTargetRequest(
					generation,
					contextGeneration,
					projectKey,
					controller.signal,
				)
			) {
				return false;
			}
			this.targets = result.targets;
			const selected = this.activeTarget
				? result.targets.find(
						(candidate) =>
							candidate.worktreePath === this.activeTarget?.worktreePath &&
							!candidate.isMissing,
					)
				: null;
			const current =
				result.targets.find((candidate) => candidate.isCurrent && !candidate.isMissing) ??
				result.targets.find((candidate) => !candidate.isMissing) ??
				null;
			this.activeTarget = selected
				? gitTargetFromCandidate(selected)
				: current
					? gitTargetFromCandidate(current)
					: this.fallbackTarget;
			this.#rememberTarget();
			this.lastError = null;
			return previousIdentity !== this.identity;
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentTargetRequest(
					generation,
					contextGeneration,
					projectKey,
					controller.signal,
				)
			) {
				return false;
			}
			this.lastError = `Failed to load Git targets: ${
				error instanceof Error ? error.message : String(error)
			}`;
			const fallback = this.fallbackTarget;
			this.targets = fallback ? [gitTargetCandidateFromTarget(fallback)] : [];
			this.activeTarget = fallback;
			return previousIdentity !== this.identity;
		} finally {
			if (
				this.#isCurrentTargetRequest(
					generation,
					contextGeneration,
					projectKey,
					controller.signal,
				)
			) {
				this.isLoadingTargets = false;
				this.#requestAbort = null;
			}
		}
	}

	async refreshForInvalidation(
		effectiveProjectKey: string,
		version: number,
	): Promise<boolean> {
		const handled = this.#handledInvalidationVersions.get(effectiveProjectKey) ?? 0;
		const pending = this.#pendingInvalidationVersions.get(effectiveProjectKey) ?? 0;
		if (
			!this.presentationVisible ||
			effectiveProjectKey !== this.effectiveProjectKey ||
			version <= 0 ||
			version <= Math.max(handled, pending)
		) {
			return false;
		}
		storeMostRecent(this.#pendingInvalidationVersions, effectiveProjectKey, version);
		try {
			await this.ensureTargets(true);
			if (
				!this.presentationVisible ||
				effectiveProjectKey !== this.effectiveProjectKey ||
				this.#pendingInvalidationVersions.get(effectiveProjectKey) !== version
			) {
				return false;
			}
			await this.#applyTarget('invalidation', true);
			storeMostRecent(this.#handledInvalidationVersions, effectiveProjectKey, version);
			return true;
		} finally {
			if (this.#pendingInvalidationVersions.get(effectiveProjectKey) === version) {
				this.#pendingInvalidationVersions.delete(effectiveProjectKey);
			}
		}
	}

	async refreshTargets(): Promise<void> {
		await this.ensureTargets(true);
		if (this.presentationVisible) await this.#applyTarget('project', true);
	}

	closeDialogs(): void {
		this.showTargetDialog = false;
		this.branches.closeBranchDropdown();
		this.branches.closeNewBranchDialog();
	}

	dismissError(): void {
		this.lastError = null;
	}

	dispose(): void {
		this.presentationVisible = false;
		this.closeDialogs();
		this.#cancelTargetRequest();
		this.branches.destroy();
		this.targets = [];
		this.activeTarget = null;
		this.baseProjectPath = null;
		this.effectiveProjectKey = null;
		this.#targetByProject.clear();
		this.#handledInvalidationVersions.clear();
		this.#pendingInvalidationVersions.clear();
		this.#appliedIdentity = null;
		this.#activation = null;
	}

	async #runBranchChange(
		mutate: () => Promise<boolean>,
		branch: string | (() => string),
	): Promise<boolean> {
		const projectPath = this.activeProjectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const identity = this.identity;
		if (
			!projectPath ||
			!effectiveProjectKey ||
			!identity ||
			!this.canChangeTarget
		) {
			return false;
		}
		const execute = async (): Promise<boolean> => {
			if (this.deps.beforeCheckout && !(await this.deps.beforeCheckout())) {
				return false;
			}
			if (
				identity !== this.identity ||
				projectPath !== this.activeProjectPath ||
				effectiveProjectKey !== this.effectiveProjectKey ||
				!this.canChangeTarget
			) {
				return false;
			}
			const changed = await mutate();
			if (!changed) return false;
			if (identity !== this.identity) return true;
			const nextBranch = typeof branch === 'string' ? branch : branch();
			this.#updateActiveBranch(nextBranch);
			await this.ensureTargets(true);
			if (identity !== this.identity) return true;
			await this.#applyTarget('checkout', true, nextBranch);
			await this.deps.afterCheckout?.(projectPath);
			return true;
		};
		return this.deps.runCheckoutReconciliation
			? this.deps.runCheckoutReconciliation(projectPath, execute)
			: execute();
	}

	#setContext(projectPath: string | null, effectiveProjectKey: string | null): void {
		if (
			projectPath === this.baseProjectPath &&
			effectiveProjectKey === this.effectiveProjectKey
		) {
			if (this.presentationVisible) void this.activate();
			return;
		}
		this.#rememberTarget();
		this.closeDialogs();
		this.#cancelTargetRequest();
		this.#contextGeneration += 1;
		this.baseProjectPath = projectPath;
		this.effectiveProjectKey = effectiveProjectKey;
		this.targets = [];
		this.#lastTargetFetchKey = null;
		this.#appliedIdentity = null;
		this.lastError = null;
		const remembered = effectiveProjectKey
			? takeMostRecent(this.#targetByProject, effectiveProjectKey)
			: null;
		this.activeTarget = remembered ?? this.fallbackTarget;
		if (this.presentationVisible && projectPath && effectiveProjectKey) {
			void this.activate();
		}
		if (!projectPath || !effectiveProjectKey) {
			void this.#applyTarget('project', true);
		}
	}

	async #reconcileSelectedTarget(): Promise<void> {
		const previousIdentity = this.identity;
		const identityChanged = await this.ensureTargets(true);
		if (identityChanged && previousIdentity !== this.identity) {
			await this.#applyTarget('selection');
		}
	}

	async #applyTarget(
		reason: GitTargetChangeReason,
		force = false,
		branchOverride?: string,
	): Promise<void> {
		const target = this.activeTarget ?? this.fallbackTarget;
		const projectPath = target?.projectPath ?? null;
		const effectiveProjectKey = this.effectiveProjectKey;
		const identity =
			target && effectiveProjectKey
				? gitTargetIdentity(effectiveProjectKey, target)
				: null;
		if (!force && identity === this.#appliedIdentity) return;
		const identityChanged = identity !== this.#appliedIdentity;
		this.#appliedIdentity = identity;
		if (identityChanged) {
			this.branches.resetForProject(
				projectPath,
				branchOverride ?? target?.branch ?? '',
				effectiveProjectKey,
			);
		} else {
			this.branches.setProject(
				projectPath,
				branchOverride ?? target?.branch,
				effectiveProjectKey,
			);
		}
		if (projectPath) void this.branches.fetchRefs(projectPath);
		await this.deps.onTargetChanged(target, identity, reason, identityChanged);
	}

	#rememberTarget(): void {
		const key = this.effectiveProjectKey;
		const target = this.activeTarget;
		if (!key || !target) return;
		storeMostRecent(this.#targetByProject, key, { ...target });
	}

	#updateActiveBranch(branch: string): void {
		if (!this.activeTarget) return;
		this.activeTarget = { ...this.activeTarget, branch };
		this.#rememberTarget();
	}

	#cancelTargetRequest(): void {
		if (this.#requestAbort) this.#lastTargetFetchKey = null;
		this.#requestAbort?.abort();
		this.#requestAbort = null;
		this.#requestGeneration += 1;
		this.isLoadingTargets = false;
	}

	#isCurrentTargetRequest(
		generation: number,
		contextGeneration: number,
		projectKey: string,
		signal: AbortSignal,
	): boolean {
		return (
			!signal.aborted &&
			generation === this.#requestGeneration &&
			contextGeneration === this.#contextGeneration &&
			projectKey === this.effectiveProjectKey &&
			!this.projectIdentityPending &&
			this.presentationVisible
		);
	}
}

function storeMostRecent<V>(entries: Map<string, V>, key: string, value: V): void {
	entries.delete(key);
	entries.set(key, value);
	while (entries.size > TARGET_CACHE_LIMIT) {
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
