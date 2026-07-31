import type {
	FileTreeColumnKey,
	FileTreeViewMode,
	OptionalFileTreeColumnKey,
} from '$lib/files/tree/file-tree.svelte.js';

export interface FileTreeViewGeometry {
	readonly headerHeight: number;
	readonly fineRowHeight: number;
	readonly coarseRowHeight: number;
	readonly fineDisclosureSize: number;
	readonly coarseDisclosureSize: number;
}

interface FileTreeViewProfileBase {
	readonly gridTemplate: string;
	readonly fillerColumnKeys: readonly OptionalFileTreeColumnKey[];
	readonly accessibleColumnCount: number;
	readonly minimumTableWidth: string;
}

export type FileTreeViewProfile =
	| (FileTreeViewProfileBase & {
			readonly mode: 'columns';
			readonly columnDetailKeys: readonly OptionalFileTreeColumnKey[];
	  })
	| (FileTreeViewProfileBase & {
			readonly mode: 'details';
			readonly subtitleKeys: readonly OptionalFileTreeColumnKey[];
	  });

interface CreateFileTreeViewProfileOptions {
	readonly mode: FileTreeViewMode;
	readonly visibleColumnKeys: readonly FileTreeColumnKey[];
	readonly columnGridTemplate: string;
}

const FILE_TREE_VIEW_GEOMETRY = {
	columns: {
		headerHeight: 32,
		fineRowHeight: 28,
		coarseRowHeight: 36,
		fineDisclosureSize: 28,
		coarseDisclosureSize: 36,
	},
	details: {
		headerHeight: 0,
		fineRowHeight: 44,
		coarseRowHeight: 52,
		fineDisclosureSize: 28,
		coarseDisclosureSize: 36,
	},
} as const satisfies Readonly<Record<FileTreeViewMode, FileTreeViewGeometry>>;

export const FILE_TREE_HEADER_HEIGHT = FILE_TREE_VIEW_GEOMETRY.columns.headerHeight;
export const FILE_TREE_ROW_HEIGHT = FILE_TREE_VIEW_GEOMETRY.columns.fineRowHeight;
export const FILE_TREE_COARSE_ROW_HEIGHT = FILE_TREE_VIEW_GEOMETRY.columns.coarseRowHeight;

export function fileTreeViewGeometry(mode: FileTreeViewMode): FileTreeViewGeometry {
	return FILE_TREE_VIEW_GEOMETRY[mode];
}

export function createFileTreeViewProfile({
	mode,
	visibleColumnKeys,
	columnGridTemplate,
}: CreateFileTreeViewProfileOptions): FileTreeViewProfile {
	const detailKeys = visibleColumnKeys.filter(
		(key): key is OptionalFileTreeColumnKey => key !== 'name',
	);
	if (mode === 'details') {
		return {
			mode,
			gridTemplate: 'minmax(0, 1fr)',
			fillerColumnKeys: [],
			subtitleKeys: detailKeys,
			accessibleColumnCount: 1,
			minimumTableWidth: '240px',
		};
	}
	return {
		mode,
		gridTemplate: columnGridTemplate,
		fillerColumnKeys: detailKeys,
		columnDetailKeys: detailKeys,
		accessibleColumnCount: visibleColumnKeys.length,
		minimumTableWidth: visibleColumnKeys.length === 1 ? '240px' : '520px',
	};
}
