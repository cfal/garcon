import type {
	FileTreeColumnKey,
	FileTreeViewPreference,
	OptionalFileTreeColumnKey,
} from '$lib/files/tree/file-tree.svelte.js';

export const FILE_TREE_VIEW_MODES = ['columns', 'details'] as const;
export type FileTreeViewMode = (typeof FILE_TREE_VIEW_MODES)[number];

export const FILE_TREE_NAME_ONLY_MINIMUM_WIDTH_PX = 240;
export const FILE_TREE_MULTI_COLUMN_MINIMUM_WIDTH_PX = 520;
export const FILE_TREE_DETAILS_MINIMUM_WIDTH_PX = 240;

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
	readonly minimumTableWidthPx: number;
	readonly entryIconSizePx: number;
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

interface ResolveFileTreeViewModeOptions {
	readonly preference: FileTreeViewPreference;
	readonly containerWidth: number;
	readonly visibleColumnKeys: readonly FileTreeColumnKey[];
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

export function resolveFileTreeViewMode({
	preference,
	containerWidth,
	visibleColumnKeys,
}: ResolveFileTreeViewModeOptions): FileTreeViewMode {
	if (preference === 'always-details') return 'details';
	if (!visibleColumnKeys.some((key) => key !== 'name')) return 'columns';
	return containerWidth < FILE_TREE_MULTI_COLUMN_MINIMUM_WIDTH_PX ? 'details' : 'columns';
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
			minimumTableWidthPx: FILE_TREE_DETAILS_MINIMUM_WIDTH_PX,
			entryIconSizePx: 32,
		};
	}
	return {
		mode,
		gridTemplate: columnGridTemplate,
		fillerColumnKeys: detailKeys,
		columnDetailKeys: detailKeys,
		accessibleColumnCount: visibleColumnKeys.length,
		minimumTableWidthPx:
			visibleColumnKeys.length === 1
				? FILE_TREE_NAME_ONLY_MINIMUM_WIDTH_PX
				: FILE_TREE_MULTI_COLUMN_MINIMUM_WIDTH_PX,
		entryIconSizePx: 16,
	};
}
