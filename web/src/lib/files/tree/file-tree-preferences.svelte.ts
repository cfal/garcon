import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
	type LocalStorageKey,
} from '$lib/utils/local-persistence';
import type { FileTreeEntry } from '$shared/file-contracts';

export type SortDirection = 'asc' | 'desc';

const FILE_TREE_COLUMN_KEYS = ['name', 'size', 'modified', 'permissions'] as const;
export type FileTreeColumnKey = (typeof FILE_TREE_COLUMN_KEYS)[number];
export type OptionalFileTreeColumnKey = Exclude<FileTreeColumnKey, 'name'>;
export type SortKey = FileTreeColumnKey;
export type FileTreeColumnWidths = Record<FileTreeColumnKey, number>;
export type FileTreeColumnVisibility = Record<OptionalFileTreeColumnKey, boolean>;

const FILE_TREE_VIEW_PREFERENCES = ['responsive', 'always-details'] as const;
export type FileTreeViewPreference = (typeof FILE_TREE_VIEW_PREFERENCES)[number];

export const DEFAULT_FILE_TREE_COLUMN_WIDTHS: Readonly<FileTreeColumnWidths> = {
	name: 42,
	size: 16.5,
	modified: 25,
	permissions: 16.5,
};

export const FILE_TREE_COLUMN_MIN_WIDTHS: Readonly<FileTreeColumnWidths> = {
	name: 20,
	size: 8,
	modified: 12,
	permissions: 10,
};

export const DEFAULT_FILE_TREE_COLUMN_VISIBILITY: Readonly<FileTreeColumnVisibility> = {
	size: true,
	modified: true,
	permissions: false,
};

function copyColumnWidths(widths: Readonly<FileTreeColumnWidths>): FileTreeColumnWidths {
	return { ...widths };
}

function copyColumnVisibility(
	visibility: Readonly<FileTreeColumnVisibility>,
): FileTreeColumnVisibility {
	return { ...visibility };
}

function parseColumnWidths(raw: string | null): FileTreeColumnWidths | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		const widths = {} as FileTreeColumnWidths;
		for (const key of FILE_TREE_COLUMN_KEYS) {
			const width = value[key];
			if (typeof width !== 'number' || !Number.isFinite(width)) return null;
			if (width < FILE_TREE_COLUMN_MIN_WIDTHS[key]) return null;
			widths[key] = width;
		}
		const total = FILE_TREE_COLUMN_KEYS.reduce((sum, key) => sum + widths[key], 0);
		return Math.abs(total - 100) < 0.01 ? widths : null;
	} catch {
		return null;
	}
}

function parseColumnVisibility(raw: string | null): FileTreeColumnVisibility | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof value.size !== 'boolean' ||
			typeof value.modified !== 'boolean' ||
			typeof value.permissions !== 'boolean'
		) {
			return null;
		}
		return {
			size: value.size,
			modified: value.modified,
			permissions: value.permissions,
		};
	} catch {
		return null;
	}
}

function isFileTreeViewPreference(value: string | null): value is FileTreeViewPreference {
	return value !== null && FILE_TREE_VIEW_PREFERENCES.includes(value as FileTreeViewPreference);
}

function isSortKey(value: string): value is SortKey {
	return FILE_TREE_COLUMN_KEYS.includes(value as FileTreeColumnKey);
}

export function resizeVisibleFileTreeColumnBoundary(
	widths: Readonly<FileTreeColumnWidths>,
	visibleColumns: readonly FileTreeColumnKey[],
	leftColumn: FileTreeColumnKey,
	deltaPercentagePoints: number,
): FileTreeColumnWidths {
	const leftIndex = visibleColumns.indexOf(leftColumn);
	const rightColumn = visibleColumns[leftIndex + 1];
	if (!rightColumn || !Number.isFinite(deltaPercentagePoints)) return copyColumnWidths(widths);

	const visibleWeight = visibleColumns.reduce((sum, column) => sum + widths[column], 0);
	const weightDelta = (deltaPercentagePoints / 100) * visibleWeight;
	const pairWeight = widths[leftColumn] + widths[rightColumn];
	const maximumLeft = pairWeight - FILE_TREE_COLUMN_MIN_WIDTHS[rightColumn];
	const nextLeft = Math.min(
		maximumLeft,
		Math.max(FILE_TREE_COLUMN_MIN_WIDTHS[leftColumn], widths[leftColumn] + weightDelta),
	);

	return {
		...widths,
		[leftColumn]: Math.round(nextLeft * 1000) / 1000,
		[rightColumn]: Math.round((pairWeight - nextLeft) * 1000) / 1000,
	};
}

const fileTreeCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export class FileTreePreferences {
	sortKey = $state<SortKey>('name');
	sortDirection = $state<SortDirection>('asc');
	foldersFirst = $state(true);
	showHiddenFiles = $state(true);
	showBreadcrumbs = $state(true);
	showIcons = $state(true);
	viewPreference = $state<FileTreeViewPreference>('responsive');
	visibleColumns = $state.raw<FileTreeColumnVisibility>(
		copyColumnVisibility(DEFAULT_FILE_TREE_COLUMN_VISIBILITY),
	);
	columnWidths = $state.raw<FileTreeColumnWidths>(
		copyColumnWidths(DEFAULT_FILE_TREE_COLUMN_WIDTHS),
	);

	constructor() {
		this.#loadPreferences();
	}

	get visibleColumnKeys(): FileTreeColumnKey[] {
		return FILE_TREE_COLUMN_KEYS.filter((column) => this.isColumnVisible(column));
	}

	get columnGridTemplate(): string {
		return this.visibleColumnKeys.map((key) => `minmax(0, ${this.columnWidths[key]}fr)`).join(' ');
	}

	setViewPreference(preference: FileTreeViewPreference): void {
		if (preference === this.viewPreference) return;
		this.viewPreference = preference;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeViewPreference, preference);
	}

	setAlwaysUseDetailedRows(always: boolean): void {
		this.setViewPreference(always ? 'always-details' : 'responsive');
	}

	selectSortKey(value: string): void {
		if (!isSortKey(value) || !this.isColumnVisible(value) || value === this.sortKey) return;
		this.setSort(value, 'asc');
	}

	setSort(key: SortKey, direction: SortDirection): void {
		this.sortKey = key;
		this.sortDirection = direction;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortKey, key);
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortDirection, direction);
	}

	setSortDirection(direction: SortDirection): void {
		this.setSort(this.sortKey, direction);
	}

	toggleSort(key: SortKey): void {
		this.setSort(key, this.sortKey === key && this.sortDirection === 'asc' ? 'desc' : 'asc');
	}

	setFoldersFirst(value: boolean): void {
		this.foldersFirst = value;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeFoldersFirst, String(value));
	}

	setShowHiddenFiles(value: boolean): void {
		this.showHiddenFiles = value;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeShowHiddenFiles, String(value));
	}

	setShowBreadcrumbs(value: boolean): void {
		this.showBreadcrumbs = value;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs, String(value));
	}

	setShowIcons(value: boolean): void {
		this.showIcons = value;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeShowIcons, String(value));
	}

	setColumnVisible(column: OptionalFileTreeColumnKey, visible: boolean): void {
		this.visibleColumns = { ...this.visibleColumns, [column]: visible };
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility, JSON.stringify(this.visibleColumns));
		if (!visible && this.sortKey === column) {
			this.setSort('name', 'asc');
		}
	}

	isColumnVisible(column: FileTreeColumnKey): boolean {
		return column === 'name' || this.visibleColumns[column];
	}

	previewColumnWidths(widths: Readonly<FileTreeColumnWidths>): void {
		this.columnWidths = copyColumnWidths(widths);
	}

	commitColumnWidths(): void {
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeColumnWidths, JSON.stringify(this.columnWidths));
	}

	setColumnWidths(widths: Readonly<FileTreeColumnWidths>): void {
		this.previewColumnWidths(widths);
		this.commitColumnWidths();
	}

	resetColumnWidths(): void {
		this.setColumnWidths(DEFAULT_FILE_TREE_COLUMN_WIDTHS);
	}

	sortEntries(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
		const visibleEntries = this.showHiddenFiles
			? entries
			: entries.filter((entry) => !entry.name.startsWith('.'));
		return [...visibleEntries].sort((left, right) => this.#compareEntries(left, right));
	}

	#compareEntries(left: FileTreeEntry, right: FileTreeEntry): number {
		if (this.foldersFirst && left.type !== right.type) {
			return left.type === 'directory' ? -1 : 1;
		}

		let comparison: number;
		switch (this.sortKey) {
			case 'size':
				comparison =
					(left.type === 'file' ? left.size : 0) - (right.type === 'file' ? right.size : 0);
				break;
			case 'modified':
				comparison =
					(left.modified ? Date.parse(left.modified) : 0) -
					(right.modified ? Date.parse(right.modified) : 0);
				break;
			case 'permissions':
				comparison = fileTreeCollator.compare(left.permissionsRwx, right.permissionsRwx);
				break;
			case 'name':
			default:
				comparison = fileTreeCollator.compare(left.name, right.name);
				break;
		}
		if (comparison === 0) {
			comparison = fileTreeCollator.compare(left.name, right.name);
		}
		return this.sortDirection === 'asc' ? comparison : -comparison;
	}

	#loadPreferences(): void {
		const sortKey = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeSortKey);
		if (sortKey && isSortKey(sortKey)) this.sortKey = sortKey;
		const sortDirection = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeSortDirection);
		if (sortDirection === 'asc' || sortDirection === 'desc') {
			this.sortDirection = sortDirection;
		}
		const foldersFirst = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeFoldersFirst);
		if (foldersFirst === 'true' || foldersFirst === 'false') {
			this.foldersFirst = foldersFirst === 'true';
		}
		const showHiddenFiles = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeShowHiddenFiles);
		if (showHiddenFiles === 'true' || showHiddenFiles === 'false') {
			this.showHiddenFiles = showHiddenFiles === 'true';
		}
		const showBreadcrumbs = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs);
		if (showBreadcrumbs === 'true' || showBreadcrumbs === 'false') {
			this.showBreadcrumbs = showBreadcrumbs === 'true';
		}
		const showIcons = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeShowIcons);
		if (showIcons === 'true' || showIcons === 'false') {
			this.showIcons = showIcons === 'true';
		}
		const viewPreference = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeViewPreference);
		if (isFileTreeViewPreference(viewPreference)) this.viewPreference = viewPreference;
		const visibility = parseColumnVisibility(
			getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility),
		);
		if (visibility) this.visibleColumns = visibility;
		const widths = parseColumnWidths(getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeColumnWidths));
		if (widths) this.columnWidths = widths;
		if (!this.isColumnVisible(this.sortKey)) {
			this.sortKey = 'name';
			this.sortDirection = 'asc';
		}
	}

	#persist(key: LocalStorageKey, value: string): void {
		setLocalStorageItem(key, value);
	}
}
