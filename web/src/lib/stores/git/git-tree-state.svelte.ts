import { getGitChangesTree, type GitDiffTab, type GitTreeNode } from '$lib/api/git.js';

export interface GitTreeLoadOptions {
	isCurrent: () => boolean;
	surfaceError: (message: string) => void;
}

export class GitTreeState {
	tree = $state<GitTreeNode[]>([]);
	isLoadingTree = $state(false);
	treeSearchQuery = $state('');
	hasCommits = $state(true);
	collapsedDirs = $state(new Set<string>());
	treePaneWidthPx = $state(300);

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
		return collectStagedNodes(this.tree);
	}

	get filePaths(): string[] {
		return collectFilePaths(this.tree);
	}

	visibleFilePaths(activeTab: GitDiffTab): string[] {
		const predicate =
			activeTab === 'staged'
				? (node: GitTreeNode) => node.staged
				: (node: GitTreeNode) => node.hasUnstaged || node.changeKind === 'untracked';
		return collectFilePathsByPredicate(this.filteredTree, predicate);
	}

	unstagedFileCount(): number {
		return countFilesByPredicate(
			this.tree,
			(node) => node.hasUnstaged || node.changeKind === 'untracked',
		);
	}

	stagedFileCount(): number {
		return countFilesByPredicate(this.tree, (node) => node.staged);
	}

	hasFile(filePath: string): boolean {
		return this.filePaths.includes(filePath);
	}

	findTreeNode(filePath: string): GitTreeNode | undefined {
		return findTreeNode(this.tree, filePath);
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
		localStorage.setItem('git.treePaneWidthPx', String(clamped));
	}

	loadTreePaneWidth(): void {
		const raw = localStorage.getItem('git.treePaneWidthPx');
		const width = raw ? Number(raw) : NaN;
		if (Number.isFinite(width)) this.setTreePaneWidth(width);
	}

	async loadTree(projectPath: string, options: GitTreeLoadOptions): Promise<boolean> {
		this.isLoadingTree = true;
		try {
			const data = await getGitChangesTree(projectPath);
			if (!options.isCurrent()) return false;
			this.tree = data.root;
			this.hasCommits = data.hasCommits;
			return true;
		} catch (error) {
			if (!options.isCurrent()) return false;
			options.surfaceError(
				`Failed to load changes: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.tree = [];
			return true;
		} finally {
			if (options.isCurrent()) this.isLoadingTree = false;
		}
	}

	reset(): void {
		this.tree = [];
		this.isLoadingTree = false;
		this.treeSearchQuery = '';
		this.hasCommits = true;
		this.collapsedDirs = new Set();
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
