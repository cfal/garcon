import type { GitChangeStats, GitTreeNode } from '$lib/api/git.js';
import type { QuickCommitPathIntent } from './commit-controller.svelte.js';
import { commitStatsForNode } from './commit-tree-reconciliation.js';

export const COMMIT_TREE_ROW_HEIGHT = 28;
export const COMMIT_TREE_ROW_OVERSCAN = 8;

export interface CommitDirectorySelection {
	readonly checked: boolean;
	readonly mixed: boolean;
	readonly isRunning: boolean;
	readonly error: string | null;
	readonly fileCount: number;
}

interface CommitTreeRowBase {
	readonly node: GitTreeNode;
	readonly depth: number;
}

export interface CommitDirectoryTreeRow extends CommitTreeRowBase {
	readonly kind: 'directory';
	readonly selection: CommitDirectorySelection;
}

export interface CommitFileTreeRow extends CommitTreeRowBase {
	readonly kind: 'file';
	readonly intent: QuickCommitPathIntent | null;
	readonly stats: GitChangeStats;
}

export type CommitTreeRow = CommitDirectoryTreeRow | CommitFileTreeRow;

interface DirectoryAggregate {
	fileCount: number;
	selectedCount: number;
	isRunning: boolean;
	error: string | null;
}

function emptyAggregate(): DirectoryAggregate {
	return {
		fileCount: 0,
		selectedCount: 0,
		isRunning: false,
		error: null,
	};
}

function mergeAggregate(target: DirectoryAggregate, source: DirectoryAggregate): void {
	target.fileCount += source.fileCount;
	target.selectedCount += source.selectedCount;
	target.isRunning ||= source.isRunning;
	target.error ??= source.error;
}

export function buildCommitTreeRows(
	nodes: readonly GitTreeNode[],
	intents: Readonly<Record<string, QuickCommitPathIntent>>,
): CommitTreeRow[] {
	const rows: CommitTreeRow[] = [];

	function visit(node: GitTreeNode, depth: number): DirectoryAggregate {
		if (node.kind === 'file') {
			const intent = intents[node.path] ?? null;
			rows.push({
				kind: 'file',
				node,
				depth,
				intent,
				stats: commitStatsForNode(node),
			});
			return intent
				? {
						fileCount: 1,
						selectedCount: intent.desiredSelected ? 1 : 0,
						isRunning: intent.isRunning,
						error: intent.error,
					}
				: emptyAggregate();
		}

		const rowIndex = rows.length;
		const aggregate = emptyAggregate();
		rows.push({
			kind: 'directory',
			node,
			depth,
			selection: {
				checked: false,
				mixed: false,
				isRunning: false,
				error: null,
				fileCount: 0,
			},
		});
		const children = node.children ?? [];
		for (const child of children) {
			mergeAggregate(aggregate, visit(child, depth + 1));
		}
		rows[rowIndex] = {
			kind: 'directory',
			node,
			depth,
			selection: {
				checked: aggregate.fileCount > 0 && aggregate.selectedCount === aggregate.fileCount,
				mixed: aggregate.selectedCount > 0 && aggregate.selectedCount < aggregate.fileCount,
				isRunning: aggregate.isRunning,
				error: aggregate.error,
				fileCount: aggregate.fileCount,
			},
		};
		return aggregate;
	}

	for (const node of nodes) visit(node, 0);
	return rows;
}
