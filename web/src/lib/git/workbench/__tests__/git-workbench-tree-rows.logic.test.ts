import { describe, expect, it } from 'vitest';
import type { GitTreeNode } from '$lib/api/git.js';
import {
	flattenGitWorkbenchTree,
	gitWorkbenchTreeRowKey,
} from '$lib/git/workbench/git-workbench-tree-rows.js';

function file(path: string): GitTreeNode {
	return {
		kind: 'file',
		path,
		name: path.split('/').at(-1) ?? path,
		staged: false,
		hasUnstaged: true,
	};
}

function directory(path: string, children: GitTreeNode[]): GitTreeNode {
	return {
		kind: 'directory',
		path,
		name: path,
		staged: false,
		hasUnstaged: true,
		children,
	};
}

describe('git workbench tree rows', () => {
	it('preserves workbench ordering while adding hierarchy metadata', () => {
		const tree = [
			directory('src', [file('src/a.ts'), directory('src/lib', [file('src/lib/b.ts')])]),
			file('README.md'),
		];

		const rows = flattenGitWorkbenchTree(tree, new Set());

		expect(rows.map((row) => row.key)).toEqual([
			'directory:src',
			'file:src/a.ts',
			'directory:src/lib',
			'file:src/lib/b.ts',
			'file:README.md',
		]);
		expect(
			rows.map(({ depth, parentDirectoryPath, positionInSet, setSize }) => ({
				depth,
				parentDirectoryPath,
				positionInSet,
				setSize,
			})),
		).toEqual([
			{ depth: 0, parentDirectoryPath: null, positionInSet: 1, setSize: 2 },
			{ depth: 1, parentDirectoryPath: 'src', positionInSet: 1, setSize: 2 },
			{ depth: 1, parentDirectoryPath: 'src', positionInSet: 2, setSize: 2 },
			{ depth: 2, parentDirectoryPath: 'src/lib', positionInSet: 1, setSize: 1 },
			{ depth: 0, parentDirectoryPath: null, positionInSet: 2, setSize: 2 },
		]);
	});

	it('omits descendants of collapsed directories without mutating the source tree', () => {
		const child = file('src/a.ts');
		const tree = [directory('src', [child]), file('README.md')];

		const rows = flattenGitWorkbenchTree(tree, new Set(['src']));

		expect(rows.map((row) => row.node.path)).toEqual(['src', 'README.md']);
		expect(tree[0]?.children).toEqual([child]);
	});

	it('keys compacted directory paths by their rendered identity', () => {
		expect(gitWorkbenchTreeRowKey({ kind: 'directory', path: 'src/lib/git' })).toBe(
			'directory:src/lib/git',
		);
	});
});
