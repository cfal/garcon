import { getGitTargetCandidates, type GitRefKind, type GitTargetCandidate } from '$lib/api/git.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { singletonSurfaceId, type PortableSingletonKind } from '$lib/workspace/surface-types.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import type { GitProjectTarget } from '$shared/git-execution';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import {
	GitProjectSelectionController,
	type GitProjectSelectionDeps,
	type GitProjectState,
} from './git-project-selection.svelte.js';
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
export type GitTargetChangeReason =
	'project' | 'selection' | 'checkout' | 'invalidation' | 'session';

export interface GitTargetSessionDeps {
	kind: GitTargetSurfaceKind;
	projectSelection?: GitProjectSelectionDeps;
	createBranchSelector(): GitBranchSelectorState;
	invalidationVersion(executorId: string): number;
	canChangeTarget(): boolean;
	onUnavailable?(): void;
	onProjectSelectionChanged?(): void;
	beforeCheckout?(): boolean | Promise<boolean>;
	runCheckoutReconciliation?<T>(project: GitProjectTarget, execute: () => Promise<T>): Promise<T>;
	afterCheckout?(projectPath: string): void | Promise<void>;
	onTargetChanged(
		target: GitTarget | null,
		identity: string | null,
		reason: GitTargetChangeReason,
		identityChanged: boolean,
	): void | Promise<void>;
}

export class GitTargetSessionController implements PortableSingletonController {
	readonly projectSelection: GitProjectSelectionController;
	readonly surfaceId: string;
	readonly branches: GitBranchSelectorState;
	presentationVisible = $state(false);
	projectIdentityPending = $state(false);
	branchChangePending = $state(false);
	targets = $state<GitTargetCandidate[]>([]);
	activeTarget = $state<GitTarget | null>(null);
	isLoadingTargets = $state(false);
	lastError = $state<string | null>(null);
	baseProjectPath = $state<string | null>(null);
	executorId = $state('local');
	effectiveProjectKey = $state<string | null>(null);

	#targetByProject = new Map<string, GitTarget>();
	#executorContextKey: string | null = null;
	#sessionRefreshPending = false;
	#requestAbort: AbortController | null = null;
	#requestGeneration = 0;
	#contextGeneration = 0;
	#targetApplicationGeneration = 0;
	#activation: {
		contextGeneration: number;
		applicationGeneration: number;
		promise: Promise<void>;
	} | null = null;
	#lastTargetFetchKey: string | null = null;
	#appliedIdentity = $state<string | null>(null);
	#handledInvalidationVersions = new Map<string, number>();
	#pendingInvalidationVersions = new Map<string, number>();
	#deferredBranchInvalidationVersions = new Map<string, number>();

	constructor(private readonly deps: GitTargetSessionDeps) {
		this.surfaceId = singletonSurfaceId(deps.kind);
		this.branches = deps.createBranchSelector();
		this.projectSelection = new GitProjectSelectionController((project) => {
			this.#setProjectState(project);
			this.deps.onProjectSelectionChanged?.();
		}, deps.projectSelection);
	}

	get fallbackTarget(): GitTarget | null {
		const path = this.baseProjectPath;
		return path
			? {
					executorId: this.executorId,
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

	get requestTarget(): GitProjectTarget | null {
		const projectPath = this.activeProjectPath;
		return projectPath ? { executorId: this.executorId, projectPath } : null;
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
		return !this.branchChangePending && this.#targetChangeAllowed();
	}

	get canChooseProject(): boolean {
		return !this.branchChangePending && this.deps.canChangeTarget();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.projectSelection.setProjectState(projectState);
	}

	async selectExecutor(executorId: string): Promise<void> {
		if (!this.canChooseProject) return;
		await this.projectSelection.selectExecutor(
			executorId,
			this.activeProjectPath ?? this.projectSelection.projectPath,
		);
	}

	selectProject(project: GitProjectTarget): boolean {
		if (!this.canChooseProject) return false;
		this.projectSelection.selectResolvedProject(project);
		return true;
	}

	goToChatProject(): void {
		if (!this.canChooseProject || !this.projectSelection.canGoToChatProject) return;
		this.#targetByProject.clear();
		this.activeTarget = null;
		this.#appliedIdentity = null;
		this.#lastTargetFetchKey = null;
		this.projectSelection.goToChatProject();
	}

	#setProjectState(projectState: GitProjectState): void {
		if (projectState.kind === 'unchecked' || projectState.kind === 'resolving') {
			if (
				this.projectSelection.followingChat &&
				projectState.context.executorId === this.executorId &&
				projectState.context.projectPath === this.baseProjectPath
			) {
				this.projectIdentityPending = true;
			} else this.#suspendContext();
			return;
		}
		if (projectState.kind === 'unavailable' || projectState.kind === 'request-failed') {
			this.#executorContextKey = null;
			this.#suspendContext();
			return;
		}
		this.projectIdentityPending = false;
		if (projectState.kind === 'absent') {
			this.#setContext(null, null, 'local', null);
			return;
		}
		this.#setContext(
			projectState.project.projectPath,
			projectState.project.effectiveProjectKey,
			effectiveExecutorId(projectState.project.executorId),
			projectState.project.executorContextKey ?? null,
		);
	}

	setPresentationVisible(visible: boolean): void {
		if (this.presentationVisible === visible) return;
		this.presentationVisible = visible;
		this.projectSelection.setPresentationVisible(visible);
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
		const applicationGeneration = this.#targetApplicationGeneration;
		if (
			this.#activation?.contextGeneration === contextGeneration &&
			this.#activation.applicationGeneration === applicationGeneration
		) {
			return this.#activation.promise;
		}
		if (this.effectiveProjectKey && (this.#sessionRefreshPending || this.#appliedIdentity === null)) {
			const key = JSON.stringify([this.executorId, this.effectiveProjectKey]);
			// A fresh activation snapshot includes prior executor invalidations.
			storeMostRecent(
				this.#handledInvalidationVersions,
				key,
				Math.max(
					this.#handledInvalidationVersions.get(key) ?? 0,
					this.deps.invalidationVersion(this.executorId),
				),
			);
		}
		const activation = (async () => {
			await this.ensureTargets();
			if (
				!this.presentationVisible ||
				this.projectIdentityPending ||
				contextGeneration !== this.#contextGeneration ||
				applicationGeneration !== this.#targetApplicationGeneration
			) {
				return;
			}
			const refreshSession = this.#sessionRefreshPending;
			this.#sessionRefreshPending = false;
			await this.#applyTarget(refreshSession ? 'session' : 'project', refreshSession);
		})();
		const tracked = activation.finally(() => {
			if (this.#activation?.promise === tracked) this.#activation = null;
		});
		this.#activation = { contextGeneration, applicationGeneration, promise: tracked };
		return tracked;
	}

	async selectTarget(candidate: GitTargetCandidate): Promise<boolean> {
		if (!this.canChooseProject) return false;
		const executorId = this.projectSelection.executorId;
		this.projectSelection.selectResolvedProject({ executorId, projectPath: candidate.projectPath });
		this.activeTarget = gitTargetFromCandidate(candidate, executorId);
		this.targets = [
			candidate,
			...this.targets.filter((target) => target.worktreePath !== candidate.worktreePath),
		];
		this.#rememberTarget();
		await this.activate();
		return true;
	}

	async switchBranch(branch: string, refKind: GitRefKind | undefined): Promise<boolean> {
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
		const projectPath = this.activeProjectPath;
		const projectKey = this.effectiveProjectKey;
		const executorId = this.executorId;
		if (this.projectIdentityPending || !this.presentationVisible || !projectPath || !projectKey) {
			return false;
		}
		const targetFetchKey = JSON.stringify([executorId, projectKey, projectPath]);
		if (!force && this.#lastTargetFetchKey === targetFetchKey) return false;
		this.#requestAbort?.abort();
		const controller = new AbortController();
		this.#requestAbort = controller;
		const generation = ++this.#requestGeneration;
		const contextGeneration = this.#contextGeneration;
		const previousIdentity = this.identity;
		this.#lastTargetFetchKey = targetFetchKey;
		this.isLoadingTargets = true;
		try {
			const result = await getGitTargetCandidates(
				{ executorId, projectPath },
				{
					signal: controller.signal,
				},
			);
			if (
				!this.#isCurrentTargetRequest(generation, contextGeneration, projectKey, controller.signal)
			) {
				return false;
			}
			this.targets = result.targets;
			const selected = this.activeTarget
				? result.targets.find(
						(candidate) =>
							candidate.worktreePath === this.activeTarget?.worktreePath && !candidate.isMissing,
					)
				: null;
			const current =
				result.targets.find((candidate) => candidate.isCurrent && !candidate.isMissing) ??
				result.targets.find((candidate) => !candidate.isMissing) ??
				null;
			this.activeTarget = selected
				? gitTargetFromCandidate(selected, executorId)
				: current
					? gitTargetFromCandidate(current, executorId)
					: this.fallbackTarget;
			this.#rememberTarget();
			this.lastError = null;
			return previousIdentity !== this.identity;
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.#isCurrentTargetRequest(generation, contextGeneration, projectKey, controller.signal)
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
			if (this.#ownsTargetRequest(generation, contextGeneration, projectKey, controller.signal)) {
				this.isLoadingTargets = false;
				this.#requestAbort = null;
				if (this.projectIdentityPending) this.#lastTargetFetchKey = null;
			}
		}
	}

	async refreshForInvalidation(effectiveProjectKey: string, version: number): Promise<boolean> {
		const key = JSON.stringify([this.executorId, effectiveProjectKey]);
		const handled = this.#handledInvalidationVersions.get(key) ?? 0;
		const pending = this.#pendingInvalidationVersions.get(key) ?? 0;
		const deferred = this.#deferredBranchInvalidationVersions.get(key) ?? 0;
		if (
			!this.presentationVisible ||
			effectiveProjectKey !== this.effectiveProjectKey ||
			version <= 0 ||
			version <= Math.max(handled, pending, deferred)
		) {
			return false;
		}
		if (this.branchChangePending) {
			storeMostRecent(this.#deferredBranchInvalidationVersions, key, version);
			return false;
		}
		storeMostRecent(this.#pendingInvalidationVersions, key, version);
		const applicationGeneration = this.#targetApplicationGeneration;
		const contextGeneration = this.#contextGeneration;
		try {
			await this.ensureTargets(true);
			if (
				!this.presentationVisible ||
				this.projectIdentityPending ||
				effectiveProjectKey !== this.effectiveProjectKey ||
				contextGeneration !== this.#contextGeneration ||
				applicationGeneration !== this.#targetApplicationGeneration ||
				this.#pendingInvalidationVersions.get(key) !== version
			) {
				return false;
			}
			await this.#applyTarget('invalidation', true);
			storeMostRecent(this.#handledInvalidationVersions, key, version);
			return true;
		} finally {
			if (this.#pendingInvalidationVersions.get(key) === version) {
				this.#pendingInvalidationVersions.delete(key);
			}
		}
	}

	async refreshTargets(reason: GitTargetChangeReason = 'project'): Promise<void> {
		const applicationGeneration = this.#targetApplicationGeneration;
		const contextGeneration = this.#contextGeneration;
		await this.ensureTargets(true);
		if (
			this.presentationVisible &&
			!this.projectIdentityPending &&
			contextGeneration === this.#contextGeneration &&
			applicationGeneration === this.#targetApplicationGeneration
		) {
			await this.#applyTarget(reason, true);
		}
	}

	closeDialogs(): void {
		this.projectSelection.showFolderDialog = false;
		this.branches.closeBranchDropdown();
		this.branches.closeNewBranchDialog();
	}

	dismissError(): void {
		this.lastError = null;
	}

	pruneExecutors(executorIds: ReadonlySet<string>): void {
		for (const [key, target] of this.#targetByProject) {
			if (!executorIds.has(target.executorId)) this.#targetByProject.delete(key);
		}
		if (!executorIds.has(this.executorId)) this.#suspendContext();
	}

	dispose(): void {
		this.presentationVisible = false;
		this.projectSelection.dispose();
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
		this.#deferredBranchInvalidationVersions.clear();
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
		const executorId = this.executorId;
		const contextGeneration = this.#contextGeneration;
		if (!projectPath || !effectiveProjectKey || !identity || !this.canChangeTarget) {
			return false;
		}
		let checkoutVersion = 0;
		let changed = false;
		let reconciled = false;
		this.branchChangePending = true;
		const execute = async (): Promise<boolean> => {
			if (this.deps.beforeCheckout && !(await this.deps.beforeCheckout())) {
				return false;
			}
			if (
				identity !== this.identity ||
				contextGeneration !== this.#contextGeneration ||
				projectPath !== this.activeProjectPath ||
				effectiveProjectKey !== this.effectiveProjectKey ||
				!this.#targetChangeAllowed()
			) {
				return false;
			}
			changed = await mutate();
			checkoutVersion = this.deps.invalidationVersion(executorId);
			if (!changed) return false;
			if (identity !== this.identity || contextGeneration !== this.#contextGeneration) return true;
			const nextBranch = typeof branch === 'string' ? branch : branch();
			this.#updateActiveBranch(nextBranch);
			await this.ensureTargets(true);
			if (identity !== this.identity || contextGeneration !== this.#contextGeneration) return true;
			reconciled = await this.#applyTarget('checkout', true, nextBranch);
			if (reconciled) await this.deps.afterCheckout?.(projectPath);
			return true;
		};
		try {
			return await (this.deps.runCheckoutReconciliation
				? this.deps.runCheckoutReconciliation({ executorId, projectPath }, execute)
				: execute());
		} finally {
			if (contextGeneration === this.#contextGeneration) {
				this.branchChangePending = false;
				await this.#settleBranchInvalidation(
					effectiveProjectKey,
					checkoutVersion,
					changed,
					reconciled,
				);
			}
		}
	}

	async #settleBranchInvalidation(
		effectiveProjectKey: string,
		checkoutVersion: number,
		changed: boolean,
		reconciled: boolean,
	): Promise<void> {
		const key = JSON.stringify([this.executorId, effectiveProjectKey]);
		const deferred = this.#deferredBranchInvalidationVersions.get(key) ?? 0;
		this.#deferredBranchInvalidationVersions.delete(key);
		if (effectiveProjectKey !== this.effectiveProjectKey) return;
		const currentVersion = this.deps.invalidationVersion(this.executorId);
		if (reconciled && currentVersion === checkoutVersion) {
			storeMostRecent(this.#handledInvalidationVersions, key, currentVersion);
			return;
		}
		if (!changed && deferred <= 0) return;
		const recoveryVersion = Math.max(deferred, currentVersion);
		if (recoveryVersion <= 0) return;
		try {
			await this.refreshForInvalidation(effectiveProjectKey, recoveryVersion);
		} catch (error) {
			this.lastError = `Failed to refresh Git target after branch change: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	#targetChangeAllowed(): boolean {
		return (
			this.projectSelection.projectState.kind === 'available' &&
			this.activeProjectPath !== null &&
			!this.projectIdentityPending &&
			this.identity === this.#appliedIdentity &&
			this.deps.canChangeTarget()
		);
	}

	#suspendContext(): void {
		if (!this.#sessionRefreshPending) {
			this.#contextGeneration += 1;
			this.#targetApplicationGeneration += 1;
			this.#sessionRefreshPending = true;
			this.branchChangePending = false;
			this.deps.onUnavailable?.();
		}
		this.projectIdentityPending = true;
		this.closeDialogs();
		this.#cancelTargetRequest();
		this.#lastTargetFetchKey = null;
	}

	#setContext(
		projectPath: string | null,
		effectiveProjectKey: string | null,
		executorId: string,
		executorContextKey: string | null,
	): void {
		if (
			projectPath === this.baseProjectPath &&
			effectiveProjectKey === this.effectiveProjectKey &&
			executorId === this.executorId
		) {
			if (executorContextKey !== this.#executorContextKey) {
				this.#executorContextKey = executorContextKey;
				this.#cancelTargetRequest();
				this.#contextGeneration += 1;
				this.#sessionRefreshPending = true;
				this.#lastTargetFetchKey = null;
				this.branchChangePending = false;
				this.closeDialogs();
				this.deps.onUnavailable?.();
				if (this.presentationVisible) void this.activate();
				return;
			}
			if (this.presentationVisible) void this.activate();
			return;
		}
		this.#rememberTarget();
		this.closeDialogs();
		this.#cancelTargetRequest();
		this.#contextGeneration += 1;
		this.branchChangePending = false;
		this.executorId = executorId;
		this.#executorContextKey = executorContextKey;
		this.#sessionRefreshPending = false;
		this.baseProjectPath = projectPath;
		this.effectiveProjectKey = effectiveProjectKey;
		this.targets = [];
		this.#lastTargetFetchKey = null;
		this.#appliedIdentity = null;
		this.lastError = null;
		const remembered = effectiveProjectKey
			? takeMostRecent(this.#targetByProject, JSON.stringify([executorId, effectiveProjectKey]))
			: null;
		this.activeTarget = remembered ?? this.fallbackTarget;
		if (this.presentationVisible && projectPath && effectiveProjectKey) {
			void this.activate();
		}
		if (!projectPath || !effectiveProjectKey) {
			void this.#applyTarget('project', true);
		}
	}

	async #applyTarget(
		reason: GitTargetChangeReason,
		force = false,
		branchOverride?: string,
	): Promise<boolean> {
		if (this.projectIdentityPending) return false;
		const target = this.activeTarget ?? this.fallbackTarget;
		const projectPath = target?.projectPath ?? null;
		const effectiveProjectKey = this.effectiveProjectKey;
		const identity =
			target && effectiveProjectKey ? gitTargetIdentity(effectiveProjectKey, target) : null;
		if (!force && identity === this.#appliedIdentity) return false;
		const identityChanged = identity !== this.#appliedIdentity;
		this.#appliedIdentity = identity;
		if (identityChanged) {
			this.branches.resetForProject(
				projectPath,
				branchOverride ?? target?.branch ?? '',
				effectiveProjectKey,
				this.executorId,
			);
		} else {
			this.branches.setProject(
				projectPath,
				branchOverride ?? target?.branch,
				effectiveProjectKey,
				this.executorId,
			);
		}
		await this.deps.onTargetChanged(target, identity, reason, identityChanged);
		return true;
	}

	#rememberTarget(): void {
		const key = this.effectiveProjectKey;
		const target = this.activeTarget;
		if (!key || !target) return;
		storeMostRecent(this.#targetByProject, JSON.stringify([target.executorId, key]), { ...target });
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
			this.#ownsTargetRequest(generation, contextGeneration, projectKey, signal) &&
			!this.projectIdentityPending &&
			this.presentationVisible
		);
	}

	#ownsTargetRequest(
		generation: number,
		contextGeneration: number,
		projectKey: string,
		signal: AbortSignal,
	): boolean {
		return (
			!signal.aborted &&
			generation === this.#requestGeneration &&
			contextGeneration === this.#contextGeneration &&
			projectKey === this.effectiveProjectKey
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
