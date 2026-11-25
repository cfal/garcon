import type { GitProjectTarget } from '$lib/api/git-client.js';
import { sameGitProject } from '$lib/git/targets/git-target.js';
import {
	getGitWorkbenchSnapshot,
	type GitDiffTab,
	type GitTreeNode,
	type GitWorkbenchSnapshotResponse,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { GitInitialCommitController } from '$lib/git/commit/initial-commit-controller.svelte.js';
import { GitLineSelectionState } from '$lib/git/review/git-line-selection.svelte.js';
import { GitReviewDrafts } from '$lib/git/review/git-review-drafts.svelte.js';
import { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';
import { GitStagingActions } from '$lib/git/workbench/git-staging-actions.svelte.js';
import { GitWorkbenchFreshnessTracker } from './git-workbench-freshness-tracker.svelte.js';
import { GitTreeState } from '$lib/git/workbench/git-tree-state.svelte.js';
import {
	DEFAULT_REFRESH_OPTIONS,
	targetKey,
	type DiffMode,
	type GitWorkbenchMutationRunner,
	type GitWorkbenchRefreshOptions,
	type GitWorkbenchTarget,
} from '$lib/git/workbench/git-workbench-types.js';
import { GitVirtualReviewDocumentController } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { GitReviewBodyDemand } from '$lib/git/review/git-review-body-demand.js';
import { readGarconDebugFlag } from '$lib/utils/debug-flags.js';

export interface GitWorkbenchStoreOptions {
	runMutation?: GitWorkbenchMutationRunner;
	canMutate?: () => boolean;
}

interface WorkbenchLoadTrace {
	targetKey: string;
	reason: string;
	snapshotMs?: number;
	firstRenderableMs?: number;
}

const WORKBENCH_TRACE_STORAGE_KEY = 'garcon.gitWorkbenchTrace';

function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}

function shouldLogWorkbenchTrace(): boolean {
	return readGarconDebugFlag(WORKBENCH_TRACE_STORAGE_KEY);
}

function logWorkbenchTrace(trace: WorkbenchLoadTrace): void {
	if (!shouldLogWorkbenchTrace()) return;
	console.debug('git workbench load', trace);
}

export class GitWorkbenchStore {
	target = $state<GitWorkbenchTarget | null>(null);

	private lastTargetKey = '';
	private refreshGeneration = 0;
	private errorTimeout: ReturnType<typeof setTimeout> | null = null;
	private refreshPromise: Promise<void> | null = null;
	private snapshotLoadAbort: AbortController | null = null;
	private readonly freshness = new GitWorkbenchFreshnessTracker();
	private localGitMutationDepth = 0;
	private mutationContextGeneration = 0;
	private localGitMutationTarget: GitProjectTarget | null = null;
	private localGitMutationSnapshotApplied = false;
	private documentRecoveryAttempted = false;

	private readonly treeState: GitTreeState;
	private readonly virtualReview: GitVirtualReviewDocumentController;
	private readonly lineSelection: GitLineSelectionState;
	private readonly stagingActions: GitStagingActions;
	private readonly initialCommitController: GitInitialCommitController;
	private readonly reviewDrafts: GitReviewDrafts;
	private readonly porcelainController: GitPorcelainState;

	private lastErrorValue = $state<string | null>(null);
	private repositoryErrorValue = $state<string | null>(null);
	private hasCompletedInitialLoadValue = $state(false);
	isReconcilingLocalGitMutation = $state(false);

	constructor(private readonly options: GitWorkbenchStoreOptions = {}) {
		this.treeState = new GitTreeState();
		this.virtualReview = new GitVirtualReviewDocumentController({
			targetKey: () => targetKey(this.target),
			targetProjectPath: () => this.target?.projectPath ?? null,
			activeTab: () => this.treeState.activeTab,
			visibleFilePaths: () => this.treeState.visibleFilePaths,
			selectedFile: () => this.treeState.selectedFile,
			selectedLineKeys: () => this.lineSelection.selectedLineKeys,
			composerState: () => this.reviewDrafts.commentComposer,
			surfaceError: (message) => this.surfaceError(message),
			markExternallyStale: (reason) => this.markExternallyStale(reason),
			invalidateSelections: () => this.lineSelection.clearSelection(),
		});
		this.lineSelection = new GitLineSelectionState();
		this.stagingActions = new GitStagingActions({
			selectedFile: () => this.treeState.selectedFile,
			activeTab: () => this.treeState.activeTab,
			contextLines: () => this.virtualReview.contextLines,
			visibleFilePaths: () => this.treeState.visibleFilePaths,
			lineSelection: this.lineSelection,
			findTreeNode: (filePath) => this.findTreeNode(filePath),
			setSelectedFile: (filePath) => {
				this.treeState.selectedFile = filePath;
			},
			invalidateReviewData: (project) => this.invalidateReviewData(project),
			refreshFileAfterStage: (project, filePath) => this.refreshFileAfterStage(project, filePath),
			refreshAfterGitAction: (project, options) => this.refreshAfterGitAction(project, options),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (project) => this.isCurrentTarget(project),
			runGitMutation: this.runLocalGitMutation,
		});
		this.initialCommitController = new GitInitialCommitController({
			refreshAfterGitAction: (project, options) => this.refreshAfterGitAction(project, options),
			setHasCommits: (hasCommits) => {
				this.treeState.hasCommits = hasCommits;
			},
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (project) => this.isCurrentTarget(project),
			runGitMutation: this.runLocalGitMutation,
		});
		this.reviewDrafts = new GitReviewDrafts();
		this.porcelainController = new GitPorcelainState({
			selectedFile: () => this.treeState.selectedFile,
			refreshAfterMutation: (project) =>
				this.refreshAfterGitAction(project, {
					reason: 'git-action',
					preferSelectedFile: true,
				}),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (project) => this.isCurrentTarget(project),
			runGitMutation: this.runLocalGitMutation,
		});

		this.treeState.loadTreePaneWidth();
		this.treeState.loadHideOtherTabFiles();
	}

	get files(): GitTreeState {
		return this.treeState;
	}

	get review(): GitVirtualReviewDocumentController {
		return this.virtualReview;
	}

	get selection(): GitLineSelectionState {
		return this.lineSelection;
	}

	get staging(): GitStagingActions {
		return this.stagingActions;
	}

	get initialCommit(): GitInitialCommitController {
		return this.initialCommitController;
	}

	get drafts(): GitReviewDrafts {
		return this.reviewDrafts;
	}

	get projectPath(): string | null {
		return this.target?.projectPath ?? null;
	}

	get hasTarget(): boolean {
		return Boolean(this.target);
	}

	get isInitialLoadPending(): boolean {
		return Boolean(this.target) && !this.hasCompletedInitialLoadValue;
	}

	get lastError(): string | null {
		return this.lastErrorValue;
	}

	set lastError(value: string | null) {
		if (this.errorTimeout !== null) clearTimeout(this.errorTimeout);
		this.errorTimeout = null;
		this.lastErrorValue = value;
	}

	get repositoryError(): string | null {
		return this.repositoryErrorValue;
	}

	set repositoryError(value: string | null) {
		this.repositoryErrorValue = value;
	}

	get porcelain(): GitPorcelainState {
		return this.porcelainController;
	}

	// Applies the target and owns tab coherence: a retained same-path document
	// switching tabs runs the full tab transition so the loaded tree and review
	// document always correspond to the active tab.
	async setTarget(nextTarget: GitWorkbenchTarget | null, activeTab?: GitDiffTab): Promise<void> {
		const nextKey = targetKey(nextTarget);
		if (nextKey === this.lastTargetKey) {
			this.target = nextTarget;
			if (nextTarget && activeTab && activeTab !== this.treeState.activeTab) {
				await this.applyActiveTab(activeTab);
				return;
			}
			this.virtualReview.markDemandReadinessChanged();
			if (
				nextTarget &&
				this.treeState.tree.length === 0 &&
				!this.treeState.isLoadingTree &&
				!this.repositoryError
			) {
				await this.refresh({ reason: 'mount' });
			}
			return;
		}

		this.target = nextTarget;
		this.lastTargetKey = nextKey;
		this.resetForTargetChange();
		if (activeTab) this.treeState.activeTab = activeTab;

		if (nextTarget) {
			await this.refresh({
				reason: 'mount',
				preserveSelection: false,
			});
		}
	}

	// Clears user interaction state that must not survive a surface identity
	// change even when the physical target and its loaded data are retained.
	resetReviewInteraction(): void {
		this.lineSelection.clearSelection();
		this.reviewDrafts.closeCommentComposer();
	}

	dismissError(): void {
		this.lastError = null;
	}

	reportError(message: string): void {
		this.surfaceError(message);
	}

	async refresh(options: GitWorkbenchRefreshOptions): Promise<void> {
		if (this.refreshPromise) {
			this.snapshotLoadAbort?.abort();
			this.refreshGeneration++;
		}
		const refresh = this.refreshNow(options);
		this.refreshPromise = refresh;
		try {
			await refresh;
		} finally {
			if (this.refreshPromise === refresh) this.refreshPromise = null;
		}
	}

	async refreshStaleWorkbench(): Promise<void> {
		if (!this.target) return;
		await this.refresh({
			reason: 'manual',
			preserveSelection: true,
			preferSelectedFile: true,
		});
	}

	suspend(): void {
		this.dismissError();
		this.snapshotLoadAbort?.abort();
		this.refreshGeneration++;
		this.treeState.isLoadingTree = false;
		this.freshness.abort();
		this.virtualReview.suspend();
		this.porcelain.cancelActiveLoad();
		this.initialCommit.reset();
		this.stagingActions.cancelDiscard();
		this.lineSelection.clearSelection();
		this.freshness.isStale = true;
	}

	get loadedWorkbenchFingerprint(): string | null {
		return this.freshness.loadedFingerprint;
	}

	get latestWorkbenchFingerprint(): string | null {
		return this.freshness.latestFingerprint;
	}

	get isExternallyStale(): boolean {
		return this.freshness.isStale;
	}

	get freshnessError(): string | null {
		return this.freshness.error;
	}

	async checkFreshness(project: GitProjectTarget): Promise<void> {
		if (
			this.isReconcilingLocalGitMutation ||
			this.refreshPromise ||
			!sameGitProject(this.target, project)
		)
			return;

		const requestTargetKey = targetKey(this.target);
		await this.freshness.check(
			project,
			() =>
				!this.isReconcilingLocalGitMutation &&
				targetKey(this.target) === requestTargetKey &&
				sameGitProject(this.target, project),
		);
	}

	markExternallyStale(reason: 'stale' | 'document-expired' = 'stale'): void {
		if (!this.loadedWorkbenchFingerprint) return;
		if (this.isReconcilingLocalGitMutation) return;
		this.freshness.isStale = true;
		if (reason !== 'document-expired' || this.documentRecoveryAttempted || !this.target) return;
		this.documentRecoveryAttempted = true;
		void this.refresh({
			reason: 'document-expired',
			preserveSelection: true,
			preferSelectedFile: true,
		});
	}

	ensureFreshForGitMutation(): boolean {
		if (this.target && !this.isExternallyStale && (this.options.canMutate?.() ?? true)) return true;
		this.surfaceError('Refresh the Git workbench before modifying changes.');
		return false;
	}

	runLocalGitMutation: GitWorkbenchMutationRunner = async (project, action) => {
		return this.runLocalGitReconciliation(
			project,
			() => this.options.runMutation?.(project, action) ?? action(),
		);
	};

	async runLocalGitReconciliation<T>(
		project: GitProjectTarget,
		action: () => Promise<T>,
	): Promise<T> {
		const generation = this.mutationContextGeneration;
		this.beginLocalGitMutation(project);
		try {
			return await action();
		} finally {
			if (generation === this.mutationContextGeneration) this.endLocalGitMutation(project);
		}
	}

	async openFile(project: GitProjectTarget, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(project)) return;
		this.treeState.selectedFile = filePath;
		this.lineSelection.clearSelection();
		this.virtualReview.focusFile(project.projectPath, filePath);
	}

	async selectFile(project: GitProjectTarget, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(project)) return;
		const nextTab = this.treeState.preferredTabForFile(filePath);
		if (!nextTab) {
			this.surfaceError(`File is not available in the current Git target: ${filePath}`);
			return;
		}
		if (this.treeState.activeTab !== nextTab) this.setActiveTab(nextTab);
		await this.openFile(project, filePath);
	}

	handleReviewBodyDemand(demand: GitReviewBodyDemand): void {
		this.virtualReview.handleBodyDemand(demand);
	}

	private invalidateReviewData(project: GitProjectTarget): void {
		if (!this.isCurrentTarget(project)) return;
		this.virtualReview.refreshAllData();
	}

	setActiveTab(tab: GitDiffTab): void {
		void this.applyActiveTab(tab);
	}

	private async applyActiveTab(tab: GitDiffTab): Promise<void> {
		if (tab === this.treeState.activeTab) return;
		this.treeState.activeTab = tab;
		this.lineSelection.clearSelection();
		this.reviewDrafts.closeCommentComposer();
		this.virtualReview.clearForDisplayChange();
		this.selectFirstVisibleFileForActiveTab();
		if (this.target)
			await this.refresh({
				reason: 'tab-change',
				preserveSelection: true,
				preferSelectedFile: true,
			});
	}

	setHideGenerated(value: boolean): void {
		this.treeState.setHideGenerated(value);
		this.ensureSelectedFileIsVisible();
	}

	setHideOtherTabFiles(value: boolean): void {
		this.treeState.setHideOtherTabFiles(value);
		this.ensureSelectedFileIsVisible();
	}

	async selectNextFile(project: GitProjectTarget): Promise<boolean> {
		const next = this.treeState.nextVisibleFile();
		if (!next || next === this.treeState.selectedFile) return false;
		await this.selectFile(project, next);
		return true;
	}

	async selectPreviousFile(project: GitProjectTarget): Promise<boolean> {
		const previous = this.treeState.previousVisibleFile();
		if (!previous || previous === this.treeState.selectedFile) return false;
		await this.selectFile(project, previous);
		return true;
	}

	setContextLines(lines: number): void {
		this.setDisplayOptions(this.virtualReview.diffMode, lines, { refresh: true });
	}

	setDisplayOptions(diffMode: DiffMode, contextLines: number, options: { refresh: boolean }): void {
		const normalizedContext = Math.max(0, Math.round(contextLines));
		const contextChanged = normalizedContext !== this.virtualReview.contextLines;
		this.virtualReview.diffMode = diffMode;
		if (!contextChanged) return;
		this.virtualReview.contextLines = normalizedContext;
		this.virtualReview.clearForDisplayChange();
		if (options.refresh && this.target) {
			void this.refresh({
				reason: 'context-change',
				preserveSelection: true,
				preferSelectedFile: true,
			});
		}
	}

	reset(): void {
		this.target = null;
		this.lastTargetKey = '';
		this.resetForTargetChange();
	}

	private async refreshNow(options: GitWorkbenchRefreshOptions): Promise<void> {
		const target = this.target;
		if (!target || !(this.options.canMutate?.() ?? true)) return;
		const effective: Required<GitWorkbenchRefreshOptions> = {
			...DEFAULT_REFRESH_OPTIONS,
			...options,
		};
		if (effective.reason !== 'document-expired') this.documentRecoveryAttempted = false;
		const loadStartedAt = performance.now();
		const trace: WorkbenchLoadTrace = {
			targetKey: targetKey(target),
			reason: effective.reason,
		};
		const generation = ++this.refreshGeneration;
		const requestTab = this.treeState.activeTab;
		const requestContext = this.virtualReview.contextLines;
		const previousSelectedFile = this.treeState.selectedFile;
		this.freshness.abort();
		this.snapshotLoadAbort?.abort();
		const controller = new AbortController();
		this.snapshotLoadAbort = controller;
		this.treeState.isLoadingTree = true;

		try {
			const snapshotStartedAt = performance.now();
			const snapshot = await getGitWorkbenchSnapshot(target, requestTab, requestContext, {
				signal: controller.signal,
				selectedFile: effective.preferSelectedFile ? previousSelectedFile : null,
				bodyCandidateCount: 3,
			});
			trace.snapshotMs = elapsedMs(snapshotStartedAt);
			if (!this.isCurrentSnapshotLoad(target, generation, requestTab, requestContext)) {
				trace.firstRenderableMs = elapsedMs(loadStartedAt);
				logWorkbenchTrace(trace);
				return;
			}

			this.applyWorkbenchSnapshot(snapshot, target, effective, previousSelectedFile);
			trace.firstRenderableMs = elapsedMs(loadStartedAt);
			logWorkbenchTrace(trace);
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.isCurrentSnapshotLoad(target, generation, requestTab, requestContext)
			)
				return;
			this.hasCompletedInitialLoadValue = true;
			this.repositoryError = null;
			if (this.loadedWorkbenchFingerprint !== null) this.freshness.isStale = true;
			this.surfaceError(
				`Failed to load Git workbench: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (this.snapshotLoadAbort === controller) this.snapshotLoadAbort = null;
			if (this.isCurrentSnapshotLoad(target, generation, requestTab, requestContext)) {
				this.treeState.isLoadingTree = false;
			}
		}
	}

	private applyWorkbenchSnapshot(
		snapshot: GitWorkbenchSnapshotResponse,
		target: GitWorkbenchTarget,
		options: Required<GitWorkbenchRefreshOptions>,
		previousSelectedFile: string | null,
	): void {
		this.hasCompletedInitialLoadValue = true;

		if (this.isReconcilingLocalGitMutation) this.localGitMutationSnapshotApplied = true;

		if (snapshot.status === 'not-git-repository') {
			this.freshness.reset();
			this.repositoryError = snapshot.message;
			this.lastError = null;
			this.treeState.applyTree([], true, 'loaded');
			this.virtualReview.applySummary(null);
			this.treeState.selectedFile = null;
			this.lineSelection.reset();
			return;
		}

		this.freshness.applyFingerprint(snapshot.workbenchFingerprint);
		this.repositoryError = null;
		this.treeState.applyTree(
			snapshot.tree.root,
			snapshot.tree.hasCommits,
			snapshot.tree.statsState,
		);
		const paths = new Set(this.treeState.filePaths);
		this.lineSelection.clearSelection();

		const visible = this.treeState.visibleFilePaths;
		const selectedFromSnapshot =
			snapshot.selectedFile && visible.includes(snapshot.selectedFile)
				? snapshot.selectedFile
				: null;
		const preservedSelection =
			options.preserveSelection &&
			options.preferSelectedFile &&
			previousSelectedFile &&
			visible.includes(previousSelectedFile)
				? previousSelectedFile
				: null;

		this.treeState.selectedFile =
			preservedSelection ??
			selectedFromSnapshot ??
			(options.preserveSelection &&
			this.treeState.selectedFile &&
			visible.includes(this.treeState.selectedFile)
				? this.treeState.selectedFile
				: (visible[0] ?? null));

		const bodyCandidates = uniquePaths([
			this.treeState.selectedFile,
			...snapshot.firstBodyCandidates,
		]).filter((filePath) => visible.includes(filePath));
		this.virtualReview.applySummary(snapshot.reviewSummary, bodyCandidates);
		this.virtualReview.pruneToFilePaths(paths);
	}

	private async refreshFileAfterStage(project: GitProjectTarget, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(project)) return;
		this.virtualReview.invalidateFile(filePath);
		await this.refreshAfterGitAction(project, {
			reason: 'git-action',
			preferSelectedFile: true,
		});
		if (!this.isCurrentTarget(project)) return;
		const visibleFilePaths = this.treeState.visibleFilePaths;
		if (this.treeState.selectedFile === filePath && !visibleFilePaths.includes(filePath)) {
			this.treeState.selectedFile = visibleFilePaths[0] ?? null;
			return;
		}
		if (this.treeState.selectedFile === filePath && this.treeState.hasFile(filePath)) {
			this.virtualReview.focusFile(project.projectPath, filePath);
		}
	}

	private async refreshAfterGitAction(
		project: GitProjectTarget,
		options: GitWorkbenchRefreshOptions,
	): Promise<void> {
		if (this.isCurrentTarget(project)) await this.refresh(options);
	}

	private isCurrentTarget(project: GitProjectTarget): boolean {
		return sameGitProject(this.target, project);
	}

	private findTreeNode(filePath: string): GitTreeNode | undefined {
		return this.treeState.findTreeNode(filePath);
	}

	private surfaceError(message: string): void {
		this.lastError = message;
		this.errorTimeout = setTimeout(() => this.dismissError(), 6000);
	}

	private isCurrentSnapshotLoad(
		target: GitWorkbenchTarget,
		generation: number,
		tab: GitDiffTab,
		contextLines: number,
	): boolean {
		if (generation !== this.refreshGeneration) return false;
		if (targetKey(this.target) !== targetKey(target)) return false;
		if (this.treeState.activeTab !== tab) return false;
		if (this.virtualReview.contextLines !== contextLines) return false;
		return this.target?.projectPath === target.projectPath;
	}

	private selectFirstVisibleFileForActiveTab(): void {
		if (
			this.treeState.selectedFile &&
			this.treeState.preferredTabForFile(this.treeState.selectedFile) === this.treeState.activeTab
		)
			return;
		this.treeState.selectedFile = this.treeState.visibleFilePaths[0] ?? null;
	}

	private ensureSelectedFileIsVisible(): void {
		if (
			this.treeState.selectedFile &&
			this.treeState.visibleFilePaths.includes(this.treeState.selectedFile)
		)
			return;
		this.treeState.selectedFile = this.treeState.visibleFilePaths[0] ?? null;
	}

	private resetForTargetChange(): void {
		this.mutationContextGeneration++;
		this.clearLocalGitMutationState();
		this.freshness.reset();
		this.treeState.reset();
		this.virtualReview.reset();
		this.treeState.selectedFile = null;
		this.lineSelection.reset();
		this.stagingActions.reset();
		this.reviewDrafts.reset();
		this.initialCommitController.reset();
		this.porcelainController.reset();
		this.lastError = null;
		this.repositoryError = null;
		this.hasCompletedInitialLoadValue = false;
		this.documentRecoveryAttempted = false;
		this.snapshotLoadAbort?.abort();
		this.snapshotLoadAbort = null;
		this.refreshGeneration++;
	}

	private beginLocalGitMutation(project: GitProjectTarget): void {
		if (this.localGitMutationDepth === 0) {
			this.localGitMutationTarget = project;
			this.localGitMutationSnapshotApplied = false;
			this.isReconcilingLocalGitMutation = true;
			this.freshness.abort();
		}
		this.localGitMutationDepth += 1;
	}

	private endLocalGitMutation(project: GitProjectTarget): void {
		if (this.localGitMutationDepth === 0) return;
		this.localGitMutationDepth -= 1;
		if (this.localGitMutationDepth > 0) return;

		const hadSnapshot = this.localGitMutationSnapshotApplied;
		const mutationProjectPath = this.localGitMutationTarget ?? project;
		this.clearLocalGitMutationState();

		if (
			!hadSnapshot &&
			!this.isExternallyStale &&
			this.loadedWorkbenchFingerprint !== null &&
			sameGitProject(this.target, mutationProjectPath)
		) {
			void this.checkFreshness(mutationProjectPath);
		}
	}

	private clearLocalGitMutationState(): void {
		this.localGitMutationDepth = 0;
		this.localGitMutationTarget = null;
		this.localGitMutationSnapshotApplied = false;
		this.isReconcilingLocalGitMutation = false;
	}
}

function uniquePaths(paths: Array<string | null>): string[] {
	return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}
