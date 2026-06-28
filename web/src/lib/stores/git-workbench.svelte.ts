import {
	getGitWorkbenchFingerprint,
	getGitWorkbenchSnapshot,
	type GitDiffTab,
	type GitReviewCommentDraft,
	type GitTreeNode,
	type GitWorkbenchSnapshotResponse,
	type GitWorktreeItem,
} from '$lib/api/git.js';
import { GitCommitController } from './git/git-commit-controller.svelte';
import {
	decodeLineSelectionKey,
	encodeLineSelectionKey,
	GitLineSelectionState,
	makeLineSelectionKey,
} from './git/git-line-selection.svelte';
import { GitReviewDrafts, type CommentComposerState } from './git/git-review-drafts.svelte';
import { GitPorcelainState } from './git/git-porcelain.svelte';
import { GitStagingActions } from './git/git-staging-actions.svelte';
import { GitTreeState } from './git/git-tree-state.svelte';
import {
	DEFAULT_REFRESH_OPTIONS,
	targetKey,
	type DiffMode,
	type GitDiffActionTarget,
	type GitWorkbenchDeps,
	type GitWorkbenchMutationRunner,
	type GitWorkbenchRefreshOptions,
	type GitWorkbenchTarget,
} from './git/git-workbench-types';
import { GitWorktrees } from './git/git-worktrees.svelte';
import {
	GitVirtualReviewDocumentController,
	type GitVirtualReviewRow,
} from './git/git-virtual-review-document.svelte';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export type { GitDiffTab } from '$lib/api/git.js';
export type {
	DiffMode,
	GitDiffActionMode,
	GitDiffActionTarget,
	GitLineSelectionKey,
	GitWorkbenchDeps,
	GitWorkbenchRefreshOptions,
	GitWorkbenchTarget,
} from './git/git-workbench-types';
export type { GitVirtualReviewRow } from './git/git-virtual-review-document.svelte';
export { decodeLineSelectionKey, encodeLineSelectionKey, makeLineSelectionKey };

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

function filterTreeForWorkbench(
	nodes: GitTreeNode[],
	shouldKeepFile: (node: GitTreeNode) => boolean,
): GitTreeNode[] {
	const result: GitTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'file') {
			if (shouldKeepFile(node)) result.push(node);
			continue;
		}
		const children = node.children ? filterTreeForWorkbench(node.children, shouldKeepFile) : [];
		if (children.length > 0) {
			result.push({
				...node,
				staged: children.some((child) => child.staged),
				hasUnstaged: children.some((child) => child.hasUnstaged || child.changeKind === 'untracked'),
				children,
			});
		}
	}
	return result;
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
	private readonly commitController: GitCommitController;
	private readonly reviewDrafts: GitReviewDrafts;
	private readonly worktreeController: GitWorktrees;
	private readonly porcelainController: GitPorcelainState;

	private diffModeValue = $state<DiffMode>('unified');
	private contextLinesValue = $state(5);
	private activeTabValue = $state<GitDiffTab>('unstaged');
	private selectedFileValue = $state<string | null>(null);
	private lastErrorValue = $state<string | null>(null);
	private repositoryErrorValue = $state<string | null>(null);
	private hasCompletedInitialLoadValue = $state(false);
	private hideGeneratedValue = $state(false);
	private hideOtherTabFilesValue = $state(false);
	loadedWorkbenchFingerprint = $state<string | null>(null);
	latestWorkbenchFingerprint = $state<string | null>(null);
	isExternallyStale = $state(false);
	isCheckingFreshness = $state(false);
	freshnessError = $state<string | null>(null);
	isReconcilingLocalGitMutation = $state(false);

	constructor(deps?: GitWorkbenchDeps) {
		const resolvedDeps =
			deps ??
			({
				getSettings: async () => {
					const { getRemoteSettings } = await import('$lib/api/settings.js');
					const snap = await getRemoteSettings();
					return {
						ui: snap.ui as Record<string, unknown>,
						uiEffective: snap.uiEffective as Record<string, unknown>,
					};
				},
			} satisfies GitWorkbenchDeps);

		this.treeState = new GitTreeState();
		this.virtualReview = new GitVirtualReviewDocumentController({
			targetKey: () => targetKey(this.target),
			targetProjectPath: () => this.target?.projectPath ?? null,
			activeTab: () => this.activeTab,
			diffMode: () => this.diffMode,
			contextLines: () => this.contextLines,
			visibleFilePaths: () => this.visibleFilePaths,
			selectedFile: () => this.selectedFile,
			selectedLineKeys: () => this.selectedLineKeys,
			commentsByFile: () => this.commentsByFile,
			composerState: () => this.commentComposer,
			surfaceError: (message) => this.surfaceError(message),
			markExternallyStale: () => this.markExternallyStale(),
		});
		this.lineSelection = new GitLineSelectionState();
		this.stagingActions = new GitStagingActions({
			selectedFile: () => this.selectedFile,
			activeTab: () => this.activeTab,
			contextLines: () => this.contextLines,
			visibleFilePaths: () => this.visibleFilePaths,
			lineSelection: this.lineSelection,
			findTreeNode: (filePath) => this.findTreeNode(filePath),
			setSelectedFile: (filePath) => {
				this.selectedFile = filePath;
			},
			refreshAllData: () => this.refreshAllData(),
			refreshFileAfterStage: (projectPath, filePath) =>
				this.refreshFileAfterStage(projectPath, filePath),
			refreshAfterGitAction: (projectPath, options) =>
				this.refreshAfterGitAction(projectPath, options),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			runGitMutation: this.runLocalGitMutation,
		});
		this.commitController = new GitCommitController({
			...resolvedDeps,
			stagedFiles: () => this.stagedFiles,
			visibleFilePaths: () => this.visibleFilePaths,
			selectedFile: () => this.selectedFile,
			setSelectedFile: (filePath) => {
				this.selectedFile = filePath;
			},
			openFile: (projectPath, filePath) => this.openFile(projectPath, filePath),
			refreshAllData: () => this.refreshAllData(),
			refreshAfterGitAction: (projectPath, options) =>
				this.refreshAfterGitAction(projectPath, options),
			setHasCommits: (hasCommits) => {
				this.hasCommits = hasCommits;
			},
			surfaceError: (message) => this.surfaceError(message),
			runGitMutation: this.runLocalGitMutation,
		});
		this.reviewDrafts = new GitReviewDrafts();
		this.worktreeController = new GitWorktrees({
			surfaceError: (message) => this.surfaceError(message),
		});
		this.porcelainController = new GitPorcelainState({
			selectedFile: () => this.selectedFile,
			refreshAfterMutation: (projectPath) =>
				this.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preferSelectedFile: true,
				}),
			surfaceError: (message) => this.surfaceError(message),
			ensureFreshForGitMutation: () => this.ensureFreshForGitMutation(),
			runGitMutation: this.runLocalGitMutation,
		});

		this.loadTreePaneWidth();
		this.loadHideOtherTabFiles();
		void this.hydrateCommitSettings();
	}

	get projectPath(): string | null {
		return this.target?.projectPath ?? null;
	}

	get hasTarget(): boolean {
		return Boolean(this.target);
	}

	get tree(): GitTreeNode[] {
		return this.treeState.tree;
	}

	set tree(value: GitTreeNode[]) {
		this.treeState.applyTree(value);
	}

	get isLoadingTree(): boolean {
		return this.treeState.isLoadingTree;
	}

	set isLoadingTree(value: boolean) {
		this.treeState.isLoadingTree = value;
	}

	get isInitialLoadPending(): boolean {
		return Boolean(this.target) && !this.hasCompletedInitialLoadValue;
	}

	get treeSearchQuery(): string {
		return this.treeState.treeSearchQuery;
	}

	set treeSearchQuery(value: string) {
		this.treeState.treeSearchQuery = value;
	}

	get hasCommits(): boolean {
		return this.treeState.hasCommits;
	}

	set hasCommits(value: boolean) {
		this.treeState.hasCommits = value;
	}

	get selectedFile(): string | null {
		return this.selectedFileValue;
	}

	set selectedFile(value: string | null) {
		this.selectedFileValue = value;
	}

	get diffScrollRequest(): { filePath: string; token: number } | null {
		return this.virtualReview.scrollRequest;
	}

	set diffScrollRequest(value: { filePath: string; token: number } | null) {
		this.virtualReview.scrollRequest = value;
	}

	get isLoadingFile(): boolean {
		return this.virtualReview.hasLoading;
	}

	get diffMode(): DiffMode {
		return this.diffModeValue;
	}

	set diffMode(value: DiffMode) {
		this.diffModeValue = value;
	}

	get contextLines(): number {
		return this.contextLinesValue;
	}

	set contextLines(value: number) {
		this.contextLinesValue = value;
	}

	get activeTab(): GitDiffTab {
		return this.activeTabValue;
	}

	set activeTab(value: GitDiffTab) {
		this.activeTabValue = value;
	}

	get selectedLineKeys(): Set<string> {
		return this.lineSelection.selectedLineKeys;
	}

	set selectedLineKeys(value: Set<string>) {
		this.lineSelection.selectedLineKeys = value;
	}

	get collapsedDirs(): Set<string> {
		return this.treeState.collapsedDirs;
	}

	set collapsedDirs(value: Set<string>) {
		this.treeState.collapsedDirs = value;
	}

	get treePaneWidthPx(): number {
		return this.treeState.treePaneWidthPx;
	}

	set treePaneWidthPx(value: number) {
		this.treeState.treePaneWidthPx = value;
	}

	get reviewComments(): GitReviewCommentDraft[] {
		return this.reviewDrafts.reviewComments;
	}

	set reviewComments(value: GitReviewCommentDraft[]) {
		this.reviewDrafts.reviewComments = value;
	}

	get reviewSummary(): string {
		return this.reviewDrafts.reviewSummary;
	}

	set reviewSummary(value: string) {
		this.reviewDrafts.reviewSummary = value;
	}

	get reviewModalOpen(): boolean {
		return this.reviewDrafts.reviewModalOpen;
	}

	set reviewModalOpen(value: boolean) {
		this.reviewDrafts.reviewModalOpen = value;
	}

	get commentComposer(): CommentComposerState {
		return this.reviewDrafts.commentComposer;
	}

	set commentComposer(value: CommentComposerState) {
		this.reviewDrafts.commentComposer = value;
	}

	get commitMessage(): string {
		return this.commitController.commitMessage;
	}

	set commitMessage(value: string) {
		this.commitController.commitMessage = value;
	}

	get isCommitting(): boolean {
		return this.commitController.isCommitting;
	}

	set isCommitting(value: boolean) {
		this.commitController.isCommitting = value;
	}

	get isGeneratingMessage(): boolean {
		return this.commitController.isGeneratingMessage;
	}

	set isGeneratingMessage(value: boolean) {
		this.commitController.isGeneratingMessage = value;
	}

	get isCreatingInitialCommit(): boolean {
		return this.commitController.isCreatingInitialCommit;
	}

	set isCreatingInitialCommit(value: boolean) {
		this.commitController.isCreatingInitialCommit = value;
	}

	get commitGenerationEnabled(): boolean {
		return this.commitController.commitGenerationEnabled;
	}

	set commitGenerationEnabled(value: boolean) {
		this.commitController.commitGenerationEnabled = value;
	}

	get pendingDiscardFile(): string | null {
		return this.stagingActions.pendingDiscardFile;
	}

	set pendingDiscardFile(value: string | null) {
		this.stagingActions.pendingDiscardFile = value;
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

	get worktrees(): GitWorktreeItem[] {
		return this.worktreeController.worktrees;
	}

	set worktrees(value: GitWorktreeItem[]) {
		this.worktreeController.worktrees = value;
	}

	get isLoadingWorktrees(): boolean {
		return this.worktreeController.isLoadingWorktrees;
	}

	set isLoadingWorktrees(value: boolean) {
		this.worktreeController.isLoadingWorktrees = value;
	}

	get virtualReviewRows(): GitVirtualReviewRow[] {
		return this.virtualReview.virtualRows;
	}

	get virtualReviewFileRowIndex(): Map<string, number> {
		return this.virtualReview.fileRowIndex;
	}

	get virtualReviewScrollRequest(): { filePath: string; token: number } | null {
		return this.virtualReview.scrollRequest;
	}

	get porcelain(): GitPorcelainState {
		return this.porcelainController;
	}

	get filteredTree(): GitTreeNode[] {
		return filterTreeForWorkbench(this.treeState.filteredTree, (node) =>
			this.shouldShowFileNode(node),
		);
	}

	get commentsByFile(): Record<string, GitReviewCommentDraft[]> {
		return this.reviewDrafts.commentsByFile;
	}

	get totalChangedFiles(): number {
		return this.treeState.totalChangedFiles;
	}

	get visibleChangedFiles(): number {
		return this.visibleFilePaths.length;
	}

	get visibleFilePaths(): string[] {
		return this.treeState
			.visibleFilePaths(this.activeTab)
			.filter((filePath) => this.shouldShowFilePath(filePath));
	}

	get hideGenerated(): boolean {
		return this.hideGeneratedValue;
	}

	get hideOtherTabFiles(): boolean {
		return this.hideOtherTabFilesValue;
	}

	get hideOtherTabFilesLabel(): string {
		return this.activeTab === 'unstaged' ? 'Hide staged' : 'Hide unstaged';
	}

	get unstagedFileCount(): number {
		return this.treeState.unstagedFileCount();
	}

	get stagedFileCount(): number {
		return this.treeState.stagedFileCount();
	}

	get hasSelection(): boolean {
		return this.lineSelection.hasSelection;
	}

	get hasPendingOperation(): boolean {
		return this.stagingActions.hasPendingOperations;
	}

	get stagedFiles(): string[] {
		return this.treeState.stagedFiles;
	}

	get stagedFileNodes(): GitTreeNode[] {
		return this.treeState.stagedFileNodes;
	}

	async setTarget(nextTarget: GitWorkbenchTarget | null): Promise<void> {
		const nextKey = targetKey(nextTarget);
		if (nextKey === this.lastTargetKey) {
			this.target = nextTarget;
			if (nextTarget && this.tree.length === 0 && !this.isLoadingTree && !this.repositoryError) {
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

	commentsForFile(filePath: string): GitReviewCommentDraft[] {
		return this.reviewDrafts.commentsForFile(filePath);
	}

	dismissError(): void {
		this.lastError = null;
	}

	reportError(message: string): void {
		this.surfaceError(message);
	}

	setTreePaneWidth(next: number): void {
		this.treeState.setTreePaneWidth(next);
	}

	loadTreePaneWidth(): void {
		this.treeState.loadTreePaneWidth();
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
			return await action();
		} finally {
			this.endLocalGitMutation(projectPath);
		}
	};

	toggleDirCollapsed(dirPath: string): void {
		this.treeState.toggleDirCollapsed(dirPath);
	}

	async openFile(projectPath: string, filePath: string): Promise<void> {
		this.selectedFile = filePath;
		this.clearSelection();
		this.virtualReview.focusFile(projectPath, filePath);
	}

	requestDiffScrollToFile(filePath: string): void {
		if (this.projectPath) this.virtualReview.requestBodies(this.projectPath, [filePath]);
		this.virtualReview.requestScrollToFile(filePath);
	}

	firstVisibleFileInDirectory(dirPath: string): string | null {
		if (!dirPath) return null;
		const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
		for (const filePath of this.visibleFilePaths) {
			if (filePath.startsWith(prefix)) return filePath;
		}
		return null;
	}

	preferredTabForFile(filePath: string): GitDiffTab | null {
		const node = this.findTreeNode(filePath);
		if (!node) return null;
		if (this.activeTab === 'unstaged' && (node.hasUnstaged || node.changeKind === 'untracked'))
			return 'unstaged';
		if (this.activeTab === 'staged' && node.staged) return 'staged';
		if (node.hasUnstaged || node.changeKind === 'untracked') return 'unstaged';
		if (node.staged) return 'staged';
		return null;
	}

	async selectFile(projectPath: string, filePath: string): Promise<void> {
		const nextTab = this.preferredTabForFile(filePath);
		if (!nextTab) {
			this.surfaceError(`File is not available in the current Git target: ${filePath}`);
			return;
		}
		if (this.activeTab !== nextTab) this.setActiveTab(nextTab);
		await this.openFile(projectPath, filePath);
	}

	async loadFileReviewData(projectPath: string, filePath: string): Promise<void> {
		this.virtualReview.focusFile(projectPath, filePath);
	}

	requestFilesLoaded(projectPath: string, filePaths: string[]): void {
		this.virtualReview.requestBodies(projectPath, filePaths);
	}

	handleVisibleReviewRows(projectPath: string, rows: GitVirtualReviewRow[]): void {
		this.virtualReview.setVisibleRows(projectPath, rows);
	}

	refreshAllData(): void {
		this.virtualReview.refreshAllData();
		if (this.target)
			void this.refresh({
				reason: 'manual',
				preserveSelection: true,
				preferSelectedFile: true,
			});
	}

	setActiveTab(tab: GitDiffTab): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;
		this.clearSelection();
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
		this.hideGeneratedValue = value;
		this.ensureSelectedFileIsVisible();
	}

	setHideOtherTabFiles(value: boolean): void {
		this.hideOtherTabFilesValue = value;
		setLocalStorageItem(LOCAL_STORAGE_KEYS.gitHideOtherTabFiles, value ? 'true' : 'false');
		this.ensureSelectedFileIsVisible();
	}

	nextVisibleFile(): string | null {
		const paths = this.visibleFilePaths;
		if (paths.length === 0) return null;
		const currentIndex = this.selectedFile ? paths.indexOf(this.selectedFile) : -1;
		return paths[Math.min(paths.length - 1, currentIndex + 1)] ?? null;
	}

	previousVisibleFile(): string | null {
		const paths = this.visibleFilePaths;
		if (paths.length === 0) return null;
		const currentIndex = this.selectedFile ? paths.indexOf(this.selectedFile) : 0;
		return paths[Math.max(0, currentIndex - 1)] ?? null;
	}

	async selectNextFile(projectPath: string): Promise<boolean> {
		const next = this.nextVisibleFile();
		if (!next || next === this.selectedFile) return false;
		await this.selectFile(projectPath, next);
		return true;
	}

	async selectPreviousFile(projectPath: string): Promise<boolean> {
		const previous = this.previousVisibleFile();
		if (!previous || previous === this.selectedFile) return false;
		await this.selectFile(projectPath, previous);
		return true;
	}

	setDiffMode(mode: DiffMode): void {
		this.diffMode = mode;
	}

	setContextLines(lines: number): void {
		this.contextLines = lines;
		this.virtualReview.clearForDisplayChange();
		if (this.target)
			void this.refresh({
				reason: 'context-change',
				preserveSelection: true,
				preferSelectedFile: true,
			});
	}

	toggleLineSelection(key: string): void {
		this.lineSelection.toggleLineSelection(key);
	}

	selectLineRange(startKey: string, endKey: string, allKeys: string[]): void {
		this.lineSelection.selectLineRange(startKey, endKey, allKeys);
	}

	clearSelection(): void {
		this.lineSelection.clearSelection();
	}

	async stageSelectedLines(projectPath: string): Promise<boolean> {
		return this.stagingActions.stageSelectedLines(projectPath);
	}

	async unstageSelectedLines(projectPath: string): Promise<boolean> {
		return this.stagingActions.unstageSelectedLines(projectPath);
	}

	async stageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stagingActions.stageLine(projectPath, target, diffLineIndex);
	}

	async unstageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stagingActions.unstageLine(projectPath, target, diffLineIndex);
	}

	async stageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		return this.stagingActions.stageHunk(projectPath, targetOrHunkIndex, maybeHunkIndex);
	}

	async unstageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		return this.stagingActions.unstageHunk(projectPath, targetOrHunkIndex, maybeHunkIndex);
	}

	async stageFile(projectPath: string, filePath: string): Promise<boolean> {
		return this.stagingActions.stageFile(projectPath, filePath);
	}

	async unstageFile(projectPath: string, filePath: string): Promise<boolean> {
		return this.stagingActions.unstageFile(projectPath, filePath);
	}

	async stageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		return this.stagingActions.stageDirectory(projectPath, dirPath);
	}

	async unstageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		return this.stagingActions.unstageDirectory(projectPath, dirPath);
	}

	isStageFilePending(filePath: string): boolean {
		return this.stagingActions.isFilePending(filePath, 'stage');
	}

	isUnstageFilePending(filePath: string): boolean {
		return this.stagingActions.isFilePending(filePath, 'unstage');
	}

	isStageDirectoryPending(dirPath: string): boolean {
		return this.stagingActions.isDirectoryPending(dirPath, 'stage');
	}

	isUnstageDirectoryPending(dirPath: string): boolean {
		return this.stagingActions.isDirectoryPending(dirPath, 'unstage');
	}

	requestDiscard(filePath: string): void {
		this.stagingActions.requestDiscard(filePath);
	}

	cancelDiscard(): void {
		this.stagingActions.cancelDiscard();
	}

	async confirmDiscard(projectPath: string): Promise<boolean> {
		return this.stagingActions.confirmDiscard(projectPath);
	}

	async commitIndex(projectPath: string): Promise<boolean> {
		if (!this.ensureFreshForGitMutation()) return false;
		return this.commitController.commitIndex(projectPath);
	}

	async createInitialCommit(projectPath: string): Promise<boolean> {
		if (!this.ensureFreshForGitMutation()) return false;
		return this.commitController.createInitialCommit(projectPath);
	}

	async generateCommitMsg(projectPath: string): Promise<void> {
		await this.commitController.generateCommitMsg(projectPath, () => this.hydrateCommitSettings());
	}

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
		this.reviewDrafts.openCommentComposer(filePath, side, line);
	}

	commitCommentComposer(): void {
		this.reviewDrafts.commitCommentComposer();
	}

	closeCommentComposer(): void {
		this.reviewDrafts.closeCommentComposer();
	}

	addDraftComment(input: Omit<GitReviewCommentDraft, 'id' | 'createdAt'>): void {
		this.reviewDrafts.addDraftComment(input);
	}

	updateDraftComment(id: string, patch: Partial<GitReviewCommentDraft>): void {
		this.reviewDrafts.updateDraftComment(id, patch);
	}

	removeDraftComment(id: string): void {
		this.reviewDrafts.removeDraftComment(id);
	}

	buildFinalizedReviewMessage(): string {
		return this.reviewDrafts.buildFinalizedReviewMessage();
	}

	async finalizeReviewToAgent(send: (message: string) => Promise<boolean>): Promise<boolean> {
		return this.reviewDrafts.finalizeReviewToAgent(send);
	}

	async loadWorktrees(projectPath: string): Promise<void> {
		await this.worktreeController.loadWorktrees(projectPath);
	}

	async createWorktree(
		projectPath: string,
		worktreePath: string,
		options: { baseRef?: string; branch?: string; detach?: boolean } = {},
	): Promise<boolean> {
		return this.worktreeController.createWorktree(projectPath, worktreePath, options);
	}

	async removeWorktree(projectPath: string, worktreePath: string, force = false): Promise<boolean> {
		return this.worktreeController.removeWorktree(projectPath, worktreePath, force);
	}

	async revertCommit(projectPath: string, commit: string): Promise<boolean> {
		if (!this.ensureFreshForGitMutation()) return false;
		return this.commitController.revertCommit(projectPath, commit);
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
		const requestTab = this.activeTab;
		const requestContext = this.contextLines;
		const previousSelectedFile = this.selectedFile;
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
			this.selectedFile = null;
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
			this.selectedFile = null;
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

		const visible = this.visibleFilePaths;
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

		this.selectedFile =
			preservedSelection ??
			selectedFromSnapshot ??
			(options.preserveSelection && this.selectedFile && visible.includes(this.selectedFile)
				? this.selectedFile
				: (visible[0] ?? null));

		const bodyCandidates = uniquePaths([this.selectedFile, ...snapshot.firstBodyCandidates]).filter(
			(filePath) => visible.includes(filePath),
		);
		if (bodyCandidates.length > 0)
			this.virtualReview.requestBodies(target.projectPath, bodyCandidates);
	}

	private async refreshFileAfterStage(projectPath: string, filePath: string): Promise<void> {
		this.virtualReview.invalidateFile(filePath);
		await this.refreshAfterGitAction(projectPath, {
			reason: 'git-action',
			preferSelectedFile: true,
		});
		const visibleFilePaths = this.visibleFilePaths;
		if (this.selectedFile === filePath && !visibleFilePaths.includes(filePath)) {
			this.selectedFile = visibleFilePaths[0] ?? null;
			return;
		}
		if (this.selectedFile === filePath && this.treeState.hasFile(filePath)) {
			this.virtualReview.focusFile(projectPath, filePath);
		}
	}

	private async refreshAfterGitAction(
		_projectPath: string,
		options: GitWorkbenchRefreshOptions,
	): Promise<void> {
		if (this.target) await this.refresh(options);
	}

	private findTreeNode(filePath: string): GitTreeNode | undefined {
		return this.treeState.findTreeNode(filePath);
	}

	private async hydrateCommitSettings(): Promise<void> {
		await this.commitController.hydrateCommitSettings();
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
		if (this.activeTab !== tab) return false;
		if (this.contextLines !== contextLines) return false;
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
		if (this.selectedFile && this.preferredTabForFile(this.selectedFile) === this.activeTab) return;
		this.selectedFile = this.visibleFilePaths[0] ?? null;
	}

	private ensureSelectedFileIsVisible(): void {
		if (this.selectedFile && this.visibleFilePaths.includes(this.selectedFile)) return;
		this.selectedFile = this.visibleFilePaths[0] ?? null;
	}

	private shouldShowFilePath(filePath: string): boolean {
		const node = this.findTreeNode(filePath);
		if (!node) return false;
		if (!this.shouldShowFileCategory(node)) return false;
		return true;
	}

	private shouldShowFileNode(node: GitTreeNode): boolean {
		if (!this.shouldShowFileCategory(node)) return false;
		if (this.hideOtherTabFiles && !this.isFileRelevantToActiveTab(node)) return false;
		return true;
	}

	private shouldShowFileCategory(node: GitTreeNode): boolean {
		if (!this.hideGenerated) return true;
		return node.category !== 'generated' && node.category !== 'lockfile';
	}

	private isFileRelevantToActiveTab(node: GitTreeNode): boolean {
		if (this.activeTab === 'staged') return Boolean(node.staged);
		return Boolean(node.hasUnstaged || node.changeKind === 'untracked');
	}

	private loadHideOtherTabFiles(): void {
		this.hideOtherTabFilesValue =
			getLocalStorageItem(LOCAL_STORAGE_KEYS.gitHideOtherTabFiles) === 'true';
	}

	private resetForTargetChange(): void {
		this.clearLocalGitMutationState();
		this.clearFreshnessState();
		this.treeState.reset();
		this.virtualReview.reset();
		this.selectedFile = null;
		this.lineSelection.reset();
		this.stagingActions.reset();
		this.hideGeneratedValue = false;
		this.reviewDrafts.reset();
		this.commitController.resetForTargetChange();
		this.worktreeController.reset();
		this.porcelainController.reset();
		this.activeTab = 'unstaged';
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

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}

function uniquePaths(paths: Array<string | null>): string[] {
	return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}
