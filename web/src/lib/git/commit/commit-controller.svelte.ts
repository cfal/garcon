import {
	generateCommitMessage as generateCommitMessageApi,
	getGitWorkbenchSnapshot,
	gitCommitIndex,
	gitStagePaths,
	type GitTreeNode,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import {
	GitTargetSessionController,
	type GitTargetChangeReason,
} from '$lib/git/targets/git-target-session.svelte.js';
import {
	commitStatsForNode,
	findCommitTreeNode,
	flattenCommitFileNodes,
	reconcileCommitTreeAfterStage,
} from './commit-tree-reconciliation.js';

import { CommitDraftSnapshotCache } from './commit-draft-snapshot-cache.js';
import {
	CommitStageQueue,
	type QuickCommitPathIntent,
	type QuickCommitStageBatch,
} from './commit-stage-queue.js';

export interface CommitControllerDeps extends GitSurfaceControllerDeps {
	refreshSummary?: () => Promise<void>;
	markProjectChanged?: (
		executorId: string,
		effectiveProjectKey: string,
		projectPath: string,
	) => void;
	runMutation?: <T>(request: {
		executorId: string;
		effectiveProjectKey: string;
		projectPath: string;
		execute: () => Promise<T>;
	}) => Promise<T>;
}

type QueueAction = 'generate' | 'commit' | null;
type QuickCommitTreeLoadState = 'idle' | 'initial-loading' | 'refreshing';

export class CommitController implements PortableSingletonController {
	readonly target: GitTargetSessionController;
	tree = $state.raw<GitTreeNode[]>([]);
	intents = $state.raw<Record<string, QuickCommitPathIntent>>({});
	readonly fileNodes = $derived.by(() => flattenCommitFileNodes(this.tree));
	#message = $state('');
	#messageRevision = 0;

	get message(): string {
		return this.#message;
	}
	set message(value: string) {
		this.#message = value;
		this.#messageRevision++;
	}
	treeLoadState = $state<QuickCommitTreeLoadState>('idle');
	isProcessingQueue = $state(false);
	isGeneratingMessage = $state(false);
	isCommitting = $state(false);
	pendingMutationCount = $state(0);
	preparingAction = $state<QueueAction>(null);
	lastError = $state<string | null>(null);
	isPresentationVisible = $state(false);

	private readonly queue = new CommitStageQueue();
	private shouldRefreshAfterDrain = false;
	private readonly snapshots = new CommitDraftSnapshotCache();
	private activationPromise: Promise<void> | null = null;
	private disposed = false;
	private contextGeneration = 0;
	private treeRequestGeneration = 0;
	private sessionGeneration = 0;
	private treeValidated = $state(false);
	private loadedTargetIdentity: string | null = null;
	private selectedChangeStats = $derived.by(() => {
		let additions = 0;
		let deletions = 0;
		for (const node of this.fileNodes) {
			const intent = this.intentFor(node.path);
			if (!intent?.desiredSelected) continue;
			const stats = commitStatsForNode(node);
			additions += stats.additions;
			deletions += stats.deletions;
		}
		return { additions, deletions };
	});

	constructor(private readonly deps: CommitControllerDeps) {
		this.target = new GitTargetSessionController({
			kind: 'commit',
			projectSelection: deps.projectSelection,
			createBranchSelector: deps.createGitBranchSelector,
			invalidationVersion: deps.invalidationVersion,
			onUnavailable: () => {
				this.treeRequestGeneration++;
				this.sessionGeneration++;
				this.treeValidated = false;
				this.isGeneratingMessage = false;
				this.preparingAction = null;
			},
			canChangeTarget: () =>
				this.canClose && deps.gitMutations.pendingCount(singletonSurfaceId('commit')) === 0,
			onTargetChanged: (_target, identity, reason, identityChanged) =>
				this.setTargetIdentity(identity, reason, identityChanged),
		});
	}

	get effectiveProjectKey(): string | null {
		return this.target.effectiveProjectKey;
	}

	get projectPath(): string | null {
		return this.target.activeProjectPath;
	}

	get projectIdentityPending(): boolean {
		return (
			this.target.projectIdentityPending || this.target.identity !== this.target.appliedIdentity
		);
	}

	get isLoadingTree(): boolean {
		return this.treeLoadState === 'initial-loading';
	}

	get isRepositoryReady(): boolean {
		return !this.projectIdentityPending && this.treeValidated;
	}

	get isRefreshingTree(): boolean {
		return this.treeLoadState === 'refreshing';
	}

	hasPendingStageOperations = $derived.by<boolean>(() => {
		return Object.values(this.intents).some(
			(item) => item.isRunning || (!item.error && item.desiredSelected !== item.actualSelected),
		);
	});

	hasErrors = $derived.by<boolean>(() => {
		return Object.values(this.intents).some((item) => Boolean(item.error));
	});

	treeErrorMessage = $derived.by<string | null>(() => {
		const fileErrors = Object.values(this.intents)
			.filter((item) => Boolean(item.error))
			.map((item) => item.error as string);
		const firstFileError = fileErrors[0] ?? null;

		if (this.lastError && !firstFileError) return this.lastError;
		if (!this.lastError && !firstFileError) return null;
		if (this.lastError && firstFileError) {
			return m.git_quick_commit_error_with_detail({
				summary: this.lastError,
				detail: this.fileErrorSummary(fileErrors),
			});
		}
		return this.fileErrorSummary(fileErrors);
	});

	desiredSelectedFiles = $derived.by<string[]>(() => {
		return Object.values(this.intents)
			.filter((item) => item.desiredSelected)
			.map((item) => item.path);
	});

	actualSelectedFiles = $derived.by<string[]>(() => {
		return Object.values(this.intents)
			.filter((item) => item.actualSelected)
			.map((item) => item.path);
	});

	selectedFileCount = $derived.by<number>(() => {
		return this.desiredSelectedFiles.length;
	});

	get totalAdditions(): number {
		return this.selectedChangeStats.additions;
	}

	get totalDeletions(): number {
		return this.selectedChangeStats.deletions;
	}

	canCommit = $derived.by<boolean>(() => {
		return (
			this.isRepositoryReady &&
			this.message.trim().length > 0 &&
			this.desiredSelectedFiles.length > 0 &&
			!this.isCommitting &&
			!this.hasErrors
		);
	});

	get retainedDraftCount(): number {
		return Number(Boolean(this.message.trim())) + this.snapshots.countDrafts(this.target.identity);
	}

	get canClose(): boolean {
		return (
			this.pendingMutationCount === 0 &&
			!this.isCommitting &&
			!this.isGeneratingMessage &&
			!this.isProcessingQueue
		);
	}

	async setProjectState(projectState: WorkspaceProjectState): Promise<void> {
		this.target.setProjectState(projectState);
		if (this.isPresentationVisible) await this.target.activate();
	}

	async setPresentationVisible(visible: boolean): Promise<void> {
		if (this.disposed || this.isPresentationVisible === visible) return;
		this.isPresentationVisible = visible;
		const resumeExistingTarget =
			visible &&
			Boolean(this.target.identity) &&
			this.target.appliedIdentity === this.target.identity;
		if (visible && this.projectPath && this.tree.length === 0) {
			this.treeLoadState = 'initial-loading';
		}
		this.target.setPresentationVisible(visible);
		if (!visible || this.target.projectIdentityPending) return;
		await this.target.activate();
		if (resumeExistingTarget && this.target.appliedIdentity === this.target.identity) {
			await this.activate();
		}
	}

	discardDrafts(): void {
		this.message = '';
		this.snapshots.discardDrafts();
	}

	resetAfterClose(): void {
		this.snapshots.clear();
		this.isPresentationVisible = false;
		this.activationPromise = null;
		this.resetForTargetIdentity(this.target.identity, false);
	}

	dispose(): void {
		this.disposed = true;
		this.saveCurrentSnapshot();
		this.queue.reset();
		this.isPresentationVisible = false;
		this.target.dispose();
	}

	intentFor(path: string): QuickCommitPathIntent | null {
		return this.intents[path] ?? null;
	}

	togglePath(path: string, desiredSelected: boolean): void {
		if (!this.isRepositoryReady) return;
		this.enqueueStageIntents([path], desiredSelected);
	}

	toggleDirectory(path: string, desiredSelected: boolean): void {
		if (!this.isRepositoryReady) return;
		const node = findCommitTreeNode(this.tree, path);
		if (!node) return;
		this.enqueueStageIntents(
			flattenCommitFileNodes([node]).map((file) => file.path),
			desiredSelected,
		);
	}

	includeUnstaged(path: string): void {
		if (!this.isRepositoryReady) return;
		this.enqueueStageIntents([path], true, true);
	}

	operationLabelForPath(path: string): string {
		const item = this.intents[path];
		const mode = item?.runningMode ?? (item?.desiredSelected ? 'unstage' : 'stage');
		return mode === 'stage'
			? m.git_quick_commit_stage_path({ path })
			: m.git_quick_commit_unstage_path({ path });
	}

	async refreshTree(): Promise<void> {
		if (this.projectIdentityPending || !this.projectPath) return;
		await Promise.all([
			this.tree.length === 0 ? this.loadInitialTree() : this.refreshTreeSnapshot(),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
	}

	async generateMessage(): Promise<void> {
		const project = this.target.requestTarget;
		const projectPath = project?.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const targetIdentity = this.target.identity;
		const generation = this.contextGeneration;
		const sessionGeneration = this.sessionGeneration;
		if (
			!this.isRepositoryReady ||
			!project ||
			!projectPath ||
			!effectiveProjectKey ||
			!targetIdentity ||
			this.isGeneratingMessage
		)
			return;
		const isCurrent = () =>
			this.isCurrentTarget(targetIdentity, generation) &&
			sessionGeneration === this.sessionGeneration;
		const messageRevision = this.#messageRevision;
		this.preparingAction = 'generate';
		const queueReady = await this.waitForQueue();
		if (!isCurrent() || !this.isRepositoryReady) {
			if (isCurrent()) this.preparingAction = null;
			return;
		}
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = m.git_quick_commit_resolve_errors_before_generate();
			return;
		}

		const files = this.actualSelectedFiles;
		if (files.length === 0) {
			this.lastError = m.git_quick_commit_no_staged_files_for_message();
			return;
		}

		this.isGeneratingMessage = true;
		try {
			const data = await generateCommitMessageApi(project, files);
			if (!isCurrent() || !this.isRepositoryReady) {
				return;
			}
			if (!data.message) {
				this.lastError = data.error ?? m.commit_surface_generate_failed();
				return;
			}
			if (messageRevision !== this.#messageRevision) return;
			this.message = data.message;
			this.lastError = null;
		} catch (error) {
			if (isCurrent()) {
				this.lastError = this.commitMessageGenerationErrorMessage(error);
			}
		} finally {
			if (isCurrent()) this.isGeneratingMessage = false;
		}
	}

	async commit(): Promise<boolean> {
		const project = this.target.requestTarget;
		const projectPath = project?.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const targetIdentity = this.target.identity;
		const message = this.message.trim();
		const messageRevision = this.#messageRevision;
		const generation = this.contextGeneration;
		const sessionGeneration = this.sessionGeneration;
		if (
			!this.isRepositoryReady ||
			!project ||
			!projectPath ||
			!effectiveProjectKey ||
			!targetIdentity ||
			this.isCommitting ||
			!message
		)
			return false;
		this.preparingAction = 'commit';
		const queueReady = await this.waitForQueue();
		if (
			!this.isCurrentTarget(targetIdentity, generation) ||
			!this.isRepositoryReady ||
			sessionGeneration !== this.sessionGeneration
		) {
			if (generation === this.contextGeneration && sessionGeneration === this.sessionGeneration)
				this.preparingAction = null;
			return false;
		}
		this.preparingAction = null;
		if (!queueReady) {
			this.lastError = m.git_quick_commit_resolve_errors_before_commit();
			return false;
		}
		if (this.actualSelectedFiles.length === 0) {
			this.lastError = m.git_quick_commit_no_staged_files_to_commit();
			return false;
		}

		this.isCommitting = true;
		this.pendingMutationCount += 1;
		try {
			const execute = () => gitCommitIndex(project, message);
			const result = this.deps.runMutation
				? await this.deps.runMutation({
						executorId: project.executorId,
						effectiveProjectKey,
						projectPath,
						execute,
					})
				: await execute();
			if (!result.success) {
				if (this.isCurrentTarget(targetIdentity, generation)) {
					this.lastError = result.error ?? m.commit_surface_commit_failed();
					await this.refreshAfterMutation();
				}
				return false;
			}
			if (this.isCurrentTarget(targetIdentity, generation)) {
				if (messageRevision === this.#messageRevision) this.message = '';
				this.lastError = null;
			}
			if (!this.deps.runMutation) {
				this.deps.markProjectChanged?.(project.executorId, effectiveProjectKey, projectPath);
			}
			if (this.isCurrentTarget(targetIdentity, generation)) {
				try {
					await this.refreshAfterMutation();
				} catch (error) {
					if (this.isCurrentTarget(targetIdentity, generation)) {
						this.lastError = m.commit_surface_refresh_failed_detail({
							detail: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			return true;
		} catch (error) {
			if (this.isCurrentTarget(targetIdentity, generation)) {
				try {
					await this.refreshAfterMutation();
				} catch {
					// The mutation failure remains authoritative if reconciliation also fails.
				}
				if (this.isCurrentTarget(targetIdentity, generation)) {
					this.lastError = m.commit_surface_commit_failed_detail({
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return false;
		} finally {
			this.pendingMutationCount -= 1;
			if (this.isCurrentTarget(targetIdentity, generation)) this.isCommitting = false;
		}
	}

	async waitForQueue(): Promise<boolean> {
		await this.queue.settled;
		return !this.hasPendingStageOperations && !this.hasErrors;
	}

	private async drainQueue(): Promise<void> {
		if (this.isProcessingQueue || !this.projectPath) return;
		const generation = this.contextGeneration;
		this.isProcessingQueue = true;
		try {
			while (generation === this.contextGeneration && this.queue.size > 0) {
				const batch = this.queue.takeBatch(this.intents);
				if (!batch) break;
				await this.applyStageBatch(batch);
			}
		} finally {
			if (generation === this.contextGeneration) {
				this.isProcessingQueue = false;
				if (this.shouldRefreshAfterDrain) {
					this.shouldRefreshAfterDrain = false;
					this.queue.finish(this.hasPendingStageOperations);
					this.startRefreshAfterMutation();
				} else {
					this.queue.finish(this.hasPendingStageOperations);
				}
			}
		}
	}

	private async applyStageBatch(batch: QuickCommitStageBatch): Promise<void> {
		const project = this.target.requestTarget;
		const projectPath = project?.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const targetIdentity = this.target.identity;
		const generation = this.contextGeneration;
		if (!project || !projectPath || !effectiveProjectKey || !targetIdentity) return;
		this.patchIntents(batch.paths, () => ({
			isRunning: true,
			runningMode: batch.mode,
			error: null,
		}));
		this.pendingMutationCount += 1;
		try {
			if (!this.isRepositoryReady)
				throw new Error('Executor is unavailable. Inspect the repository before staging again.');
			const execute = () => gitStagePaths(project, batch.paths, batch.mode);
			const result = this.deps.runMutation
				? await this.deps.runMutation({
						executorId: project.executorId,
						effectiveProjectKey,
						projectPath,
						execute,
					})
				: await execute();
			if (!result.success) {
				throw new Error(result.error ?? m.git_quick_commit_stage_operation_failed());
			}
			if (!this.isCurrentTarget(targetIdentity, generation)) {
				if (!this.deps.runMutation) {
					this.deps.markProjectChanged?.(project.executorId, effectiveProjectKey, projectPath);
				}
				return;
			}
			this.reconcilePathsAfterStage(batch.paths, batch.mode === 'stage');
			this.patchIntents(batch.paths, () => ({
				actualSelected: batch.mode === 'stage',
				error: null,
			}));
			this.shouldRefreshAfterDrain = true;
			if (!this.deps.runMutation) {
				this.deps.markProjectChanged?.(project.executorId, effectiveProjectKey, projectPath);
			}
		} catch (error) {
			if (!this.isCurrentTarget(targetIdentity, generation)) return;
			const message = error instanceof Error ? error.message : String(error);
			const uncertain =
				error instanceof ApiError && error.errorCode === 'GIT_MUTATION_OUTCOME_UNKNOWN';
			this.patchIntents(this.queue.removeFailed(batch, uncertain), (current) => ({
				desiredSelected: uncertain ? current.desiredSelected : current.actualSelected,
				error: message,
			}));
			this.shouldRefreshAfterDrain = true;
		} finally {
			this.pendingMutationCount -= 1;
			if (this.isCurrentTarget(targetIdentity, generation)) {
				this.patchIntents(batch.paths, () => ({ isRunning: false, runningMode: null }));
			}
		}
	}

	private async loadInitialTree(): Promise<void> {
		const generation = this.contextGeneration;
		this.treeLoadState = 'initial-loading';
		try {
			await this.loadTreeSnapshot({ preserveDesired: false, clearOnNotReady: true });
		} finally {
			if (generation === this.contextGeneration) this.treeLoadState = 'idle';
		}
	}

	private async refreshTreeSnapshot(): Promise<void> {
		if (!this.projectPath) return;
		const generation = this.contextGeneration;
		this.treeLoadState = 'refreshing';
		try {
			await this.loadTreeSnapshot({ preserveDesired: true, clearOnNotReady: false });
		} finally {
			if (generation === this.contextGeneration) this.treeLoadState = 'idle';
		}
	}

	private async loadTreeSnapshot(options: {
		preserveDesired: boolean;
		clearOnNotReady: boolean;
	}): Promise<void> {
		const project = this.target.requestTarget;
		const projectPath = project?.projectPath;
		const effectiveProjectKey = this.effectiveProjectKey;
		const targetIdentity = this.target.identity;
		const generation = this.contextGeneration;
		const requestGeneration = ++this.treeRequestGeneration;
		if (
			this.projectIdentityPending ||
			!project ||
			!projectPath ||
			!effectiveProjectKey ||
			!targetIdentity
		)
			return;
		try {
			const snapshot = await getGitWorkbenchSnapshot(project, 'unstaged', 0, {
				bodyCandidateCount: 1,
			});
			if (
				!this.isCurrentTarget(targetIdentity, generation) ||
				requestGeneration !== this.treeRequestGeneration ||
				this.projectIdentityPending
			) {
				return;
			}
			if (snapshot.status !== 'ready') {
				this.treeValidated = false;
				if (options.clearOnNotReady) {
					this.tree = [];
					this.intents = {};
				}
				this.lastError = snapshot.message;
				return;
			}
			this.applyTree(snapshot.tree.root, options.preserveDesired);
			this.treeValidated = true;
			this.lastError = null;
		} catch (error) {
			if (
				this.isCurrentTarget(targetIdentity, generation) &&
				requestGeneration === this.treeRequestGeneration &&
				!this.projectIdentityPending
			) {
				this.treeValidated = false;
				this.lastError = m.commit_surface_load_failed_detail({
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private applyTree(tree: GitTreeNode[], preserveDesired: boolean): void {
		const previous = this.intents;
		const nextIntents: Record<string, QuickCommitPathIntent> = {};
		for (const node of flattenCommitFileNodes(tree)) {
			const actualSelected = Boolean(node.staged);
			const previousIntent = previous[node.path];
			const hasPendingOperation = Boolean(previousIntent?.isRunning) || this.queue.has(node.path);
			const shouldPreserveDesired =
				preserveDesired &&
				Boolean(previousIntent) &&
				(Boolean(previousIntent?.error) || hasPendingOperation);
			nextIntents[node.path] = {
				path: node.path,
				actualSelected,
				desiredSelected: shouldPreserveDesired
					? (previousIntent?.desiredSelected ?? actualSelected)
					: actualSelected,
				isRunning: previousIntent?.isRunning ?? false,
				runningMode: previousIntent?.runningMode ?? null,
				error: previousIntent?.error ?? null,
			};
		}
		this.tree = tree;
		this.intents = nextIntents;
	}

	private async refreshAfterMutation(): Promise<void> {
		const results = await Promise.allSettled([
			this.refreshTreeSnapshot(),
			this.deps.refreshSummary?.() ?? Promise.resolve(),
		]);
		const failure = results.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (failure) throw failure.reason;
	}

	private startRefreshAfterMutation(): void {
		const generation = this.contextGeneration;
		void this.refreshAfterMutation().catch((error) => {
			if (generation !== this.contextGeneration) return;
			this.lastError = m.commit_surface_refresh_failed_detail({
				detail: error instanceof Error ? error.message : String(error),
			});
		});
	}

	private fileErrorSummary(errors: string[]): string {
		const first = errors[0] ?? '';
		if (errors.length <= 1) return first;
		return m.git_quick_commit_file_errors({
			count: errors.length,
			message: first,
		});
	}

	private patchIntents(
		paths: Iterable<string>,
		patch: (intent: QuickCommitPathIntent) => Partial<QuickCommitPathIntent> | null,
	): void {
		const previous = this.intents;
		let next: Record<string, QuickCommitPathIntent> | undefined;
		for (const path of paths) {
			const intent = previous[path];
			if (!intent) continue;
			const update = patch(intent);
			if (update) (next ??= { ...previous })[path] = { ...intent, ...update };
		}
		if (next) this.intents = next;
	}

	private enqueueStageIntents(paths: Iterable<string>, desired: boolean, force = false): void {
		let queued = false;
		this.patchIntents(paths, (intent) => {
			queued = this.queue.enqueue(intent, desired, force) || queued;
			return intent.desiredSelected !== desired || intent.error
				? { desiredSelected: desired, error: null }
				: null;
		});
		if (queued) void this.drainQueue();
	}

	private reconcilePathsAfterStage(paths: string[], desiredSelected: boolean): void {
		const result = reconcileCommitTreeAfterStage(this.tree, new Set(paths), desiredSelected);
		if (result.changed) this.tree = result.nodes;
	}

	private resetForTargetIdentity(identity: string | null, preserveMessage: boolean): void {
		const message = preserveMessage ? this.message : '';
		this.contextGeneration += 1;
		this.treeValidated = false;
		this.queue.reset();
		this.loadedTargetIdentity = identity;
		this.tree = [];
		this.intents = {};
		this.shouldRefreshAfterDrain = false;
		this.activationPromise = null;
		this.treeLoadState = this.projectPath ? 'initial-loading' : 'idle';
		this.isProcessingQueue = false;
		this.isGeneratingMessage = false;
		this.isCommitting = false;
		this.preparingAction = null;
		this.lastError = null;
		this.message = message;
	}

	private async setTargetIdentity(
		identity: string | null,
		reason: GitTargetChangeReason,
		identityChanged: boolean,
	): Promise<void> {
		if (this.disposed) return;
		if (identityChanged) {
			this.saveCurrentSnapshot();
			this.resetForTargetIdentity(identity, false);
			if (identity) this.restoreSnapshot(identity);
			if (this.isPresentationVisible) await this.activate();
			return;
		}
		if (!identity) {
			this.resetForTargetIdentity(null, false);
			return;
		}
		if (reason === 'checkout') {
			this.resetForTargetIdentity(identity, true);
			if (this.isPresentationVisible) await this.activate();
			return;
		}
		if ((reason === 'invalidation' || reason === 'session') && this.isPresentationVisible) {
			const generation = this.contextGeneration;
			await this.waitForQueue();
			if (generation === this.contextGeneration && identity === this.target.identity) {
				await this.refreshTreeSnapshot();
			}
		}
	}

	private async activate(): Promise<void> {
		if (
			this.projectIdentityPending ||
			!this.projectPath ||
			!this.effectiveProjectKey ||
			this.disposed
		)
			return;
		if (this.activationPromise) return this.activationPromise;
		const generation = this.contextGeneration;
		const activation = (async () => {
			try {
				await this.deps.refreshSummary?.();
			} catch (error) {
				if (generation === this.contextGeneration) {
					this.lastError = m.commit_surface_refresh_failed_detail({
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (generation !== this.contextGeneration) return;
			if (this.tree.length === 0) await this.loadInitialTree();
			else await this.refreshTreeSnapshot();
		})();
		const trackedActivation = activation.finally(() => {
			if (this.activationPromise === trackedActivation) this.activationPromise = null;
		});
		this.activationPromise = trackedActivation;
		return trackedActivation;
	}

	private saveCurrentSnapshot(): void {
		const key = this.loadedTargetIdentity;
		if (!key || !this.projectPath) return;
		this.snapshots.save(
			key,
			{ tree: this.tree, intents: this.intents, message: this.message },
			this.target.identity,
		);
	}

	pruneExecutors(executorIds: ReadonlySet<string>): void {
		this.target.pruneExecutors(executorIds);
		this.snapshots.pruneExecutors(executorIds);
	}

	private restoreSnapshot(key: string): void {
		const snapshot = this.snapshots.restore(key);
		if (!snapshot) return;
		this.tree = snapshot.tree;
		this.intents = Object.fromEntries(
			Object.entries(snapshot.intents).map(([path, intent]) => [
				path,
				{
					...intent,
					isRunning: false,
					runningMode: null,
					desiredSelected: intent.error ? intent.desiredSelected : intent.actualSelected,
					error: intent.isRunning
						? 'Git operation was interrupted. Inspect the repository before trying again.'
						: intent.error,
				},
			]),
		);
		this.message = snapshot.message;
	}

	private isCurrentTarget(identity: string, generation: number): boolean {
		return identity === this.target.identity && generation === this.contextGeneration;
	}

	private commitMessageGenerationErrorMessage(error: unknown): string {
		if (!(error instanceof ApiError)) {
			return m.commit_surface_generate_failed_detail({
				detail: error instanceof Error ? error.message : String(error),
			});
		}
		switch (error.errorCode) {
			case 'commit_message_no_staged_files':
				return m.git_commit_message_errors_no_staged_files();
			case 'commit_message_agent_auth_required':
				return m.git_commit_message_errors_agent_auth_required();
			case 'commit_message_agent_unavailable':
				return m.git_commit_message_errors_agent_unavailable();
			case 'commit_message_rate_limited':
				return m.git_commit_message_errors_rate_limited();
			case 'commit_message_timeout':
				return m.git_commit_message_errors_timeout();
			case 'commit_message_empty_response':
				return m.git_commit_message_errors_empty_response();
			case 'commit_message_invalid_response':
				return m.git_commit_message_errors_invalid_response();
			case 'commit_message_generation_failed':
			default:
				return m.git_commit_message_errors_generation_failed();
		}
	}
}
