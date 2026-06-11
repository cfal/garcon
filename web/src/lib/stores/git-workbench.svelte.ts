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
	getGitFileReviewDataBatch,
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
	gitDiscard,
	gitDeleteUntracked,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import type { SessionAgentId } from '$lib/types/app.js';
import type { ApiProtocol } from '$shared/api-providers';
import * as m from '$lib/paraglide/messages.js';
import {
	computeCommonDirPrefix as computeCommonDirPrefixSync,
	applyDirPrefix,
} from '$lib/utils/common-prefix.js';

export type DiffMode = 'unified' | 'split';
export type { GitDiffTab } from '$lib/api/git.js';

export interface GitWorkbenchTarget {
	projectPath: string;
	repoRoot: string;
	worktreePath: string;
	label: string;
	source: 'chat-project' | 'repo-root' | 'worktree';
}

export type GitDiffActionMode = 'stage' | 'unstage';

export interface GitDiffActionTarget {
	filePath: string;
	tab: GitDiffTab;
	mode: GitDiffActionMode;
	contextLines: number;
}

export interface GitLineSelectionKey {
	filePath: string;
	tab: GitDiffTab;
	side: 'before' | 'after';
	diffLineIndex: number;
}

export interface GitWorkbenchRefreshOptions {
	reason: 'mount' | 'manual' | 'agent-event' | 'git-action' | 'branch-change' | 'worktree-change';
	preserveDrafts?: boolean;
	preserveSelection?: boolean;
	preferSelectedFile?: boolean;
}

interface GitWorkbenchLoadGuard {
	generation: number;
	targetKey: string;
	projectPath: string;
	tab: GitDiffTab;
	contextLines: number;
}

const DEFAULT_REFRESH_OPTIONS = {
	preserveDrafts: true,
	preserveSelection: true,
	preferSelectedFile: true,
};

function targetKey(target: GitWorkbenchTarget | null): string {
	return target ? target.worktreePath : '';
}

export function encodeLineSelectionKey(key: GitLineSelectionKey): string {
	return [encodeURIComponent(key.filePath), key.tab, key.side, String(key.diffLineIndex)].join('|');
}

export function decodeLineSelectionKey(raw: string): GitLineSelectionKey | null {
	const [encodedFilePath, tab, side, rawIndex] = raw.split('|');
	const diffLineIndex = Number(rawIndex);
	if (!encodedFilePath) return null;
	if (tab !== 'unstaged' && tab !== 'staged') return null;
	if (side !== 'before' && side !== 'after') return null;
	if (!Number.isInteger(diffLineIndex) || diffLineIndex < 0) return null;
	return {
		filePath: decodeURIComponent(encodedFilePath),
		tab,
		side,
		diffLineIndex,
	};
}

export function makeLineSelectionKey(
	filePath: string,
	tab: GitDiffTab,
	side: 'before' | 'after',
	diffLineIndex: number,
): string {
	return encodeLineSelectionKey({ filePath, tab, side, diffLineIndex });
}

/** Injectable dependencies for testing. Defaults load the real
 *  settings API when not overridden. */
export interface GitWorkbenchDeps {
	getSettings: () => Promise<{
		ui?: Record<string, unknown>;
		uiEffective?: Record<string, unknown>;
	}>;
	/** When provided, hydrateCommitSettings reads directly from the
	 *  shared remote settings snapshot instead of issuing a fetch. */
	remoteSnapshot?: () => {
		ui?: Record<string, unknown>;
		uiEffective?: Record<string, unknown>;
	} | null;
}

export class GitWorkbenchStore {
	target = $state<GitWorkbenchTarget | null>(null);
	private lastTargetKey = '';
	private refreshGeneration = 0;
	private scheduledRefresh: ReturnType<typeof setTimeout> | null = null;
	private refreshPromise: Promise<void> | null = null;

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
	commitAgentId = $state<SessionAgentId>('claude');
	commitModel = $state('');
	commitApiProviderId = $state<string | null>(null);
	commitModelEndpointId = $state<string | null>(null);
	commitModelProtocol = $state<ApiProtocol | null>(null);
	commitCustomPrompt = $state('');
	commitUseCommonDirPrefix = $state(false);

	// Pending discard confirmation (file path awaiting user confirmation)
	pendingDiscardFile = $state<string | null>(null);

	// Error feedback surfaced to UI
	lastError = $state<string | null>(null);

	// Worktrees
	worktrees = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);

	// Per-file scroll positions for restore on switch
	private scrollPositions = new Map<string, number>();
	private diffScrollToken = 0;
	private readonly deps: GitWorkbenchDeps;

	// Viewport-driven loading: bounded-concurrency queue that fetches
	// only the files currently visible in the virtual list.
	private inFlightFiles = new Set<string>();
	private pendingLoadQueue: string[] = [];
	private loadGeneration = 0;
	private loadProjectPath = '';
	private fileLoadRequestId = 0;

	// Diff cache keyed by tab, context lines, and file path. Staging invalidates
	// only the affected file rather than the entire cache.
	private reviewCache = new Map<string, GitFileReviewData>();

	private cacheKey(
		filePath: string,
		tab = this.activeTab,
		contextLines = this.contextLines,
	): string {
		return `${tab}|${contextLines}|${filePath}`;
	}

	private cacheGet(
		filePath: string,
		tab = this.activeTab,
		contextLines = this.contextLines,
	): GitFileReviewData | null {
		return this.reviewCache.get(this.cacheKey(filePath, tab, contextLines)) ?? null;
	}

	private cacheSet(
		filePath: string,
		data: GitFileReviewData,
		tab = this.activeTab,
		contextLines = this.contextLines,
	): void {
		this.reviewCache.set(this.cacheKey(filePath, tab, contextLines), data);
	}

	private createLoadGuard(
		projectPath: string,
		generation = this.loadGeneration,
	): GitWorkbenchLoadGuard {
		return {
			generation,
			targetKey: targetKey(this.target),
			projectPath,
			tab: this.activeTab,
			contextLines: this.contextLines,
		};
	}

	private isCurrentLoadGuard(guard: GitWorkbenchLoadGuard): boolean {
		if (guard.generation !== this.loadGeneration) return false;
		if (guard.targetKey !== targetKey(this.target)) return false;
		return !this.target || this.target.projectPath === guard.projectPath;
	}

	private isCurrentFileLoadGuard(guard: GitWorkbenchLoadGuard): boolean {
		return (
			this.isCurrentLoadGuard(guard) &&
			this.activeTab === guard.tab &&
			this.contextLines === guard.contextLines
		);
	}

	// Removes all cache entries for a specific file (across tabs and context sizes).
	private cacheInvalidateFile(filePath: string): void {
		const suffix = `|${filePath}`;
		for (const key of this.reviewCache.keys()) {
			if (key.endsWith(suffix)) this.reviewCache.delete(key);
		}
	}

	constructor(deps?: GitWorkbenchDeps) {
		this.deps = deps ?? {
			getSettings: async () => {
				const { getRemoteSettings } = await import('$lib/api/settings.js');
				const snap = await getRemoteSettings();
				return {
					ui: snap.ui as Record<string, unknown>,
					uiEffective: snap.uiEffective as Record<string, unknown>,
				};
			},
		};
		this.loadTreePaneWidth();
		this.hydrateCommitSettings();
	}

	get projectPath(): string | null {
		return this.target?.projectPath ?? null;
	}

	get hasTarget(): boolean {
		return Boolean(this.target);
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
		return this.reviewComments.filter((c) => c.filePath === filePath);
	}

	// Derived: count of all changed files (flattened)
	get totalChangedFiles(): number {
		return this.countFiles(this.tree);
	}

	// Derived: flattened visible file paths filtered by active tab.
	// Unstaged tab shows files with unstaged or untracked changes;
	// staged tab shows files with staged changes.
	get visibleFilePaths(): string[] {
		const predicate =
			this.activeTab === 'staged'
				? (n: GitTreeNode) => n.staged
				: (n: GitTreeNode) => n.hasUnstaged || n.changeKind === 'untracked';
		return this.collectFilePathsByPredicate(this.filteredTree, predicate);
	}

	// Derived: file counts per tab (for badge display)
	get unstagedFileCount(): number {
		return this.countFilesByPredicate(
			this.tree,
			(n) => n.hasUnstaged || n.changeKind === 'untracked',
		);
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

	private countFilesByPredicate(
		nodes: GitTreeNode[],
		predicate: (n: GitTreeNode) => boolean,
	): number {
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

	private hasFile(filePath: string): boolean {
		return this.collectFilePaths(this.tree).includes(filePath);
	}

	private pruneReviewDataToCurrentTree(): void {
		const paths = new Set(this.collectFilePaths(this.tree));
		this.reviewDataByPath = Object.fromEntries(
			Object.entries(this.reviewDataByPath).filter(([filePath]) => paths.has(filePath)),
		);
		for (const key of Array.from(this.reviewCache.keys())) {
			const filePath = key.split('|').slice(2).join('|');
			if (!paths.has(filePath)) this.reviewCache.delete(key);
		}
	}

	private pruneLineSelectionToCurrentTree(): void {
		const paths = new Set(this.collectFilePaths(this.tree));
		this.selectedLineKeys = new Set(
			Array.from(this.selectedLineKeys).filter((rawKey) => {
				const parsed = decodeLineSelectionKey(rawKey);
				return parsed ? paths.has(parsed.filePath) : false;
			}),
		);
	}

	private collectFilePathsByPredicate(
		nodes: GitTreeNode[],
		predicate: (n: GitTreeNode) => boolean,
	): string[] {
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
			while (children.length === 1 && children[0].kind === 'directory' && children[0].children) {
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

	reportError(msg: string): void {
		this.surfaceError(msg);
	}

	private commitMessageGenerationErrorMessage(err: unknown): string {
		if (!(err instanceof ApiError)) {
			return `Generate message failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		switch (err.errorCode) {
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

	async loadTree(projectPath: string): Promise<boolean> {
		const guard = this.createLoadGuard(projectPath, ++this.loadGeneration);
		this.isLoadingTree = true;
		try {
			const data = await getGitChangesTree(projectPath);
			if (!this.isCurrentLoadGuard(guard)) return false;
			this.tree = data.root;
			this.hasCommits = data.hasCommits;
			return true;
		} catch (err) {
			if (!this.isCurrentLoadGuard(guard)) return false;
			this.surfaceError(
				`Failed to load changes: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.tree = [];
			return true;
		} finally {
			if (this.isCurrentLoadGuard(guard)) this.isLoadingTree = false;
		}
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

		this.pruneReviewDataToCurrentTree();
		this.pruneLineSelectionToCurrentTree();

		if (
			effective.preserveSelection &&
			effective.preferSelectedFile &&
			previousSelectedFile &&
			this.hasFile(previousSelectedFile)
		) {
			this.selectedFile = previousSelectedFile;
			await this.loadFileReviewData(target.projectPath, previousSelectedFile);
			return;
		}

		if (!effective.preserveSelection || !this.selectedFile || !this.hasFile(this.selectedFile)) {
			const first = this.visibleFilePaths[0] ?? null;
			this.selectedFile = first;
			if (first) await this.loadFileReviewData(target.projectPath, first);
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
		await this.loadFileReviewData(projectPath, filePath);
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
		const guard = this.createLoadGuard(projectPath);
		const tab = guard.tab;
		const contextLines = guard.contextLines;
		const cached = this.cacheGet(filePath, tab, contextLines);
		if (cached) {
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: cached };
			return;
		}
		const requestId = ++this.fileLoadRequestId;
		this.isLoadingFile = true;
		try {
			const data = await getGitFileReviewData(projectPath, filePath, tab, contextLines);
			if (!this.isCurrentFileLoadGuard(guard)) return;
			this.cacheSet(filePath, data, tab, contextLines);
			this.reviewDataByPath = { ...this.reviewDataByPath, [filePath]: data };
		} catch (err) {
			if (!this.isCurrentFileLoadGuard(guard)) return;
			this.surfaceError(`Failed to load diff: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (requestId === this.fileLoadRequestId && this.isCurrentFileLoadGuard(guard)) {
				this.isLoadingFile = false;
			}
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
		const gen = this.loadGeneration;
		if (this.inFlightFiles.size > 0 || this.pendingLoadQueue.length === 0) return;

		const tab = this.activeTab;
		const contextLines = this.contextLines;
		const projectPath = this.loadProjectPath;
		const batch = this.pendingLoadQueue.splice(0, 8);
		for (const filePath of batch) this.inFlightFiles.add(filePath);

		void getGitFileReviewDataBatch(projectPath, batch, tab, contextLines)
			.then((result) => {
				if (gen !== this.loadGeneration) return;
				const next = { ...this.reviewDataByPath };
				for (const [filePath, data] of Object.entries(result.files)) {
					this.cacheSet(filePath, data, tab, contextLines);
					next[filePath] = data;
				}
				for (const [filePath, message] of Object.entries(result.errors)) {
					next[filePath] = {
						path: filePath,
						mode: tab === 'staged' ? 'staged' : 'working',
						isBinary: false,
						truncated: false,
						contentBefore: '',
						contentAfter: '',
						diffOps: [],
						hunks: [],
						error: message || 'Failed to load diff',
					};
				}
				this.reviewDataByPath = next;
			})
			.catch(() => {
				if (gen !== this.loadGeneration) return;
				const next = { ...this.reviewDataByPath };
				for (const filePath of batch) {
					next[filePath] = {
						path: filePath,
						mode: tab === 'staged' ? 'staged' : 'working',
						isBinary: false,
						truncated: false,
						contentBefore: '',
						contentAfter: '',
						diffOps: [],
						hunks: [],
						error: 'Failed to load diff',
					};
				}
				this.reviewDataByPath = next;
			})
			.finally(() => {
				for (const filePath of batch) this.inFlightFiles.delete(filePath);
				if (gen === this.loadGeneration) this.pumpFileQueue();
			});
	}

	// Invalidates all cached data. Used after commit/revert where every
	// file may have changed. Viewport-driven loading will re-fetch
	// visible files on the next render cycle.
	refreshAllData(): void {
		this.reviewCache.clear();
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
		this.loadGeneration++;
	}

	// Re-fetches a single file's diff after a staging operation. Invalidates
	// the file's cache, refreshes the tree, and fetches only the affected
	// file. Other files remain cached and untouched.
	private async refreshFileAfterStage(projectPath: string, file: string): Promise<void> {
		this.cacheInvalidateFile(file);
		this.reviewDataByPath = Object.fromEntries(
			Object.entries(this.reviewDataByPath).filter(([filePath]) => filePath !== file),
		);
		await this.refreshAfterGitAction(projectPath, {
			reason: 'git-action',
			preferSelectedFile: true,
		});
		if (this.hasFile(file)) await this.loadFileReviewData(projectPath, file);
	}

	private async refreshAfterGitAction(
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	): Promise<void> {
		if (this.target) await this.refresh(options);
		else await this.loadTree(projectPath);
	}

	// Tab and diff settings

	setActiveTab(tab: GitDiffTab): void {
		if (tab === this.activeTab) return;
		this.activeTab = tab;
		this.selectedLineKeys = new Set();
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
		this.loadGeneration++;
	}

	setDiffMode(mode: DiffMode): void {
		this.diffMode = mode;
	}

	setContextLines(lines: number): void {
		this.contextLines = lines;
		this.reviewDataByPath = {};
		this.pendingLoadQueue = [];
		this.isLoadingFile = false;
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
		return this.stageGroupedSelectedLines(projectPath, 'stage');
	}

	async unstageSelectedLines(projectPath: string): Promise<boolean> {
		return this.stageGroupedSelectedLines(projectPath, 'unstage');
	}

	// Stage/unstage a single diff line by its diffLineIndex.
	async stageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'stage' }, [diffLineIndex]);
	}

	async unstageLine(
		projectPath: string,
		target: GitDiffActionTarget,
		diffLineIndex: number,
	): Promise<boolean> {
		return this.stageSelectionForTarget(projectPath, { ...target, mode: 'unstage' }, [
			diffLineIndex,
		]);
	}

	async stageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('stage')
				: { ...targetOrHunkIndex, mode: 'stage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		try {
			const result = await gitStageHunk(
				projectPath,
				target.filePath,
				'stage',
				hunkIndex,
				target.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, target.filePath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Stage hunk failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async unstageHunk(
		projectPath: string,
		targetOrHunkIndex: GitDiffActionTarget | number,
		maybeHunkIndex?: number,
	): Promise<boolean> {
		const target =
			typeof targetOrHunkIndex === 'number'
				? this.targetForSelectedFile('unstage')
				: { ...targetOrHunkIndex, mode: 'unstage' as const };
		const hunkIndex = typeof targetOrHunkIndex === 'number' ? targetOrHunkIndex : maybeHunkIndex;
		if (!target || hunkIndex === undefined) return false;
		try {
			const result = await gitStageHunk(
				projectPath,
				target.filePath,
				'unstage',
				hunkIndex,
				target.contextLines,
			);
			if (result.success) {
				await this.refreshFileAfterStage(projectPath, target.filePath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Unstage hunk failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	private async stageGroupedSelectedLines(
		projectPath: string,
		mode: GitDiffActionMode,
	): Promise<boolean> {
		const groups = this.groupSelectedLineIndicesByTarget(mode);
		if (groups.length === 0) return false;
		const results = [];
		for (const group of groups) {
			results.push(
				await this.stageSelectionForTarget(projectPath, group.target, group.lineIndices),
			);
		}
		return results.every(Boolean);
	}

	private async stageSelectionForTarget(
		projectPath: string,
		target: GitDiffActionTarget,
		lineIndices: number[],
	): Promise<boolean> {
		try {
			const result = await gitStageSelection(
				projectPath,
				target.filePath,
				target.mode,
				lineIndices,
				target.contextLines,
			);
			if (result.success) {
				this.clearSelectionForFile(target.filePath, target.tab);
				await this.refreshFileAfterStage(projectPath, target.filePath);
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(
				`${target.mode === 'stage' ? 'Stage' : 'Unstage'} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private targetForSelectedFile(mode: GitDiffActionMode): GitDiffActionTarget | null {
		if (!this.selectedFile) return null;
		return {
			filePath: this.selectedFile,
			tab: this.activeTab,
			mode,
			contextLines: this.contextLines,
		};
	}

	private groupSelectedLineIndicesByTarget(mode: GitDiffActionMode): Array<{
		target: GitDiffActionTarget;
		lineIndices: number[];
	}> {
		const grouped = new Map<string, { target: GitDiffActionTarget; lineIndices: number[] }>();
		for (const rawKey of this.selectedLineKeys) {
			const parsed = decodeLineSelectionKey(rawKey);
			if (!parsed) continue;
			const key = `${parsed.filePath}|${parsed.tab}|${mode}`;
			const existing = grouped.get(key) ?? {
				target: {
					filePath: parsed.filePath,
					tab: parsed.tab,
					mode,
					contextLines: this.contextLines,
				},
				lineIndices: [],
			};
			existing.lineIndices.push(parsed.diffLineIndex);
			grouped.set(key, existing);
		}
		return Array.from(grouped.values());
	}

	private clearSelectionForFile(filePath: string, tab: GitDiffTab): void {
		this.selectedLineKeys = new Set(
			Array.from(this.selectedLineKeys).filter((rawKey) => {
				const parsed = decodeLineSelectionKey(rawKey);
				return !parsed || parsed.filePath !== filePath || parsed.tab !== tab;
			}),
		);
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
				await this.refreshAfterGitAction(projectPath, { reason: 'git-action' });
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(
				`Stage directory failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	async unstageDirectory(projectPath: string, dirPath: string): Promise<boolean> {
		try {
			const result = await gitStageFile(projectPath, dirPath, 'unstage');
			if (result.success) {
				this.refreshAllData();
				await this.refreshAfterGitAction(projectPath, { reason: 'git-action' });
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(
				`Unstage directory failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	// File discard (revert unstaged changes)

	requestDiscard(filePath: string): void {
		this.pendingDiscardFile = filePath;
	}

	cancelDiscard(): void {
		this.pendingDiscardFile = null;
	}

	async confirmDiscard(projectPath: string): Promise<boolean> {
		const filePath = this.pendingDiscardFile;
		if (!filePath) return false;
		this.pendingDiscardFile = null;
		try {
			const node = this.findTreeNode(filePath);
			const isUntracked = node?.changeKind === 'untracked';
			const result = isUntracked
				? await gitDeleteUntracked(projectPath, filePath)
				: await gitDiscard(projectPath, filePath);
			if (result.success) {
				this.refreshAllData();
				await this.refreshAfterGitAction(projectPath, { reason: 'git-action' });
				if (this.selectedFile === filePath && !this.visibleFilePaths.includes(filePath)) {
					const first = this.visibleFilePaths[0];
					this.selectedFile = first ?? null;
				}
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(`Discard failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	private findTreeNode(filePath: string): GitTreeNode | undefined {
		const search = (nodes: GitTreeNode[]): GitTreeNode | undefined => {
			for (const node of nodes) {
				if (node.path === filePath) return node;
				if (node.children) {
					const found = search(node.children);
					if (found) return found;
				}
			}
			return undefined;
		};
		return search(this.tree);
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
				await this.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preserveSelection: false,
				});
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
				await this.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preserveSelection: false,
				});
			} else {
				this.surfaceError(result.error ?? 'Initial commit failed');
			}
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(
				`Initial commit failed: ${err instanceof Error ? err.message : String(err)}`,
			);
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
			// Hydrate agent/model from persisted settings before generating.
			await this.hydrateCommitSettings();
			const data = await generateCommitMessageApi(
				projectPath,
				files,
				this.commitAgentId,
				this.commitModel,
				this.commitCustomPrompt,
				this.commitApiProviderId,
				this.commitModelEndpointId,
				this.commitModelProtocol,
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
			const snap = this.deps.remoteSnapshot?.();
			const settings = snap ?? (await this.deps.getSettings());
			const ui = (settings.ui ?? {}) as Record<string, unknown>;
			const uiEffective = (settings.uiEffective ?? {}) as Record<string, unknown>;
			const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
			const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
			const cm = { ...persistedCommitMessage, ...effectiveCommitMessage } as Record<
				string,
				unknown
			>;
			this.commitGenerationEnabled = cm.enabled !== false;
			const agentId = cm.agentId as string;
			if (typeof agentId === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(agentId)) {
				this.commitAgentId = agentId as SessionAgentId;
			}
			if (typeof cm.model === 'string' && cm.model) {
				this.commitModel = cm.model;
			}
			this.commitApiProviderId = typeof cm.apiProviderId === 'string' ? cm.apiProviderId : null;
			this.commitModelEndpointId =
				typeof cm.modelEndpointId === 'string' ? cm.modelEndpointId : null;
			this.commitModelProtocol =
				cm.modelProtocol === 'openai-compatible' || cm.modelProtocol === 'anthropic-messages'
					? cm.modelProtocol
					: null;
			if (typeof cm.customPrompt === 'string') {
				this.commitCustomPrompt = cm.customPrompt;
			}
			if (typeof cm.useCommonDirPrefix === 'boolean') {
				this.commitUseCommonDirPrefix = cm.useCommonDirPrefix;
			}
		} catch {
			/* settings may not be available */
		}
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
		this.commentComposer = {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		};
	}

	closeCommentComposer(): void {
		this.commentComposer = {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		};
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
		this.reviewComments = this.reviewComments.map((c) => (c.id === id ? { ...c, ...patch } : c));
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

	async finalizeReviewToAgent(send: (message: string) => Promise<boolean>): Promise<boolean> {
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
			this.surfaceError(
				`Failed to load worktrees: ${err instanceof Error ? err.message : String(err)}`,
			);
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
			this.surfaceError(
				`Create worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	async removeWorktree(projectPath: string, worktreePath: string, force = false): Promise<boolean> {
		try {
			const result = await gitRemoveWorktree(projectPath, worktreePath, force);
			if (result.success) await this.loadWorktrees(projectPath);
			return result.success ?? false;
		} catch (err) {
			this.surfaceError(
				`Remove worktree failed: ${err instanceof Error ? err.message : String(err)}`,
			);
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
				await this.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preserveSelection: false,
				});
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

	private resetForTargetChange(): void {
		this.tree = [];
		this.isLoadingTree = false;
		this.selectedFile = null;
		this.diffScrollRequest = null;
		this.reviewDataByPath = {};
		this.isLoadingFile = false;
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
		this.commentComposer = {
			open: false,
			filePath: '',
			side: 'after',
			line: 0,
			body: '',
			severity: 'note',
		};
	}

	// Full reset when project changes or the panel is disposed.
	reset(): void {
		this.target = null;
		this.lastTargetKey = '';
		this.resetForTargetChange();
	}
}
