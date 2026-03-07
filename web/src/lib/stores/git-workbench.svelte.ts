// Reactive store for the Git workbench V2. Owns tree state, file review
// data, diff mode, line selection, review comment drafts, and staging
// actions. Components bind to this store for all workbench behavior.

import {
	type GitTreeNode,
	type GitFileReviewData,
	type GitReviewCommentDraft,
	type GitWorktreeItem,
	type GitDiffTab,
	getGitChangesTree,
	getGitFileReviewData,
	gitStageSelection,
	gitStageHunk,
	gitStageFile,
	gitCommitIndex,
	gitInitialCommit,
	generateCommitMessage as generateCommitMessageApi,
	getGitWorktrees,
	gitCreateWorktree,
	gitRemoveWorktree,
	gitRevertLastCommit,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import {
	computeCommonDirPrefix as computeCommonDirPrefixSync,
	applyDirPrefix,
} from '$lib/utils/common-prefix.js';

export type DiffMode = 'unified' | 'split';
export type { GitDiffTab } from '$lib/api/git.js';

export interface GitWorkbenchStoreOptions {
	/** Reactive getter for the active provider name. */
	get provider(): string;
}

/** Injectable dependencies for testing. Defaults load the real
 *  settings API when not overridden. */
export interface GitWorkbenchDeps {
	getSettings: () => Promise<{
		ui?: Record<string, unknown>;
		uiEffective?: Record<string, unknown>;
	}>;
}

export class GitWorkbenchStore {
	// File tree
	tree = $state<GitTreeNode[]>([]);
	isLoadingTree = $state(false);
	treeSearchQuery = $state('');
	hasCommits = $state(true);

	// Selected file and review data
	selectedFile = $state<string | null>(null);
	diffScrollRequest = $state<{ filePath: string; token: number } | null>(null);
	reviewDataByPath = $state<Record<string, GitFileReviewData>>({});
	isLoadingFile = $state(false);

	// Diff display settings
	diffMode = $state<DiffMode>('unified');
	contextLines = $state(5);
	activeTab = $state<GitDiffTab>('unstaged');

	// Line/hunk selection for staging
	selectedLineKeys = $state(new Set<string>());

	// Collapsed directories in the tree
	collapsedDirs = $state(new Set<string>());

	// Resizable tree pane width (desktop only)
	treePaneWidthPx = $state(300);

	// Review comment drafts
	reviewComments = $state<GitReviewCommentDraft[]>([]);
	reviewSummary = $state('');
	reviewModalOpen = $state(false);

	// Comment composer state
	commentComposer = $state<{
		open: boolean;
		filePath: string;
		side: 'before' | 'after';
		line: number;
		body: string;
		severity: 'note' | 'warning' | 'blocker';
	}>({ open: false, filePath: '', side: 'after', line: 0, body: '', severity: 'note' });

	// Commit state
	commitMessage = $state('');
	isCommitting = $state(false);
	isGeneratingMessage = $state(false);
	isCreatingInitialCommit = $state(false);

	// Commit message generation settings (persisted via app settings)
	commitGenerationEnabled = $state(true);
	commitProvider = $state('claude');
	commitModel = $state('');
	commitCustomPrompt = $state('');
	commitUseCommonDirPrefix = $state(false);

	// Error feedback surfaced to UI
	lastError = $state<string | null>(null);

	// Worktrees
	worktrees = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);

	// Per-file scroll positions for restore on switch
	private scrollPositions = new Map<string, number>();
	private readonly opts: GitWorkbenchStoreOptions;
	private diffScrollToken = 0;
	private readonly deps: GitWorkbenchDeps;

	// Viewport-driven loading: bounded-concurrency queue that fetches
	// only the files currently visible in the virtual list.
	private inFlightFiles = new Set<string>();
	private pendingLoadQueue: string[] = [];
	private loadGeneration = 0;
	private loadProjectPath = '';

	// Diff cache keyed by contextLines|filePath. Staging invalidates
	// only the affected file rather than the entire cache.
	private reviewCache = new Map<string, GitFileReviewData>();

	private cacheKey(filePath: string, tab?: GitDiffTab): string {
		return `${tab ?? this.activeTab}|${this.contextLines}|${filePath}`;
	}

	private cacheGet(filePath: string, tab?: GitDiffTab): GitFileReviewData | null {
		return this.reviewCache.get(this.cacheKey(filePath, tab)) ?? null;
	}

	private cacheSet(filePath: string, data: GitFileReviewData, tab?: GitDiffTab): void {
		this.reviewCache.set(this.cacheKey(filePath, tab), data);
	}

	// Removes all cache entries for a specific file (across tabs and context sizes).
	private cacheInvalidateFile(filePath: string): void {
		const suffix = `|${filePath}`;
		for (const key of this.reviewCache.keys()) {
			if (key.endsWith(suffix)) this.reviewCache.delete(key);
		}
	}

	constructor(opts?: GitWorkbenchStoreOptions, deps?: GitWorkbenchDeps) {
		this.opts = opts ?? { get provider() { return 'claude'; } };
		this.deps = deps ?? {
			getSettings: async () => {
				const { getSettings } = await import('$lib/api/settings.js');
				return getSettings();
			},
		};
		this.loadTreePaneWidth();
		this.hydrateCommitSettings();
	}

	private get provider(): string {
		return this.opts.provider;
	}

	// Derived: currently selected file's review data
	get currentReviewData(): GitFileReviewData | null {
		if (!this.selectedFile) return null;
		return this.reviewDataByPath[this.selectedFile] ?? null;
	}

	// Derived: filtered tree with single-child directory chains compacted
	// (e.g. a/b/c/d with one file becomes one "a/b/c/d" folder entry).
	get filteredTree(): GitTreeNode[] {
		return this.compactTree(this.filterTreeNodes(this.tree));
	}

	// Derived: comments grouped by file path
	get commentsByFile(): Record<string, GitReviewCommentDraft[]> {
		const grouped: Record<string, GitReviewCommentDraft[]> = {};
		for (const c of this.reviewComments) {
			if (!grouped[c.filePath]) grouped[c.filePath] = [];
			grouped[c.filePath].push(c);
		}
		return grouped;
	}

	// Returns comments for a single file path.
	commentsForFile(filePath: string): GitReviewCommentDraft[] {
		return this.reviewComments.filter(c => c.filePath === filePath);
	}

	// Derived: count of all changed files (flattened)
	get totalChangedFiles(): number {
		return this.countFiles(this.tree);
	}

	// Derived: flattened visible file paths filtered by active tab.
	// Unstaged tab shows files with unstaged or untracked changes;
	// staged tab shows files with staged changes.
	get visibleFilePaths(): string[] {
		const predicate = this.activeTab === 'staged'
			? (n: GitTreeNode) => n.staged
			: (n: GitTreeNode) => n.hasUnstaged || n.changeKind === 'untracked';
		return this.collectFilePathsByPredicate(this.filteredTree, predicate);
	}

	// Derived: file counts per tab (for badge display)
	get unstagedFileCount(): number {
		return this.countFilesByPredicate(this.tree, (n) => n.hasUnstaged || n.changeKind === 'untracked');
	}

	get stagedFileCount(): number {
		return this.countFilesByPredicate(this.tree, (n) => n.staged);
	}

	// Derived: whether there are any selected lines
	get hasSelection(): boolean {
		return this.selectedLineKeys.size > 0;
	}

	// Derived: list of file paths currently staged in the index
	get stagedFiles(): string[] {
		return this.stagedFileNodes.map((n) => n.path);
	}

	// Derived: full tree nodes for staged files (includes additions/deletions)
	get stagedFileNodes(): GitTreeNode[] {
		return this.collectStagedNodes(this.tree);
	}

	// Derived: common directory prefix from staged files (lazy import to avoid bundle overhead)
	get commonDirPrefix(): string {
		if (!this.commitUseCommonDirPrefix) return '';
		try {
			// Synchronous import not possible; use pre-computed cache.
			return this._cachedCommonDirPrefix;
		} catch {
			return '';
		}
	}

	private _cachedCommonDirPrefix = $derived.by(() => {
		if (!this.commitUseCommonDirPrefix) return '';
		const files = this.stagedFiles;
		if (files.length === 0) return '';
		return computeCommonDirPrefixSync(files);
	});

	private collectStagedNodes(nodes: GitTreeNode[]): GitTreeNode[] {
		const result: GitTreeNode[] = [];
		for (const node of nodes) {
			if (node.kind === 'file' && node.staged) result.push(node);
			else if (node.children) result.push(...this.collectStagedNodes(node.children));
		}
		return result;
	}

	private countFiles(nodes: GitTreeNode[]): number {
		let count = 0;
		for (const node of nodes) {
			if (node.kind === 'file') count++;
			else if (node.children) count += this.countFiles(node.children);
		}
		return count;
	}

	private countFilesByPredicate(nodes: GitTreeNode[], predicate: (n: GitTreeNode) => boolean): number {
		let count = 0;
		for (const node of nodes) {
			if (node.kind === 'file' && predicate(node)) count++;
			else if (node.children) count += this.countFilesByPredicate(node.children, predicate);
		}
		return count;
	}

	private collectFilePaths(nodes: GitTreeNode[]): string[] {
		const result: string[] = [];
		for (const node of nodes) {
			if (node.kind === 'file') {
				result.push(node.path);
			} else if (node.children) {
				result.push(...this.collectFilePaths(node.children));
			}
		}
		return result;
	}

	private collectFilePathsByPredicate(nodes: GitTreeNode[], predicate: (n: GitTreeNode) => boolean): string[] {
		const result: string[] = [];
		for (const node of nodes) {
			if (node.kind === 'file' && predicate(node)) {
				result.push(node.path);
			} else if (node.children) {
				result.push(...this.collectFilePathsByPredicate(node.children, predicate));
			}
		}
		return result;
	}

	// Collapses single-child directory chains into one node so that
	// e.g. a > b > c > file.txt renders as "a/b/c" > file.txt.
	private compactTree(nodes: GitTreeNode[]): GitTreeNode[] {
		return nodes.map((node) => {
			if (node.kind !== 'directory' || !node.children) return node;
			let children = this.compactTree(node.children);
			let { name, path, staged, hasUnstaged } = node;
			while (
				children.length === 1 &&
				children[0].kind === 'directory' &&
				children[0].children
			) {
				const child = children[0];
				name = name + '/' + child.name;
				path = child.path;
				staged = staged || child.staged;
				hasUnstaged = hasUnstaged || child.hasUnstaged;
				children = child.children!;
			}
			return { ...node, name, path, staged, hasUnstaged, children };
		});
	}

	private filterTreeNodes(nodes: GitTreeNode[]): GitTreeNode[] {
		const result: GitTreeNode[] = [];
		for (const node of nodes) {
			if (node.kind === 'directory') {
				const filteredChildren = this.filterTreeNodes(node.children ?? []);
				if (filteredChildren.length > 0) {
					result.push({ ...node, children: filteredChildren });
				}
			} else {
				if (this.matchesSearch(node)) {
					result.push(node);
				}
			}
		}
		return result;
	}

	private matchesSearch(node: GitTreeNode): boolean {
		if (!this.treeSearchQuery) return true;
		return node.path.toLowerCase().includes(this.treeSearchQuery.toLowerCase());
	}

	// Surfaces an error message to UI, auto-cleared after timeout.
	private surfaceError(msg: string): void {
		this.lastError = msg;
		setTimeout(() => {
			if (this.lastError === msg) this.lastError = null;
		}, 6000);
	}

	private commitMessageGenerationErrorMessage(err: unknown): string {
		if (!(err instanceof ApiError)) {
			return `Generate message failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		switch (err.errorCode) {
			case 'commit_message_no_staged_files':
				return m.git_commit_message_errors_no_staged_files();
			case 'commit_message_provider_auth_required':
				return m.git_commit_message_errors_provider_auth_required();
			case 'commit_message_provider_unavailable':
				return m.git_commit_message_errors_provider_unavailable();
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

	dismissError(): void {
		this.lastError = null;
	}

	// Tree pane width

	setTreePaneWidth(next: number): void {
		const clamped = Math.max(220, Math.min(560, Math.round(next)));
		this.treePaneWidthPx = clamped;
		localStorage.setItem('git.treePaneWidthPx', String(clamped));
	}

	loadTreePaneWidth(): void {
		const raw = localStorage.getItem('git.treePaneWidthPx');
		const n = raw ? Number(raw) : NaN;
		if (Number.isFinite(n)) this.setTreePaneWidth(n);
	}

	// Tree operations

	async loadTree(projectPath: string): Promise<void> {
		this.isLoadingTree = true;
		try {
			const data = await getGitChangesTree(projectPath);
			this.tree = data.root;
			this.hasCommits = data.hasCommits;
		} catch (err) {
			this.surfaceError(`Failed to load changes: ${err instanceof Error ? err.message : String(err)}`);
			this.tree = [];
		} finally {
			this.isLoadingTree = false;
		}
	}

	toggleDirCollapsed(dirPath: string): void {
		const next = new Set(this.collapsedDirs);
		if (next.has(dirPath)) next.delete(dirPath);
		else next.add(dirPath);
		this.collapsedDirs = next;
	}

	// File selection and review data loading

	async openFile(projectPath: string, filePath: string): Promise<void> {
		this.selectedFile = filePath;
		this.selectedLineKeys = new Set();
	}

	// Queues a scroll request for the virtualized diff list.
	requestDiffScrollToFile(filePath: string): void {
		if (!filePath) return;
		this.diffScrollToken += 1;
		this.diffScrollRequest = { filePath, token: this.diffScrollToken };
	}

	// Resolves the first visible file under a directory path for the active tab.
	firstVisibleFileInDirectory(dirPath: string): string | null {
		if (!dirPath) return null;
		const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
		for (const filePath of this.visibleFilePaths) {
			if (filePath.startsWith(prefix)) return filePath;
		}
		return null;
	}

	async loadFileReviewData(projectPath: string, filePath: string): Promise<void> {
		const tab = this.activeTab;
		const cached = this.cacheGet(filePath, tab);
		if (cached) {
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: cached };
			return;
		}
		this.isLoadingFile = true;
		try {
			const data = await getGitFileReviewData(projectPath, filePath, tab, this.contextLines);
			this.cacheSet(filePath, data, tab);
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: data };
		} catch (err) {
			this.surfaceError(`Failed to load diff: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.isLoadingFile = false;
		}
	}

	// Called by the virtual list when visible items change. Seeds from cache
	// where available, queues uncached files for fetch with bounded concurrency.
	// Replaces the pending queue each call so scrolling always prioritizes
	// the currently visible files.
	requestFilesLoaded(projectPath: string, filePaths: string[]): void {
		this.loadProjectPath = projectPath;

		const seeded: Record<string, GitFileReviewData> = {};
		const toFetch: string[] = [];

		for (const fp of filePaths) {
			const cached = this.cacheGet(fp);
			if (cached) {
				if (!this.reviewDataByPath[fp]) seeded[fp] = cached;
				continue;
			}
			if (this.inFlightFiles.has(fp)) continue;
			toFetch.push(fp);
		}

		if (Object.keys(seeded).length > 0) {
			this.reviewDataByPath = { ...this.reviewDataByPath, ...seeded };
		}

		this.pendingLoadQueue = toFetch;
		if (toFetch.length > 0) this.pumpFileQueue();
	}

	private pumpFileQueue(): void {
		const maxConcurrent = 6;
		const gen = this.loadGeneration;

		while (this.inFlightFiles.size < maxConcurrent && this.pendingLoadQueue.length > 0) {
			const filePath = this.pendingLoadQueue.shift()!;
			if (this.inFlightFiles.has(filePath)) continue;
			this.inFlightFiles.add(filePath);

			const tab = this.activeTab;
			const contextLines = this.contextLines;
			const projectPath = this.loadProjectPath;

			void getGitFileReviewData(projectPath, filePath, tab, contextLines)
				.then((data) => {
					if (gen !== this.loadGeneration) return;
					this.cacheSet(filePath, data, tab);
					this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: data };
				})
				.catch(() => {
					if (gen !== this.loadGeneration) return;
					this.reviewDataByPath = {
						...this.reviewDataByPath,
						[filePath]: {
							path: filePath,
							isBinary: false, truncated: false,
							contentBefore: '', contentAfter: '',
							diffOps: [], hunks: [],
							error: 'Failed to load diff',
						},
					};
				})
				.finally(() => {
					this.inFlightFiles.delete(filePath);
					if (gen === this.loadGeneration) this.pumpFileQueue();
				});
		}
	}

	// Invalidates all cached data. Used after commit/revert where every
	// file may have changed. Viewport-driven loading will re-fetch
	// visible files on the next render cycle.
	refreshAllData(): void {
		this.reviewCache.clear();
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.loadGeneration++;
	}

	// Re-fetches a single file's diff after a staging operation. Invalidates
	// the file's cache, refreshes the tree, and fetches only the affected
	// file. Other files remain cached and untouched.
	private async refreshFileAfterStage(projectPath: string, file: string): Promise<void> {
		this.cacheInvalidateFile(file);
		await this.loadTree(projectPath);
		// Reload just the affected file (bypasses cache since we invalidated it)
		await this.loadFileReviewData(projectPath, file);
	}

	// Tab and diff settings

	setActiveTab(tab: GitDiffTab): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;
		this.selectedLineKeys = new Set();
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.loadGeneration++;
	}

	setDiffMode(mode: DiffMode): void {
		this.diffMode = mode;
	}

	setContextLines(lines: number): void {
		this.contextLines = lines;
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.loadGeneration++;
	}

	// Line selection

	toggleLineSelection(key: string): void {
		const next = new Set(this.selectedLineKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this.selectedLineKeys = next;
	}

	selectLineRange(startKey: string, endKey: string, allKeys: string[]): void {
		const startIdx = allKeys.indexOf(startKey);
		const endIdx = allKeys.indexOf(endKey);
		if (startIdx === -1 || endIdx === -1) return;
		const lo = Math.min(startIdx, endIdx);
		const hi = Math.max(startIdx, endIdx);
		const next = new Set(this.selectedLineKeys);
		for (let i = lo; i <= hi; i++) next.add(allKeys[i]);
		this.selectedLineKeys = next;
	}

	clearSelection(): void {
		this.selectedLineKeys = new Set();
	}

	// Staging actions

	async stageSelectedLines(projectPath: string): Promise<boolean> {
		if (!this.selectedFile || this.selectedLineKeys.size === 0) return false;
		const file = this.selectedFile;
		const indices = Array.from(this.selectedLineKeys)
			.map((k) => parseInt(k.split(':')[1], 10))
			.filter((n) => !isNaN(n));
		try {
			const result = await gitStageSelection(
				projectPath, file, 'stage', indices, this.contextLines,
			);
			if (result.success) {
				this.selectedLineKeys = new Set();
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageSelectedLines(projectPath: string): Promise<boolean> {
		if (!this.selectedFile || this.selectedLineKeys.size === 0) return false;
		const file = this.selectedFile;
		const indices = Array.from(this.selectedLineKeys)
			.map((k) => parseInt(k.split(':')[1], 10))
			.filter((n) => !isNaN(n));
		try {
			const result = await gitStageSelection(
				projectPath, file, 'unstage', indices, this.contextLines,
			);
			if (result.success) {
				this.selectedLineKeys = new Set();
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Stage/unstage a single diff line by its diffLineIndex.
	async stageLine(projectPath: string, diffLineIndex: number): Promise<boolean> {
		if (!this.selectedFile) return false;
		const file = this.selectedFile;
		try {
			const result = await gitStageSelection(
				projectPath, file, 'stage', [diffLineIndex], this.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage line failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageLine(projectPath: string, diffLineIndex: number): Promise<boolean> {
		if (!this.selectedFile) return false;
		const file = this.selectedFile;
		try {
			const result = await gitStageSelection(
				projectPath, file, 'unstage', [diffLineIndex], this.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage line failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async stageHunk(projectPath: string, hunkIndex: number): Promise<boolean> {
		if (!this.selectedFile) return false;
		const file = this.selectedFile;
		try {
			const result = await gitStageHunk(
				projectPath, file, 'stage', hunkIndex, this.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage hunk failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageHunk(projectPath: string, hunkIndex: number): Promise<boolean> {
		if (!this.selectedFile) return false;
		const file = this.selectedFile;
		try {
			const result = await gitStageHunk(
				projectPath, file, 'unstage', hunkIndex, this.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, file);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage hunk failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// File-level staging (for untracked files or bulk operations)
	async stageFile(projectPath: string, filePath: string): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, filePath, 'stage');
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, filePath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage file failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageFile(projectPath: string, filePath: string): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, filePath, 'unstage');
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, filePath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage file failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Stages all files under a directory. Refreshes tree and clears
	// cached diffs so viewport-driven loading re-fetches visible files.
	async stageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, dirPath, 'stage');
			if (result.success) {
				this.refreshAllData();
				await this.loadTree(projectPath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage directory failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, dirPath, 'unstage');
			if (result.success) {
				this.refreshAllData();
				await this.loadTree(projectPath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage directory failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Commit actions

	async commitIndex(projectPath: string): Promise<boolean> {
		if (!this.commitMessage.trim()) return false;
		this.isCommitting = true;
		try {
			const result = await gitCommitIndex(projectPath, this.commitMessage.trim());
			if (result.success) {
				this.commitMessage = '';
				this.refreshAllData();
				await this.loadTree(projectPath);
				// After commit, the previously selected file may no longer
				// have changes. Re-select if still present, otherwise pick
				// the first remaining file or clear selection.
				if (!this.selectedFile || !this.visibleFilePaths.includes(this.selectedFile)) {
					const first = this.visibleFilePaths[0];
					if (first) {
						await this.openFile(projectPath, first);
					} else {
						this.selectedFile = null;
					}
				}
			} else {
				this.surfaceError(result.error ?? 'Commit failed');
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			this.isCommitting = false;
		}
	}

	async createInitialCommit(projectPath: string): Promise<boolean> {
		this.isCreatingInitialCommit = true;
		try {
			const result = await gitInitialCommit(projectPath);
			if (result.success) {
				this.hasCommits = true;
				await this.loadTree(projectPath);
			} else {
				this.surfaceError(result.error ?? 'Initial commit failed');
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Initial commit failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			this.isCreatingInitialCommit = false;
		}
	}

	async generateCommitMsg(projectPath: string): Promise<void> {
		const files = this.stagedFiles;
		if (files.length === 0) {
			this.surfaceError('No staged files to generate message for');
			return;
		}
		this.isGeneratingMessage = true;
		try {
			// Hydrate provider/model from persisted settings before generating.
			await this.hydrateCommitSettings();
			const data = await generateCommitMessageApi(
				projectPath, files, this.commitProvider, this.commitModel, this.commitCustomPrompt,
			);
				if (data.message) {
					let msg = data.message;
					if (this.commitUseCommonDirPrefix) {
						const prefix = computeCommonDirPrefixSync(files);
						if (prefix) {
							msg = applyDirPrefix(msg, prefix);
						}
					}
					this.commitMessage = msg;
				} else {
				this.surfaceError(data.error ?? 'Failed to generate commit message');
			}
		} catch (err) {
			this.surfaceError(this.commitMessageGenerationErrorMessage(err));
		} finally {
			this.isGeneratingMessage = false;
		}
	}

	// Reads commit message settings from persisted app settings.
	private async hydrateCommitSettings(): Promise<void> {
		try {
			const settings = await this.deps.getSettings();
			const ui = (settings.ui ?? {}) as Record<string, unknown>;
			const uiEffective = (settings.uiEffective ?? {}) as Record<string, unknown>;
			const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
			const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
			const cm = { ...persistedCommitMessage, ...effectiveCommitMessage } as Record<string, unknown>;
			this.commitGenerationEnabled = cm.enabled !== false;
			const provider = cm.provider as string;
			if (['claude', 'codex', 'opencode', 'amp'].includes(provider)) {
				this.commitProvider = provider;
			}
			if (typeof cm.model === 'string' && cm.model) {
				this.commitModel = cm.model;
			}
			if (typeof cm.customPrompt === 'string') {
				this.commitCustomPrompt = cm.customPrompt;
			}
			if (typeof cm.useCommonDirPrefix === 'boolean') {
				this.commitUseCommonDirPrefix = cm.useCommonDirPrefix;
			}
		} catch { /* settings may not be available */ }
	}

	// Review comments

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
		this.commentComposer = { open: true, filePath, side, line, body: '', severity: 'note' };
	}

	commitCommentComposer(): void {
		const c = this.commentComposer;
		if (!c.open || !c.body.trim()) return;
		this.addDraftComment({
			filePath: c.filePath,
			side: c.side,
			line: c.line,
			body: c.body.trim(),
			severity: c.severity,
		});
		this.commentComposer = { open: false, filePath: '', side: 'after', line: 0, body: '', severity: 'note' };
	}

	closeCommentComposer(): void {
		this.commentComposer = { open: false, filePath: '', side: 'after', line: 0, body: '', severity: 'note' };
	}

	addDraftComment(input: Omit<GitReviewCommentDraft, 'id' | 'createdAt'>): void {
		const comment: GitReviewCommentDraft = {
			...input,
			id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
			createdAt: new Date().toISOString(),
		};
		this.reviewComments = [...this.reviewComments, comment];
	}

	updateDraftComment(id: string, patch: Partial<GitReviewCommentDraft>): void {
		this.reviewComments = this.reviewComments.map((c) =>
			c.id === id ? { ...c, ...patch } : c,
		);
	}

	removeDraftComment(id: string): void {
		this.reviewComments = this.reviewComments.filter((c) => c.id !== id);
	}

	buildFinalizedReviewMessage(): string {
		const lines: string[] = ['Git review draft for current workspace:', ''];

		if (this.reviewSummary.trim()) {
			lines.push('Summary:', this.reviewSummary.trim(), '');
		}

		if (this.reviewComments.length > 0) {
			lines.push('Comments:');
			for (const c of this.reviewComments) {
				const range = c.lineEnd ? `${c.line}-${c.lineEnd}` : `${c.line}`;
				lines.push(`- [${c.severity}] ${c.filePath}:${range} (${c.side})`);
				lines.push(`  ${c.body}`);
			}
		}

		return lines.join('\n');
	}

	async finalizeReviewToAgent(
		send: (message: string) => Promise<boolean>,
	): Promise<boolean> {
		if (this.reviewComments.length === 0 && !this.reviewSummary.trim()) {
			return false;
		}
		const message = this.buildFinalizedReviewMessage();
		const sent = await send(message);
		if (sent) {
			this.reviewComments = [];
			this.reviewSummary = '';
		}
		return sent;
	}

	// Worktree operations

	async loadWorktrees(projectPath: string): Promise<void> {
		this.isLoadingWorktrees = true;
		try {
			const data = await getGitWorktrees(projectPath);
			this.worktrees = data.worktrees;
		} catch (err) {
			this.surfaceError(`Failed to load worktrees: ${err instanceof Error ? err.message : String(err)}`);
			this.worktrees = [];
		} finally {
			this.isLoadingWorktrees = false;
		}
	}

	async createWorktree(
		projectPath: string,
		worktreePath: string,
		options: { baseRef?: string; branch?: string; detach?: boolean } = {},
	): Promise<boolean> {
		try {
			const result = await gitCreateWorktree(projectPath, worktreePath, options);
			if (result.success) await this.loadWorktrees(projectPath);
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Create worktree failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async removeWorktree(
		projectPath: string,
		worktreePath: string,
		force = false,
	): Promise<boolean> {
		try {
			const result = await gitRemoveWorktree(projectPath, worktreePath, force);
			if (result.success) await this.loadWorktrees(projectPath);
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Remove worktree failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Revert last commit

	async revertLastCommit(
		projectPath: string,
		strategy: 'revert' | 'reset-soft' = 'revert',
	): Promise<boolean> {
		try {
			const result = await gitRevertLastCommit(projectPath, strategy);
			if (result.success) {
				this.refreshAllData();
				await this.loadTree(projectPath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// Scroll position management

	saveScrollPosition(filePath: string, position: number): void {
		this.scrollPositions.set(filePath, position);
	}

	getScrollPosition(filePath: string): number {
		return this.scrollPositions.get(filePath) ?? 0;
	}

	// Full reset when project changes
	reset(): void {
		this.tree = [];
		this.selectedFile = null;
		this.diffScrollRequest = null;
		this.reviewDataByPath = {};
		this.selectedLineKeys = new Set();
		this.collapsedDirs = new Set();
		this.activeTab = 'unstaged';
		this.reviewComments = [];
		this.reviewSummary = '';
		this.commitMessage = '';
		this.lastError = null;
		this.hasCommits = true;
		this.worktrees = [];
		this.scrollPositions.clear();
		this.treeSearchQuery = '';
		this.pendingLoadQueue = [];
		this.inFlightFiles.clear();
		this.loadGeneration++;
		this.reviewCache.clear();
		this.reviewModalOpen = false;
		this.commentComposer = { open: false, filePath: '', side: 'after', line: 0, body: '', severity: 'note' };
	}
}
