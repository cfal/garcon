import {
	getGitChangesStats,
	getGitChangesTree,
	type GitChangesStatsResult,
	type GitDiffTab,
	type GitTreeNode,
	type GitTreeStatsState,
} from '$lib/api/git.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export interface GitTreeLoadOptions {
	isCurrent: () => boolean;
	surfaceError: (message: string) => void;
}

export class GitTreeState {
	tree = $state<GitTreeNode[]>([]);
	isLoadingTree = $state(false);
	treeSearchQuery = $state('');
	hasCommits = $state(true);
	statsState = $state<GitTreeStatsState>('pending');
	collapsedDirs = $state(new Set<string>());
	treePaneWidthPx = $state(300);
	private filePathsValue = $state<string[]>([]);
	private stagedFileNodesValue = $state<GitTreeNode[]>([]);
	private unstagedFilePathsValue = $state<string[]>([]);
	private stagedFilePathsValue = $state<string[]>([]);
	private fileNodeByPath = new Map<string, GitTreeNode>();

	get filteredTree(): GitTreeNode[] {
		return compactTree(filterTreeNodes(this.tree, this.treeSearchQuery));
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

	visibleFilePaths(activeTab: GitDiffTab): string[] {
		const paths = activeTab === 'staged' ? this.stagedFilePathsValue : this.unstagedFilePathsValue;
		if (!this.treeSearchQuery) return paths;
		const visible = new Set(collectFilePaths(this.filteredTree));
		return paths.filter((path) => visible.has(path));
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
		const clamped = Math.max(220, Math.min(560, Math.round(next)));
		this.treePaneWidthPx = clamped;
		setLocalStorageItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx, String(clamped));
	}

	loadTreePaneWidth(): void {
		const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
		const width = raw ? Number(raw) : NaN;
		if (Number.isFinite(width)) this.setTreePaneWidth(width);
	}

	async loadTree(projectPath: string, options: GitTreeLoadOptions): Promise<boolean> {
		this.isLoadingTree = true;
		try {
			const data = await getGitChangesTree(projectPath);
			if (!options.isCurrent()) return false;
			this.applyTree(data.root, data.hasCommits, data.statsState ?? 'pending');
			return true;
		} catch (error) {
			if (!options.isCurrent()) return false;
			options.surfaceError(
				`Failed to load changes: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.applyTree([], this.hasCommits, 'pending');
			return true;
		} finally {
			if (options.isCurrent()) this.isLoadingTree = false;
		}
	}

	async hydrateStats(projectPath: string, options: GitTreeLoadOptions): Promise<boolean> {
		try {
			const stats = await getGitChangesStats(projectPath);
			if (!options.isCurrent()) return false;
			this.applyStats(stats);
			return true;
		} catch (error) {
			if (!options.isCurrent()) return false;
			options.surfaceError(
				`Failed to load change counts: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
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

	applyStats(stats: GitChangesStatsResult): void {
		this.tree = applyStatsToNodes(this.tree, stats);
		this.statsState = 'loaded';
		this.rebuildIndexes();
	}

	reset(): void {
		this.tree = [];
		this.isLoadingTree = false;
		this.treeSearchQuery = '';
		this.hasCommits = true;
		this.statsState = 'pending';
		this.collapsedDirs = new Set();
		this.filePathsValue = [];
		this.stagedFileNodesValue = [];
		this.unstagedFilePathsValue = [];
		this.stagedFilePathsValue = [];
		this.fileNodeByPath = new Map();
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

function visitTree(nodes: GitTreeNode[], visitor: (node: GitTreeNode) => void): void {
	for (const node of nodes) {
		visitor(node);
		if (node.children) visitTree(node.children, visitor);
	}
}

function statsForFile(node: GitTreeNode, stats: GitChangesStatsResult): GitTreeNode {
	if (!node.unstagedFacet && !node.stagedFacet) return node;
	const unstagedStats = node.unstagedFacet ? stats.working[node.path] : undefined;
	const stagedStats = node.stagedFacet ? stats.staged[node.path] : undefined;
	const primaryStats = unstagedStats ?? stagedStats ?? { additions: 0, deletions: 0 };
	const nextNode: GitTreeNode = {
		...node,
		additions: primaryStats.additions,
		deletions: primaryStats.deletions,
	};
	if (node.unstagedFacet) {
		nextNode.unstagedFacet = {
			...node.unstagedFacet,
			stats: unstagedStats ?? { additions: 0, deletions: 0 },
		};
	}
	if (node.stagedFacet) {
		nextNode.stagedFacet = {
			...node.stagedFacet,
			stats: stagedStats ?? { additions: 0, deletions: 0 },
		};
	}
	return nextNode;
}

function applyStatsToNodes(nodes: GitTreeNode[], stats: GitChangesStatsResult): GitTreeNode[] {
	return nodes.map((node) => {
		if (node.kind === 'file') return statsForFile(node, stats);

		const children = node.children ? applyStatsToNodes(node.children, stats) : [];
		const totals = children.reduce(
			(acc, child) => ({
				additions: acc.additions + (child.additions ?? 0),
				deletions: acc.deletions + (child.deletions ?? 0),
			}),
			{ additions: 0, deletions: 0 },
		);
		return {
			...node,
			children,
			additions: totals.additions,
			deletions: totals.deletions,
		};
	});
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
