import type { GitCommitFileSummary } from '$lib/api/git.js';

export interface GitChangedFileDirectoryNode {
	kind: 'directory';
	name: string;
	path: string;
	children: GitChangedFileTreeNode[];
}

export interface GitChangedFileNode {
	kind: 'file';
	name: string;
	path: string;
	file: GitCommitFileSummary;
}

export type GitChangedFileTreeNode = GitChangedFileDirectoryNode | GitChangedFileNode;

export interface GitChangedFileTreeRow {
	key: string;
	node: GitChangedFileTreeNode;
	depth: number;
	parentDirectoryPath: string | null;
	positionInSet: number;
	setSize: number;
}

interface MutableDirectoryNode {
	name: string;
	path: string;
	directories: Map<string, MutableDirectoryNode>;
	files: GitChangedFileNode[];
}

export function buildGitChangedFileTree(
	files: readonly GitCommitFileSummary[],
): GitChangedFileTreeNode[] {
	const root = createMutableDirectory('', '');

	for (const file of files) {
		const segments = file.path.split('/').filter(Boolean);
		const name = segments.pop();
		if (!name) continue;

		let directory = root;
		for (const segment of segments) {
			const path = directory.path ? `${directory.path}/${segment}` : segment;
			let child = directory.directories.get(segment);
			if (!child) {
				child = createMutableDirectory(segment, path);
				directory.directories.set(segment, child);
			}
			directory = child;
		}
		directory.files.push({ kind: 'file', name, path: file.path, file });
	}

	return finalizeChildren(root);
}

export function flattenGitChangedFileTree(
	nodes: readonly GitChangedFileTreeNode[],
	collapsedDirectories: ReadonlySet<string>,
): GitChangedFileTreeRow[] {
	const rows: GitChangedFileTreeRow[] = [];

	const append = (
		children: readonly GitChangedFileTreeNode[],
		depth: number,
		parentDirectoryPath: string | null,
	): void => {
		for (const [index, node] of children.entries()) {
			rows.push({
				key: `${node.kind}:${node.path}`,
				node,
				depth,
				parentDirectoryPath,
				positionInSet: index + 1,
				setSize: children.length,
			});
			if (node.kind === 'directory' && !collapsedDirectories.has(node.path)) {
				append(node.children, depth + 1, node.path);
			}
		}
	};

	append(nodes, 0, null);
	return rows;
}

function createMutableDirectory(name: string, path: string): MutableDirectoryNode {
	return {
		name,
		path,
		directories: new Map(),
		files: [],
	};
}

function finalizeChildren(directory: MutableDirectoryNode): GitChangedFileTreeNode[] {
	const directories = [...directory.directories.values()]
		.sort((left, right) => compareNames(left.name, right.name))
		.map(finalizeDirectory);
	const files = [...directory.files].sort((left, right) => compareNames(left.name, right.name));
	return [...directories, ...files];
}

function finalizeDirectory(directory: MutableDirectoryNode): GitChangedFileDirectoryNode {
	let name = directory.name;
	let path = directory.path;
	let children = finalizeChildren(directory);

	while (children.length === 1 && children[0]?.kind === 'directory') {
		const child = children[0];
		name = `${name}/${child.name}`;
		path = child.path;
		children = child.children;
	}

	return {
		kind: 'directory',
		name,
		path,
		children,
	};
}

function compareNames(left: string, right: string): number {
	return left.localeCompare(right, undefined, {
		numeric: true,
		sensitivity: 'base',
	});
}
