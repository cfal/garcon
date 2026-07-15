import {
	getGitWorkbenchFingerprint,
	getGitWorkbenchSnapshot,
	type GitDiffTab,
	type GitTreeNode,
	type GitWorkbenchSnapshotResponse,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { GitWorkbenchCommitController } from '$lib/git/commit/workbench-commit-controller.svelte.js';
import { GitLineSelectionState } from '$lib/git/review/git-line-selection.svelte.js';
import { GitReviewDrafts } from '$lib/git/review/git-review-drafts.svelte.js';
import { GitPorcelainState } from '$lib/git/workbench/git-porcelain.svelte.js';
import { GitStagingActions } from '$lib/git/workbench/git-staging-actions.svelte.js';
import { GitTreeState } from '$lib/git/workbench/git-tree-state.svelte.js';
import {
	DEFAULT_REFRESH_OPTIONS,
	targetKey,
	type GitWorkbenchMutationRunner,
	type GitWorkbenchRefreshOptions,
	type GitWorkbenchTarget,
} from '$lib/git/workbench/git-workbench-types.js';
import { GitWorktrees } from '$lib/git/targets/git-worktrees.svelte.js';
import {
	GitVirtualReviewDocumentController,
	type GitVirtualReviewRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';

export interface GitWorkbenchStoreOptions {
	runMutation?: GitWorkbenchMutationRunner;
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
	try {
		return globalThis.localStorage?.getItem(WORKBENCH_TRACE_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

function logWorkbenchTrace(trace: WorkbenchLoadTrace): void {
	if (!shouldLogWorkbenchTrace()) return;
	console.debug('git workbench load', trace);
}

export class GitWorkbenchStore {
	target = $state<GitWorkbenchTarget | null>(null);

	private lastTargetKey = '';
	private refreshGeneration = 0;
	private scheduledRefresh: ReturnType<typeof setTimeout> | null = null;
	private refreshPromise: Promise<void> | null = null;
	private snapshotLoadAbort: AbortController | null = null;
	private freshnessGeneration = 0;
	private freshnessAbort: AbortController | null = null;
	private localGitMutationDepth = 0;
	private localGitMutationProjectPath: string | null = null;
	private localGitMutationSnapshotApplied = false;
	private scrollPositions = new Map<string, number>();

	private readonly treeState: GitTreeState;
	private readonly virtualReview: GitVirtualReviewDocumentController;
	private readonly lineSelection: GitLineSelectionState;
	private readonly stagingActions: GitStagingActions;
	private readonly commitController: GitWorkbenchCommitController;
	private readonly reviewDrafts: GitReviewDrafts;
	private readonly worktreeController: GitWorktrees;
	private readonly porcelainController: GitPorcelainState;

	private lastErrorValue = $state<string | null>(null);
	private repositoryErrorValue = $state<string | null>(null);
	private hasCompletedInitialLoadValue = $state(false);
	loadedWorkbenchFingerprint = $state<string | null>(null);
	latestWorkbenchFingerprint = $state<string | null>(null);
	isExternallyStale = $state(false);
	isCheckingFreshness = $state(false);
	freshnessError = $state<string | null>(null);
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
			commentsByFile: () => this.reviewDrafts.commentsByFile,
			composerState: () => this.reviewDrafts.commentComposer,
			surfaceError: (message) => this.surfaceError(message),
			markExternallyStale: () => this.markExternallyStale(),
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
			refreshAllData: (projectPath) => this.refreshAllData(projectPath),
			refreshFileAfterStage: (projectPath, filePath) =>
				this.refreshFileAfterStage(projectPath, filePath),
			refreshAfterGitAction: (projectPath, options) =>
				this.refreshAfterGitAction(projectPath, options),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (projectPath) => this.isCurrentTarget(projectPath),
			runGitMutation: this.runLocalGitMutation,
		});
		this.commitController = new GitWorkbenchCommitController({
			stagedFiles: () => this.treeState.stagedFiles,
			visibleFilePaths: () => this.treeState.visibleFilePaths,
			selectedFile: () => this.treeState.selectedFile,
			setSelectedFile: (filePath) => {
				this.treeState.selectedFile = filePath;
			},
			openFile: (projectPath, filePath) => this.openFile(projectPath, filePath),
			refreshAllData: (projectPath) => this.refreshAllData(projectPath),
			refreshAfterGitAction: (projectPath, options) =>
				this.refreshAfterGitAction(projectPath, options),
			setHasCommits: (hasCommits) => {
				this.treeState.hasCommits = hasCommits;
			},
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (projectPath) => this.isCurrentTarget(projectPath),
			runGitMutation: this.runLocalGitMutation,
		});
		this.reviewDrafts = new GitReviewDrafts();
		this.worktreeController = new GitWorktrees({
			surfaceError: (message) => this.surfaceError(message),
		});
		this.porcelainController = new GitPorcelainState({
			selectedFile: () => this.treeState.selectedFile,
			refreshAfterMutation: (projectPath) =>
				this.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preferSelectedFile: true,
				}),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			isCurrentTarget: (projectPath) => this.isCurrentTarget(projectPath),
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

	get commit(): GitWorkbenchCommitController {
		return this.commitController;
	}

	get drafts(): GitReviewDrafts {
		return this.reviewDrafts;
	}

	get worktree(): GitWorktrees {
		return this.worktreeController;
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

	async setTarget(nextTarget: GitWorkbenchTarget | null): Promise<void> {
		const nextKey = targetKey(nextTarget);
		if (nextKey === this.lastTargetKey) {
			this.target = nextTarget;
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

		if (nextTarget) {
			await this.refresh({
				reason: 'mount',
				preserveDrafts: false,
				preserveSelection: false,
			});
		}
	}

	dismissError(): void {
		this.lastError = null;
	}

	reportError(message: string): void {
		this.surfaceError(message);
	}

	scheduleRefresh(options: GitWorkbenchRefreshOptions, delayMs = 350): void {
		if (this.scheduledRefresh) clearTimeout(this.scheduledRefresh);
		this.scheduledRefresh = setTimeout(() => {
			this.scheduledRefresh = null;
			void this.refresh(options);
		}, delayMs);
	}

	async refresh(options: GitWorkbenchRefreshOptions): Promise<void> {
		if (this.refreshPromise) {
			this.snapshotLoadAbort?.abort();
			this.refreshGeneration++;
			await this.refreshPromise;
		}
		this.refreshPromise = this.refreshNow(options);
		try {
			await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	async refreshStaleWorkbench(): Promise<void> {
		if (!this.target) return;
		await this.refresh({
			reason: 'manual',
			preserveDrafts: true,
			preserveSelection: true,
			preferSelectedFile: true,
		});
	}

	async checkFreshness(projectPath: string): Promise<void> {
		if (!projectPath || !this.loadedWorkbenchFingerprint || this.isExternallyStale) return;
		if (this.isReconcilingLocalGitMutation || this.refreshPromise || this.isCheckingFreshness)
			return;

		const target = this.target;
		if (!target || target.projectPath !== projectPath) return;

		const requestTargetKey = targetKey(target);
		const requestProjectPath = target.projectPath;
		const generation = ++this.freshnessGeneration;
		this.freshnessAbort?.abort();
		const controller = new AbortController();
		this.freshnessAbort = controller;
		this.isCheckingFreshness = true;

		try {
			const result = await getGitWorkbenchFingerprint(projectPath, { signal: controller.signal });
			if (!this.isCurrentFreshnessLoad(requestTargetKey, requestProjectPath, generation)) return;
			if (this.isReconcilingLocalGitMutation) return;
			if (result.status !== 'ready') {
				this.freshnessError = result.status === 'unknown' ? result.message : null;
				return;
			}
			this.freshnessError = null;
			this.latestWorkbenchFingerprint = result.fingerprint;
			this.isExternallyStale = result.fingerprint !== this.loadedWorkbenchFingerprint;
		} catch (error) {
			if (
				isAbortError(error) ||
				!this.isCurrentFreshnessLoad(requestTargetKey, requestProjectPath, generation)
			) {
				return;
			}
			this.freshnessError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.freshnessAbort === controller) this.freshnessAbort = null;
			if (this.isCurrentFreshnessLoad(requestTargetKey, requestProjectPath, generation)) {
				this.isCheckingFreshness = false;
			}
		}
	}

	markExternallyStale(): void {
		if (!this.loadedWorkbenchFingerprint) return;
		if (this.isReconcilingLocalGitMutation) return;
		this.isExternallyStale = true;
	}

	ensureFreshForGitMutation(): boolean {
		if (!this.isExternallyStale) return true;
		this.surfaceError('Refresh the Git workbench before modifying changes.');
		return false;
	}

	runLocalGitMutation: GitWorkbenchMutationRunner = async (projectPath, action) => {
		this.beginLocalGitMutation(projectPath);
		try {
			return await (this.options.runMutation?.(projectPath, action) ?? action());
		} finally {
			this.endLocalGitMutation(projectPath);
		}
	};

	async openFile(projectPath: string, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(projectPath)) return;
		this.treeState.selectedFile = filePath;
		this.lineSelection.clearSelection();
		this.virtualReview.focusFile(projectPath, filePath);
	}

	async selectFile(projectPath: string, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(projectPath)) return;
		const nextTab = this.treeState.preferredTabForFile(filePath);
		if (!nextTab) {
			this.surfaceError(`File is not available in the current Git target: ${filePath}`);
			return;
		}
		if (this.treeState.activeTab !== nextTab) this.setActiveTab(nextTab);
		await this.openFile(projectPath, filePath);
	}

	handleVisibleReviewRows(projectPath: string, rows: GitVirtualReviewRow[]): void {
		this.virtualReview.setVisibleRows(projectPath, rows);
	}

	private refreshAllData(projectPath: string): void {
		if (!this.isCurrentTarget(projectPath)) return;
		this.virtualReview.refreshAllData();
		if (this.target)
			void this.refresh({
				reason: 'manual',
				preserveSelection: true,
				preferSelectedFile: true,
			});
	}

	setActiveTab(tab: GitDiffTab): void {
		if (tab === this.treeState.activeTab) return;
		this.treeState.activeTab = tab;
		this.lineSelection.clearSelection();
		this.virtualReview.clearForDisplayChange();
		this.selectFirstVisibleFileForActiveTab();
		if (this.target)
			void this.refresh({
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

	async selectNextFile(projectPath: string): Promise<boolean> {
		const next = this.treeState.nextVisibleFile();
		if (!next || next === this.treeState.selectedFile) return false;
		await this.selectFile(projectPath, next);
		return true;
	}

	async selectPreviousFile(projectPath: string): Promise<boolean> {
		const previous = this.treeState.previousVisibleFile();
		if (!previous || previous === this.treeState.selectedFile) return false;
		await this.selectFile(projectPath, previous);
		return true;
	}

	setContextLines(lines: number): void {
		this.virtualReview.contextLines = lines;
		this.virtualReview.clearForDisplayChange();
		if (this.target)
			void this.refresh({
				reason: 'context-change',
				preserveSelection: true,
				preferSelectedFile: true,
			});
	}

	saveScrollPosition(filePath: string, position: number): void {
		this.scrollPositions.set(filePath, position);
	}

	getScrollPosition(filePath: string): number {
		return this.scrollPositions.get(filePath) ?? 0;
	}

	reset(): void {
		this.target = null;
		this.lastTargetKey = '';
		this.resetForTargetChange();
	}

	private async refreshNow(options: GitWorkbenchRefreshOptions): Promise<void> {
		const target = this.target;
		if (!target) return;
		const effective: Required<GitWorkbenchRefreshOptions> = {
			...DEFAULT_REFRESH_OPTIONS,
			...options,
		};
		const loadStartedAt = performance.now();
		const trace: WorkbenchLoadTrace = {
			targetKey: targetKey(target),
			reason: effective.reason,
		};
		const generation = ++this.refreshGeneration;
		const requestTab = this.treeState.activeTab;
		const requestContext = this.virtualReview.contextLines;
		const previousSelectedFile = this.treeState.selectedFile;
		this.abortFreshnessCheck();
		this.snapshotLoadAbort?.abort();
		const controller = new AbortController();
		this.snapshotLoadAbort = controller;
		this.treeState.isLoadingTree = true;

		try {
			const snapshotStartedAt = performance.now();
			const snapshot = await getGitWorkbenchSnapshot(
				target.projectPath,
				requestTab,
				requestContext,
				{
					signal: controller.signal,
					selectedFile: effective.preferSelectedFile ? previousSelectedFile : null,
					bodyCandidateCount: 8,
				},
			);
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
			this.treeState.applyTree([], this.treeState.hasCommits, 'pending');
			this.virtualReview.applySummary(null);
			this.treeState.selectedFile = null;
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
			this.clearFreshnessState();
			this.repositoryError = snapshot.message;
			this.lastError = null;
			this.treeState.applyTree([], true, 'loaded');
			this.virtualReview.applySummary(null);
			this.treeState.selectedFile = null;
			this.lineSelection.reset();
			return;
		}

		this.loadedWorkbenchFingerprint = snapshot.workbenchFingerprint;
		this.latestWorkbenchFingerprint = snapshot.workbenchFingerprint;
		this.isExternallyStale = false;
		this.freshnessError = null;
		this.repositoryError = null;
		this.treeState.applyTree(
			snapshot.tree.root,
			snapshot.tree.hasCommits,
			snapshot.tree.statsState,
		);
		this.virtualReview.applySummary(snapshot.reviewSummary);

		const paths = new Set(this.treeState.filePaths);
		this.virtualReview.pruneToFilePaths(paths);
		this.lineSelection.pruneToFilePaths(paths);

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
		if (bodyCandidates.length > 0)
			this.virtualReview.requestBodies(target.projectPath, bodyCandidates);
	}

	private async refreshFileAfterStage(projectPath: string, filePath: string): Promise<void> {
		if (!this.isCurrentTarget(projectPath)) return;
		this.virtualReview.invalidateFile(filePath);
		await this.refreshAfterGitAction(projectPath, {
			reason: 'git-action',
			preferSelectedFile: true,
		});
		if (!this.isCurrentTarget(projectPath)) return;
		const visibleFilePaths = this.treeState.visibleFilePaths;
		if (this.treeState.selectedFile === filePath && !visibleFilePaths.includes(filePath)) {
			this.treeState.selectedFile = visibleFilePaths[0] ?? null;
			return;
		}
		if (this.treeState.selectedFile === filePath && this.treeState.hasFile(filePath)) {
			this.virtualReview.focusFile(projectPath, filePath);
		}
	}

	private async refreshAfterGitAction(
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	): Promise<void> {
		if (this.isCurrentTarget(projectPath)) await this.refresh(options);
	}

	private isCurrentTarget(projectPath: string): boolean {
		return this.target?.projectPath === projectPath;
	}

	private findTreeNode(filePath: string): GitTreeNode | undefined {
		return this.treeState.findTreeNode(filePath);
	}

	private surfaceError(message: string): void {
		this.lastError = message;
		setTimeout(() => {
			if (this.lastError === message) this.lastError = null;
		}, 6000);
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

	private isCurrentFreshnessLoad(
		requestTargetKey: string,
		projectPath: string,
		generation: number,
	): boolean {
		if (generation !== this.freshnessGeneration) return false;
		if (targetKey(this.target) !== requestTargetKey) return false;
		return this.target?.projectPath === projectPath;
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
		this.clearLocalGitMutationState();
		this.clearFreshnessState();
		this.treeState.reset();
		this.virtualReview.reset();
		this.treeState.selectedFile = null;
		this.lineSelection.reset();
		this.stagingActions.reset();
		this.reviewDrafts.reset();
		this.commitController.resetForTargetChange();
		this.worktreeController.reset();
		this.porcelainController.reset();
		this.lastError = null;
		this.repositoryError = null;
		this.hasCompletedInitialLoadValue = false;
		this.scrollPositions.clear();
		this.snapshotLoadAbort?.abort();
		this.snapshotLoadAbort = null;
		this.refreshGeneration++;
	}

	private abortFreshnessCheck(): void {
		this.freshnessGeneration += 1;
		this.freshnessAbort?.abort();
		this.freshnessAbort = null;
		this.isCheckingFreshness = false;
	}

	private clearFreshnessState(): void {
		this.abortFreshnessCheck();
		this.loadedWorkbenchFingerprint = null;
		this.latestWorkbenchFingerprint = null;
		this.isExternallyStale = false;
		this.freshnessError = null;
	}

	private beginLocalGitMutation(projectPath: string): void {
		if (this.localGitMutationDepth === 0) {
			this.localGitMutationProjectPath = projectPath;
			this.localGitMutationSnapshotApplied = false;
			this.isReconcilingLocalGitMutation = true;
			this.abortFreshnessCheck();
		}
		this.localGitMutationDepth += 1;
	}

	private endLocalGitMutation(projectPath: string): void {
		if (this.localGitMutationDepth === 0) return;
		this.localGitMutationDepth -= 1;
		if (this.localGitMutationDepth > 0) return;

		const hadSnapshot = this.localGitMutationSnapshotApplied;
		const mutationProjectPath = this.localGitMutationProjectPath ?? projectPath;
		this.clearLocalGitMutationState();

		if (
			!hadSnapshot &&
			!this.isExternallyStale &&
			this.loadedWorkbenchFingerprint !== null &&
			this.target?.projectPath === mutationProjectPath
		) {
			void this.checkFreshness(mutationProjectPath);
		}
	}

	private clearLocalGitMutationState(): void {
		this.localGitMutationDepth = 0;
		this.localGitMutationProjectPath = null;
		this.localGitMutationSnapshotApplied = false;
		this.isReconcilingLocalGitMutation = false;
	}
}

function uniquePaths(paths: Array<string | null>): string[] {
	return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}
