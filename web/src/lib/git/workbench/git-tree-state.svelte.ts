import { type GitDiffTab, type GitTreeNode, type GitTreeStatsState } from '$lib/api/git.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import {
	clampGitFileTreeWidth,
	DEFAULT_GIT_FILE_TREE_WIDTH,
	persistGitFileTreeWidth,
	readGitFileTreeWidth,
} from '$lib/git/surface/git-file-tree-preferences.js';
import * as m from '$lib/paraglide/messages.js';

export class GitTreeState {
	tree = $state<GitTreeNode[]>([]);
	isLoadingTree = $state(false);
	treeSearchQuery = $state('');
	hasCommits = $state(true);
	statsState = $state<GitTreeStatsState>('pending');
	collapsedDirs = $state(new Set<string>());
	treePaneWidthPx = $state(DEFAULT_GIT_FILE_TREE_WIDTH);
	selectedFile = $state<string | null>(null);
	activeTab = $state<GitDiffTab>('unstaged');
	hideGenerated = $state(false);
	hideOtherTabFiles = $state(false);
	private filePathsValue = $state<string[]>([]);
	private stagedFileNodesValue = $state<GitTreeNode[]>([]);
	private unstagedFilePathsValue = $state<string[]>([]);
	private stagedFilePathsValue = $state<string[]>([]);
	private fileNodeByPath = new Map<string, GitTreeNode>();

	get filteredTree(): GitTreeNode[] {
		return filterTreeForWorkbench(
			compactTree(filterTreeNodes(this.tree, this.treeSearchQuery)),
			(node) => this.shouldShowFileNode(node),
		);
	}

	get totalChangedFiles(): number {
		return countFiles(this.tree);
	}

	get stagedFiles(): string[] {
		return this.stagedFileNodes.map((node) => node.path);
	}

	get stagedFileNodes(): GitTreeNode[] {
		return this.stagedFileNodesValue;
	}

	get filePaths(): string[] {
		return this.filePathsValue;
	}

	get visibleFilePaths(): string[] {
		const paths =
			this.activeTab === 'staged' ? this.stagedFilePathsValue : this.unstagedFilePathsValue;
		if (!this.treeSearchQuery) return paths.filter((path) => this.shouldShowFilePath(path));
		const visible = new Set(collectFilePaths(this.filteredTree));
		return paths.filter((path) => visible.has(path) && this.shouldShowFilePath(path));
	}

	get visibleChangedFiles(): number {
		return this.visibleFilePaths.length;
	}

	get hideOtherTabFilesLabel(): string {
		return this.activeTab === 'unstaged'
			? m.git_file_tree_hide_staged()
			: m.git_file_tree_hide_unstaged();
	}

	unstagedFileCount(): number {
		return this.unstagedFilePathsValue.length;
	}

	stagedFileCount(): number {
		return this.stagedFilePathsValue.length;
	}

	hasFile(filePath: string): boolean {
		return this.fileNodeByPath.has(filePath);
	}

	findTreeNode(filePath: string): GitTreeNode | undefined {
		return this.fileNodeByPath.get(filePath);
	}

	toggleDirCollapsed(dirPath: string): void {
		const next = new Set(this.collapsedDirs);
		if (next.has(dirPath)) next.delete(dirPath);
		else next.add(dirPath);
		this.collapsedDirs = next;
	}

	setTreePaneWidth(next: number): void {
		this.treePaneWidthPx = persistGitFileTreeWidth(next);
	}

	previewTreePaneWidth(next: number): void {
		this.treePaneWidthPx = clampGitFileTreeWidth(next);
	}

	loadTreePaneWidth(): void {
		const width = readGitFileTreeWidth();
		if (width !== null) this.previewTreePaneWidth(width);
	}

	setHideGenerated(value: boolean): void {
		this.hideGenerated = value;
	}

	setHideOtherTabFiles(value: boolean): void {
		this.hideOtherTabFiles = value;
		setLocalStorageItem(LOCAL_STORAGE_KEYS.gitHideOtherTabFiles, value ? 'true' : 'false');
	}

	loadHideOtherTabFiles(): void {
		this.hideOtherTabFiles =
			getLocalStorageItem(LOCAL_STORAGE_KEYS.gitHideOtherTabFiles) === 'true';
	}

	firstVisibleFileInDirectory(dirPath: string): string | null {
		if (!dirPath) return null;
		const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
		for (const filePath of this.visibleFilePaths) {
			if (filePath.startsWith(prefix)) return filePath;
		}
		return null;
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

	applyTree(
		root: GitTreeNode[],
		hasCommits = this.hasCommits,
		statsState: GitTreeStatsState = this.statsState,
	): void {
		this.tree = root;
		this.hasCommits = hasCommits;
		this.statsState = statsState;
		this.rebuildIndexes();
	}

	reset(): void {
		this.tree = [];
		this.isLoadingTree = false;
		this.treeSearchQuery = '';
		this.hasCommits = true;
		this.statsState = 'pending';
		this.collapsedDirs = new Set();
		this.selectedFile = null;
		this.activeTab = 'unstaged';
		this.hideGenerated = false;
		this.filePathsValue = [];
		this.stagedFileNodesValue = [];
		this.unstagedFilePathsValue = [];
		this.stagedFilePathsValue = [];
		this.fileNodeByPath = new Map();
	}

	private shouldShowFilePath(filePath: string): boolean {
		const node = this.findTreeNode(filePath);
		if (!node) return false;
		return this.shouldShowFileCategory(node);
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

	private rebuildIndexes(): void {
		const filePaths: string[] = [];
		const stagedFileNodes: GitTreeNode[] = [];
		const unstagedFilePaths: string[] = [];
		const stagedFilePaths: string[] = [];
		const fileNodeByPath = new Map<string, GitTreeNode>();

		visitTree(this.tree, (node) => {
			if (node.kind !== 'file') return;
			filePaths.push(node.path);
			fileNodeByPath.set(node.path, node);
			if (node.staged) {
				stagedFilePaths.push(node.path);
				stagedFileNodes.push(node);
			}
			if (node.hasUnstaged || node.changeKind === 'untracked') {
				unstagedFilePaths.push(node.path);
			}
		});

		this.filePathsValue = filePaths;
		this.stagedFileNodesValue = stagedFileNodes;
		this.unstagedFilePathsValue = unstagedFilePaths;
		this.stagedFilePathsValue = stagedFilePaths;
		this.fileNodeByPath = fileNodeByPath;
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
				hasUnstaged: children.some(
					(child) => child.hasUnstaged || child.changeKind === 'untracked',
				),
				children,
			});
		}
	}
	return result;
}

function visitTree(nodes: GitTreeNode[], visitor: (node: GitTreeNode) => void): void {
	for (const node of nodes) {
		visitor(node);
		if (node.children) visitTree(node.children, visitor);
	}
}

export function collectStagedNodes(nodes: GitTreeNode[]): GitTreeNode[] {
	const result: GitTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'file' && node.staged) result.push(node);
		else if (node.children) result.push(...collectStagedNodes(node.children));
	}
	return result;
}

export function countFiles(nodes: GitTreeNode[]): number {
	let count = 0;
	for (const node of nodes) {
		if (node.kind === 'file') count++;
		else if (node.children) count += countFiles(node.children);
	}
	return count;
}

export function countFilesByPredicate(
	nodes: GitTreeNode[],
	predicate: (node: GitTreeNode) => boolean,
): number {
	let count = 0;
	for (const node of nodes) {
		if (node.kind === 'file' && predicate(node)) count++;
		else if (node.children) count += countFilesByPredicate(node.children, predicate);
	}
	return count;
}

export function collectFilePaths(nodes: GitTreeNode[]): string[] {
	const result: string[] = [];
	for (const node of nodes) {
		if (node.kind === 'file') {
			result.push(node.path);
		} else if (node.children) {
			result.push(...collectFilePaths(node.children));
		}
	}
	return result;
}

export function collectFilePathsByPredicate(
	nodes: GitTreeNode[],
	predicate: (node: GitTreeNode) => boolean,
): string[] {
	const result: string[] = [];
	for (const node of nodes) {
		if (node.kind === 'file' && predicate(node)) {
			result.push(node.path);
		} else if (node.children) {
			result.push(...collectFilePathsByPredicate(node.children, predicate));
		}
	}
	return result;
}

export function compactTree(nodes: GitTreeNode[]): GitTreeNode[] {
	return nodes.map((node) => {
		if (node.kind !== 'directory' || !node.children) return node;
		let children = compactTree(node.children);
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

export function filterTreeNodes(nodes: GitTreeNode[], query: string): GitTreeNode[] {
	const normalizedQuery = query.toLowerCase();
	const result: GitTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'directory') {
			const filteredChildren = filterTreeNodes(node.children ?? [], query);
			if (filteredChildren.length > 0) {
				result.push({ ...node, children: filteredChildren });
			}
			continue;
		}
		if (!normalizedQuery || node.path.toLowerCase().includes(normalizedQuery)) {
			result.push(node);
		}
	}
	return result;
}

export function findTreeNode(nodes: GitTreeNode[], filePath: string): GitTreeNode | undefined {
	for (const node of nodes) {
		if (node.path === filePath) return node;
		if (node.children) {
			const found = findTreeNode(node.children, filePath);
			if (found) return found;
		}
	}
	return undefined;
}
