import type {
	GitDiffTab,
	GitFileReviewData,
	GitReviewCommentDraft,
	GitTreeNode,
	GitWorktreeItem,
} from '$lib/api/git.js';
import type { SessionAgentId } from '$lib/types/app.js';
import type { ApiProtocol } from '$shared/api-providers';
import { GitCommitController } from './git/git-commit-controller.svelte';
import {
	decodeLineSelectionKey,
	encodeLineSelectionKey,
	GitLineSelectionState,
	makeLineSelectionKey,
} from './git/git-line-selection.svelte';
import { GitReviewDataLoader } from './git/git-review-data-loader.svelte';
import { GitReviewDrafts, type CommentComposerState } from './git/git-review-drafts.svelte';
import { GitStagingActions } from './git/git-staging-actions.svelte';
import { GitTreeState } from './git/git-tree-state.svelte';
import {
	DEFAULT_REFRESH_OPTIONS,
	targetKey,
	type DiffMode,
	type GitDiffActionTarget,
	type GitWorkbenchDeps,
	type GitWorkbenchRefreshOptions,
	type GitWorkbenchTarget,
} from './git/git-workbench-types';
import { GitWorktrees } from './git/git-worktrees.svelte';

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
export { decodeLineSelectionKey, encodeLineSelectionKey, makeLineSelectionKey };

export class GitWorkbenchStore {
	target = $state<GitWorkbenchTarget | null>(null);

	private lastTargetKey = '';
	private refreshGeneration = 0;
	private scheduledRefresh: ReturnType<typeof setTimeout> | null = null;
	private refreshPromise: Promise<void> | null = null;
	private treeLoadGeneration = 0;
	private scrollPositions = new Map<string, number>();

	private readonly treeState: GitTreeState;
	private readonly reviewLoader: GitReviewDataLoader;
	private readonly lineSelection: GitLineSelectionState;
	private readonly stagingActions: GitStagingActions;
	private readonly commitController: GitCommitController;
	private readonly reviewDrafts: GitReviewDrafts;
	private readonly worktreeController: GitWorktrees;

	private diffModeValue = $state<DiffMode>('unified');
	private contextLinesValue = $state(5);
	private activeTabValue = $state<GitDiffTab>('unstaged');
	private lastErrorValue = $state<string | null>(null);

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
		this.reviewLoader = new GitReviewDataLoader({
			targetKey: () => targetKey(this.target),
			targetProjectPath: () => this.target?.projectPath ?? null,
			activeTab: () => this.activeTab,
			contextLines: () => this.contextLines,
			surfaceError: (message) => this.surfaceError(message),
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
		});
		this.reviewDrafts = new GitReviewDrafts();
		this.worktreeController = new GitWorktrees({
			surfaceError: (message) => this.surfaceError(message),
		});

		this.loadTreePaneWidth();
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
		this.treeState.tree = value;
	}

	get isLoadingTree(): boolean {
		return this.treeState.isLoadingTree;
	}

	set isLoadingTree(value: boolean) {
		this.treeState.isLoadingTree = value;
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
		return this.reviewLoader.selectedFile;
	}

	set selectedFile(value: string | null) {
		this.reviewLoader.selectedFile = value;
	}

	get diffScrollRequest(): { filePath: string; token: number } | null {
		return this.reviewLoader.diffScrollRequest;
	}

	set diffScrollRequest(value: { filePath: string; token: number } | null) {
		this.reviewLoader.diffScrollRequest = value;
	}

	get reviewDataByPath(): Record<string, GitFileReviewData> {
		return this.reviewLoader.reviewDataByPath;
	}

	set reviewDataByPath(value: Record<string, GitFileReviewData>) {
		this.reviewLoader.reviewDataByPath = value;
	}

	get isLoadingFile(): boolean {
		return this.reviewLoader.isLoadingFile;
	}

	set isLoadingFile(value: boolean) {
		this.reviewLoader.isLoadingFile = value;
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

	get commitAgentId(): SessionAgentId {
		return this.commitController.commitAgentId;
	}

	set commitAgentId(value: SessionAgentId) {
		this.commitController.commitAgentId = value;
	}

	get commitModel(): string {
		return this.commitController.commitModel;
	}

	set commitModel(value: string) {
		this.commitController.commitModel = value;
	}

	get commitApiProviderId(): string | null {
		return this.commitController.commitApiProviderId;
	}

	set commitApiProviderId(value: string | null) {
		this.commitController.commitApiProviderId = value;
	}

	get commitModelEndpointId(): string | null {
		return this.commitController.commitModelEndpointId;
	}

	set commitModelEndpointId(value: string | null) {
		this.commitController.commitModelEndpointId = value;
	}

	get commitModelProtocol(): ApiProtocol | null {
		return this.commitController.commitModelProtocol;
	}

	set commitModelProtocol(value: ApiProtocol | null) {
		this.commitController.commitModelProtocol = value;
	}

	get commitCustomPrompt(): string {
		return this.commitController.commitCustomPrompt;
	}

	set commitCustomPrompt(value: string) {
		this.commitController.commitCustomPrompt = value;
	}

	get commitUseCommonDirPrefix(): boolean {
		return this.commitController.commitUseCommonDirPrefix;
	}

	set commitUseCommonDirPrefix(value: boolean) {
		this.commitController.commitUseCommonDirPrefix = value;
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

	get currentReviewData(): GitFileReviewData | null {
		return this.reviewLoader.currentReviewData;
	}

	get filteredTree(): GitTreeNode[] {
		return this.treeState.filteredTree;
	}

	get commentsByFile(): Record<string, GitReviewCommentDraft[]> {
		return this.reviewDrafts.commentsByFile;
	}

	get totalChangedFiles(): number {
		return this.treeState.totalChangedFiles;
	}

	get visibleFilePaths(): string[] {
		return this.treeState.visibleFilePaths(this.activeTab);
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

	get stagedFiles(): string[] {
		return this.treeState.stagedFiles;
	}

	get stagedFileNodes(): GitTreeNode[] {
		return this.treeState.stagedFileNodes;
	}

	get commonDirPrefix(): string {
		return this.commitController.commonDirPrefix;
	}

	async setTarget(nextTarget: GitWorkbenchTarget | null): Promise<void> {
		const nextKey = targetKey(nextTarget);
		if (nextKey === this.lastTargetKey) {
			this.target = nextTarget;
			if (nextTarget && this.tree.length === 0) await this.refresh({ reason: 'mount' });
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

	async loadTree(projectPath: string): Promise<boolean> {
		const generation = ++this.treeLoadGeneration;
		const key = targetKey(this.target);
		return this.treeState.loadTree(projectPath, {
			isCurrent: () => this.isCurrentTreeLoad(projectPath, generation, key),
			surfaceError: (message) => this.surfaceError(message),
		});
	}

	scheduleRefresh(options: GitWorkbenchRefreshOptions, delayMs = 350): void {
		if (this.scheduledRefresh) clearTimeout(this.scheduledRefresh);
		this.scheduledRefresh = setTimeout(() => {
			this.scheduledRefresh = null;
			void this.refresh(options);
		}, delayMs);
	}

	async refresh(options: GitWorkbenchRefreshOptions): Promise<void> {
		if (this.refreshPromise) await this.refreshPromise;
		this.refreshPromise = this.refreshNow(options);
		try {
			await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	toggleDirCollapsed(dirPath: string): void {
		this.treeState.toggleDirCollapsed(dirPath);
	}

	async openFile(projectPath: string, filePath: string): Promise<void> {
		this.selectedFile = filePath;
		this.clearSelection();
		await this.loadFileReviewData(projectPath, filePath);
	}

	requestDiffScrollToFile(filePath: string): void {
		this.reviewLoader.requestDiffScrollToFile(filePath);
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
		this.requestDiffScrollToFile(filePath);
	}

	async loadFileReviewData(projectPath: string, filePath: string): Promise<void> {
		await this.reviewLoader.loadFileReviewData(projectPath, filePath);
	}

	requestFilesLoaded(projectPath: string, filePaths: string[]): void {
		this.reviewLoader.requestFilesLoaded(projectPath, filePaths);
	}

	refreshAllData(): void {
		this.reviewLoader.refreshAllData();
	}

	setActiveTab(tab: GitDiffTab): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;
		this.clearSelection();
		this.reviewLoader.clearForDisplayChange();
	}

	setDiffMode(mode: DiffMode): void {
		this.diffMode = mode;
	}

	setContextLines(lines: number): void {
		this.contextLines = lines;
		this.reviewLoader.clearForDisplayChange();
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
		return this.commitController.commitIndex(projectPath);
	}

	async createInitialCommit(projectPath: string): Promise<boolean> {
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

	async revertLastCommit(
		projectPath: string,
		strategy: 'revert' | 'reset-soft' = 'revert',
	): Promise<boolean> {
		return this.commitController.revertLastCommit(projectPath, strategy);
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
		const effective = { ...DEFAULT_REFRESH_OPTIONS, ...options };
		const generation = ++this.refreshGeneration;
		const previousSelectedFile = this.selectedFile;

		const loadedTree = await this.loadTree(target.projectPath);
		if (
			!loadedTree ||
			generation !== this.refreshGeneration ||
			targetKey(this.target) !== targetKey(target)
		)
			return;

		const paths = new Set(this.treeState.filePaths);
		this.reviewLoader.pruneToFilePaths(paths);
		this.lineSelection.pruneToFilePaths(paths);

		if (
			effective.preserveSelection &&
			effective.preferSelectedFile &&
			previousSelectedFile &&
			this.treeState.hasFile(previousSelectedFile)
		) {
			this.selectedFile = previousSelectedFile;
			await this.loadFileReviewData(target.projectPath, previousSelectedFile);
			return;
		}

		if (
			!effective.preserveSelection ||
			!this.selectedFile ||
			!this.treeState.hasFile(this.selectedFile)
		) {
			const first = this.visibleFilePaths[0] ?? null;
			this.selectedFile = first;
			if (first) await this.loadFileReviewData(target.projectPath, first);
		}
	}

	private async refreshFileAfterStage(projectPath: string, filePath: string): Promise<void> {
		this.reviewLoader.invalidateFile(filePath);
		this.reviewLoader.removeFileData(filePath);
		await this.refreshAfterGitAction(projectPath, {
			reason: 'git-action',
			preferSelectedFile: true,
		});
		if (this.treeState.hasFile(filePath)) await this.loadFileReviewData(projectPath, filePath);
	}

	private async refreshAfterGitAction(
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	): Promise<void> {
		if (this.target) await this.refresh(options);
		else await this.loadTree(projectPath);
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

	private isCurrentTreeLoad(projectPath: string, generation: number, key: string): boolean {
		if (generation !== this.treeLoadGeneration) return false;
		if (key !== targetKey(this.target)) return false;
		return !this.target || this.target.projectPath === projectPath;
	}

	private resetForTargetChange(): void {
		this.treeState.reset();
		this.reviewLoader.reset();
		this.lineSelection.reset();
		this.stagingActions.reset();
		this.reviewDrafts.reset();
		this.commitController.resetForTargetChange();
		this.worktreeController.reset();
		this.activeTab = 'unstaged';
		this.lastError = null;
		this.scrollPositions.clear();
		this.treeLoadGeneration++;
	}
}
