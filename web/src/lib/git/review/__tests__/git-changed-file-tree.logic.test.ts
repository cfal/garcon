import { describe, expect, it } from 'vitest';
import type { GitCommitFileSummary, GitCommitFileStatus } from '$lib/api/git.js';
import { buildGitChangedFileTree, flattenGitChangedFileTree } from '../git-changed-file-tree.js';

function changedFile(path: string, status: GitCommitFileStatus): GitCommitFileSummary {
	return {
		path,
		status,
		rawStatus: status.slice(0, 1).toUpperCase(),
		category: 'normal',
		additions: 1,
		deletions: 1,
		estimatedRows: 2,
		bodyState: 'unloaded',
		bodyFingerprint: `fp-${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

describe('git changed file tree', () => {
	it('groups paths, compacts single-directory chains, and sorts directories first', () => {
		const tree = buildGitChangedFileTree([
			changedFile('README.md', 'modified'),
			changedFile('src/lib/z.ts', 'deleted'),
			changedFile('src/lib/a.ts', 'added'),
			changedFile('docs/guide.md', 'modified'),
		]);

		expect(tree.map((node) => [node.kind, node.name])).toEqual([
			['directory', 'docs'],
			['directory', 'src/lib'],
			['file', 'README.md'],
		]);
		const source = tree[1];
		expect(source?.kind).toBe('directory');
		if (source?.kind !== 'directory') return;
		expect(source.children.map((node) => node.name)).toEqual(['a.ts', 'z.ts']);
	});

	it('flattens expanded directories and omits collapsed descendants', () => {
		const tree = buildGitChangedFileTree([
			changedFile('src/lib/a.ts', 'added'),
			changedFile('src/lib/b.ts', 'modified'),
			changedFile('root.ts', 'modified'),
		]);

		const expanded = flattenGitChangedFileTree(tree, new Set());
		expect(expanded.map((row) => row.key)).toEqual([
			'directory:src/lib',
			'file:src/lib/a.ts',
			'file:src/lib/b.ts',
			'file:root.ts',
		]);
		expect(expanded[1]).toMatchObject({
			depth: 1,
			parentDirectoryPath: 'src/lib',
			positionInSet: 1,
			setSize: 2,
		});
		expect(expanded[3]).toMatchObject({ positionInSet: 2, setSize: 2 });

		const collapsed = flattenGitChangedFileTree(tree, new Set(['src/lib']));
		expect(collapsed.map((row) => row.key)).toEqual(['directory:src/lib', 'file:root.ts']);
	});
});
