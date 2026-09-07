import { describe, expect, it } from 'vitest';
import type { GitTreeNode } from '$lib/api/git.js';
import type { QuickCommitPathIntent } from '../commit-controller.svelte.js';
import { buildCommitTreeRows } from '../commit-tree-rows.js';

function fileNode(path: string, overrides: Partial<GitTreeNode> = {}): GitTreeNode {
	return {
		path,
		name: path.split('/').at(-1) ?? path,
		kind: 'file',
		staged: false,
		hasUnstaged: true,
		additions: 1,
		deletions: 0,
		...overrides,
	};
}

function directoryNode(path: string, children: GitTreeNode[]): GitTreeNode {
	return {
		path,
		name: path.split('/').at(-1) ?? path,
		kind: 'directory',
		staged: children.some((child) => child.staged),
		hasUnstaged: children.some((child) => child.hasUnstaged),
		children,
	};
}

function intent(
	path: string,
	overrides: Partial<QuickCommitPathIntent> = {},
): QuickCommitPathIntent {
	return {
		path,
		desiredSelected: false,
		actualSelected: false,
		isRunning: false,
		runningMode: null,
		error: null,
		...overrides,
	};
}

describe('buildCommitTreeRows', () => {
	it('builds exact preorder depth, file stats, and descendant directory selection', () => {
		const tree = [
			directoryNode('src', [
				fileNode('src/a.ts', {
					staged: true,
					hasUnstaged: false,
					stagedFacet: {
						status: 'M',
						changeKind: 'modified',
						stats: { additions: 7, deletions: 2 },
					},
				}),
				directoryNode('src/nested', [fileNode('src/nested/b.ts')]),
			]),
			fileNode('root.ts'),
		];
		const rows = buildCommitTreeRows(tree, {
			'src/a.ts': intent('src/a.ts', {
				desiredSelected: true,
				actualSelected: true,
			}),
			'src/nested/b.ts': intent('src/nested/b.ts', {
				isRunning: true,
				error: 'stage failed',
			}),
			'root.ts': intent('root.ts', { desiredSelected: true, actualSelected: true }),
		});

		expect(rows.map((row) => [row.kind, row.node.path, row.depth])).toEqual([
			['directory', 'src', 0],
			['file', 'src/a.ts', 1],
			['directory', 'src/nested', 1],
			['file', 'src/nested/b.ts', 2],
			['file', 'root.ts', 0],
		]);
		expect(rows[0]).toMatchObject({
			kind: 'directory',
			selection: {
				checked: false,
				mixed: true,
				isRunning: true,
				error: 'stage failed',
				fileCount: 2,
			},
		});
		expect(rows[2]).toMatchObject({
			kind: 'directory',
			selection: {
				checked: false,
				mixed: false,
				isRunning: true,
				error: 'stage failed',
				fileCount: 1,
			},
		});
		expect(rows[1]).toMatchObject({
			kind: 'file',
			stats: { additions: 7, deletions: 2 },
		});
	});

	it('reads each directory child collection once while emitting one row per node', () => {
		let childReads = 0;
		const children = Array.from({ length: 500 }, (_, index) => fileNode(`src/${index}.ts`));
		const directory = {
			path: 'src',
			name: 'src',
			kind: 'directory',
			staged: false,
			hasUnstaged: true,
			get children() {
				childReads += 1;
				return children;
			},
		} satisfies GitTreeNode;
		const intents = Object.fromEntries(children.map((node) => [node.path, intent(node.path)]));

		const rows = buildCommitTreeRows([directory], intents);

		expect(rows).toHaveLength(501);
		expect(rows.at(-1)?.node.path).toBe('src/499.ts');
		expect(childReads).toBe(1);
	});
});
