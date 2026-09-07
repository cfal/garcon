import type {
	GitChangeStats,
	GitFileChangeFacet,
	GitStatusCode,
	GitTreeNode,
} from '$lib/api/git.js';

export type QuickCommitStageMode = 'stage' | 'unstage';

export function flattenCommitFileNodes(nodes: GitTreeNode[]): GitTreeNode[] {
	const result: GitTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === 'file') {
			result.push(node);
			continue;
		}
		if (node.children) result.push(...flattenCommitFileNodes(node.children));
	}
	return result;
}

export function findCommitTreeNode(
	nodes: GitTreeNode[],
	path: string,
): GitTreeNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		if (node.children) {
			const match = findCommitTreeNode(node.children, path);
			if (match) return match;
		}
	}
	return null;
}

export function commitStatsForNode(node: GitTreeNode): GitChangeStats {
	return (
		node.stagedFacet?.stats ??
		node.unstagedFacet?.stats ?? {
			additions: node.additions ?? 0,
			deletions: node.deletions ?? 0,
		}
	);
}

export function reconcileCommitTreeAfterStage(
	nodes: GitTreeNode[],
	paths: Set<string>,
	staged: boolean,
): { nodes: GitTreeNode[]; changed: boolean } {
	let changed = false;
	const next = nodes.map((node) => {
		if (node.kind === 'file') {
			if (!paths.has(node.path)) return node;
			changed = true;
			return reconcileFileNodeAfterStage(node, staged);
		}
		if (!node.children) return node;
		const childResult = reconcileCommitTreeAfterStage(node.children, paths, staged);
		if (!childResult.changed) return node;
		changed = true;
		return aggregateDirectoryNode(node, childResult.nodes);
	});
	return { nodes: next, changed };
}

function mergeStats(...stats: Array<GitChangeStats | undefined>): GitChangeStats {
	let additions = 0;
	let deletions = 0;
	let isBinary = false;
	for (const item of stats) {
		if (!item) continue;
		additions += item.additions ?? 0;
		deletions += item.deletions ?? 0;
		isBinary = isBinary || Boolean(item.isBinary);
	}
	return { additions, deletions, ...(isBinary ? { isBinary: true } : {}) };
}

function facetForStage(node: GitTreeNode): GitFileChangeFacet | undefined {
	const stagedFacet = node.stagedFacet;
	const unstagedFacet = node.unstagedFacet;
	const source = unstagedFacet ?? stagedFacet;
	if (!source) return undefined;
	const stats = mergeStats(stagedFacet?.stats, unstagedFacet?.stats);
	return {
		...source,
		status: source.status === '?' ? 'A' : source.status,
		changeKind: source.changeKind === 'untracked' ? 'added' : source.changeKind,
		stats,
	};
}

function facetForUnstage(node: GitTreeNode): GitFileChangeFacet | undefined {
	const stagedFacet = node.stagedFacet;
	const unstagedFacet = node.unstagedFacet;
	const source = unstagedFacet ?? stagedFacet;
	if (!source) return undefined;
	const addedOnly = stagedFacet?.changeKind === 'added' && !unstagedFacet;
	const changeKind = addedOnly ? 'untracked' : source.changeKind;
	const status: GitStatusCode = addedOnly ? '?' : source.status;
	return {
		...source,
		status,
		changeKind,
		stats: mergeStats(unstagedFacet?.stats, stagedFacet?.stats),
	};
}

function reconcileFileNodeAfterStage(
	node: GitTreeNode,
	staged: boolean,
): GitTreeNode {
	if (staged) {
		const stagedFacet = facetForStage(node);
		return {
			...node,
			indexStatus: stagedFacet?.status ?? 'M',
			workTreeStatus: ' ',
			stagedFacet,
			unstagedFacet: undefined,
			changeKind: stagedFacet?.changeKind ?? node.changeKind,
			staged: true,
			hasUnstaged: false,
			additions: stagedFacet?.stats.additions ?? node.additions,
			deletions: stagedFacet?.stats.deletions ?? node.deletions,
			category: stagedFacet?.category ?? node.category,
		};
	}

	const unstagedFacet = facetForUnstage(node);
	return {
		...node,
		indexStatus: ' ',
		workTreeStatus: unstagedFacet?.status ?? 'M',
		stagedFacet: undefined,
		unstagedFacet,
		changeKind: unstagedFacet?.changeKind ?? node.changeKind,
		staged: false,
		hasUnstaged: true,
		additions: unstagedFacet?.stats.additions ?? node.additions,
		deletions: unstagedFacet?.stats.deletions ?? node.deletions,
		category: unstagedFacet?.category ?? node.category,
	};
}

function aggregateDirectoryNode(
	node: GitTreeNode,
	children: GitTreeNode[],
): GitTreeNode {
	let staged = false;
	let hasUnstaged = false;
	let additions = 0;
	let deletions = 0;
	let stagedFacet: GitFileChangeFacet | undefined;
	let unstagedFacet: GitFileChangeFacet | undefined;
	for (const child of children) {
		staged = staged || child.staged;
		hasUnstaged = hasUnstaged || child.hasUnstaged;
		additions += child.additions ?? 0;
		deletions += child.deletions ?? 0;
		stagedFacet = stagedFacet ?? child.stagedFacet;
		unstagedFacet = unstagedFacet ?? child.unstagedFacet;
	}
	return {
		...node,
		children,
		staged,
		hasUnstaged,
		stagedFacet,
		unstagedFacet,
		changeKind: unstagedFacet?.changeKind ?? stagedFacet?.changeKind,
		indexStatus: staged ? 'M' : ' ',
		workTreeStatus: hasUnstaged ? 'M' : ' ',
		additions,
		deletions,
	};
}
