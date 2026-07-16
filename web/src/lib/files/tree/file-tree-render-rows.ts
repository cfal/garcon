import type { FileTableRow } from './file-tree-rows.js';

export const FILE_TREE_PARENT_ROW_KEY = 'file-tree-parent-row';

export type FileTreeRenderRow =
	| { kind: 'parent'; key: string; level: 1; path: string }
	| FileTableRow
	| {
			kind: 'child-status';
			key: string;
			level: number;
			parentKey: string;
			directoryPath: string;
			directoryName: string;
			status: 'loading' | 'error';
	  };

export interface FileTreeRenderModel {
	rows: readonly FileTreeRenderRow[];
	renderIndexByKey: ReadonlyMap<string, number>;
}

export function isFileTreeRenderRowFocusable(row: FileTreeRenderRow | undefined): boolean {
	return Boolean(row && (row.kind !== 'child-status' || row.status === 'error'));
}

export function buildFileTreeRenderModel(args: {
	rows: readonly FileTableRow[];
	parentPath: string | null;
	expandedDirectories: ReadonlySet<string>;
	loadingDirectories: ReadonlySet<string>;
	childErrors: ReadonlyMap<string, unknown>;
}): FileTreeRenderModel {
	const rows: FileTreeRenderRow[] = [];
	const renderIndexByKey = new Map<string, number>();
	const append = (row: FileTreeRenderRow): void => {
		renderIndexByKey.set(row.key, rows.length);
		rows.push(row);
	};

	if (args.parentPath) {
		append({ kind: 'parent', key: FILE_TREE_PARENT_ROW_KEY, level: 1, path: args.parentPath });
	}

	for (const row of args.rows) {
		append(row);
		if (row.entry.type !== 'directory' || !args.expandedDirectories.has(row.entry.path)) {
			continue;
		}
		const status = args.loadingDirectories.has(row.entry.path)
			? 'loading'
			: args.childErrors.has(row.entry.path)
				? 'error'
				: null;
		if (!status) continue;
		append({
			kind: 'child-status',
			key: `file-tree-child-status:${row.key}`,
			level: row.level + 1,
			parentKey: row.key,
			directoryPath: row.entry.path,
			directoryName: row.entry.name,
			status,
		});
	}

	return { rows, renderIndexByKey };
}
