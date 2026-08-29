import type { GitTreeNode } from '$lib/api/git.js';

export const GIT_WORKBENCH_TREE_ROW_HEIGHT = 28;
export const GIT_WORKBENCH_TREE_OVERSCAN = 12;

export interface GitWorkbenchTreeRow {
	readonly key: string;
	readonly node: GitTreeNode;
	readonly depth: number;
	readonly parentDirectoryPath: string | null;
	readonly positionInSet: number;
	readonly setSize: number;
}

export function gitWorkbenchTreeRowKey(node: Pick<GitTreeNode, 'kind' | 'path'>): string {
	return `${node.kind}:${node.path}`;
}

export function flattenGitWorkbenchTree(
	nodes: readonly GitTreeNode[],
	collapsedDirectories: ReadonlySet<string>,
): GitWorkbenchTreeRow[] {
	const rows: GitWorkbenchTreeRow[] = [];

	const append = (
		children: readonly GitTreeNode[],
		depth: number,
		parentDirectoryPath: string | null,
	): void => {
		for (const [index, node] of children.entries()) {
			rows.push({
				key: gitWorkbenchTreeRowKey(node),
				node,
				depth,
				parentDirectoryPath,
				positionInSet: index + 1,
				setSize: children.length,
			});
			if (node.kind === 'directory' && node.children && !collapsedDirectories.has(node.path)) {
				append(node.children, depth + 1, node.path);
			}
		}
	};

	append(nodes, 0, null);
	return rows;
}
