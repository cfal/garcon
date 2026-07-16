import { getTree } from '$lib/api/files.js';
import { ApiError } from '$lib/api/client.js';
import { buildVisibleFileRows, filterFileRows } from './file-tree-rows.js';
import { FILE_TREE_PARENT_ROW_KEY } from './file-tree-render-rows.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
	type LocalStorageKey,
} from '$lib/utils/local-persistence';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { FileTreeBreadcrumb, FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';

export type SortKey = 'name' | 'size' | 'modified' | 'permissions';
export type SortDirection = 'asc' | 'desc';

export const FILE_TREE_COLUMN_KEYS = ['name', 'size', 'modified', 'permissions'] as const;
export type FileTreeColumnKey = (typeof FILE_TREE_COLUMN_KEYS)[number];
export type OptionalFileTreeColumnKey = Exclude<FileTreeColumnKey, 'name'>;
export type FileTreeColumnWidths = Record<FileTreeColumnKey, number>;
export type FileTreeColumnVisibility = Record<OptionalFileTreeColumnKey, boolean>;

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

export interface FileTreeNavigationError {
	message: string;
	status?: number;
	errorCode?: string;
	retryable: boolean;
}

export type FileTreeDirectoryTargetReason =
	| 'initial'
	| 'directory-row'
	| 'parent-row'
	| 'breadcrumb'
	| 'chat-project';

export interface FileTreeDirectoryTarget {
	path: string;
	label: string;
	breadcrumbs: FileTreeBreadcrumb[];
	reason: FileTreeDirectoryTargetReason;
	focusPathOnSuccess?: string;
	captureAsChatProject?: boolean;
}

export type FileTreeNavigationState =
	| { kind: 'idle' }
	| {
			kind: 'loading';
			target: FileTreeDirectoryTarget;
			previous: FileTreeResponse | null;
	  }
	| { kind: 'ready'; response: FileTreeResponse }
	| {
			kind: 'error';
			target: FileTreeDirectoryTarget;
			previous: FileTreeResponse | null;
			error: FileTreeNavigationError;
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

function fileTreeNavigationError(error: unknown): FileTreeNavigationError {
	if (error instanceof ApiError) {
		return {
			message: error.message,
			status: error.status,
			errorCode: error.errorCode,
			retryable: error.retryable || error.status >= 500,
		};
	}
	return {
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
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

export class FileTreeStore {
	navigation = $state.raw<FileTreeNavigationState>({ kind: 'idle' });
	isRefreshing = $state(false);
	refreshError = $state.raw<FileTreeNavigationError | null>(null);

	childrenCache = $state.raw<Map<string, FileTreeEntry[]>>(new Map());
	loadingDirs = $state.raw<Set<string>>(new Set());
	expandedDirs = $state.raw<Set<string>>(new Set());
	childErrors = $state.raw<Map<string, FileTreeNavigationError>>(new Map());

	filterOpen = $state(false);
	filterInput = $state('');
	sortKey = $state<SortKey>('name');
	sortDirection = $state<SortDirection>('asc');
	foldersFirst = $state(true);
	showHiddenFiles = $state(true);
	showBreadcrumbs = $state(true);
	visibleColumns = $state.raw<FileTreeColumnVisibility>(
		copyColumnVisibility(DEFAULT_FILE_TREE_COLUMN_VISIBILITY),
	);
	columnWidths = $state.raw<FileTreeColumnWidths>(
		copyColumnWidths(DEFAULT_FILE_TREE_COLUMN_WIDTHS),
	);
	focusPathAfterNavigation = $state<string | null>(null);

	#projectPath = $state<string | null>(null);
	#canonicalChatProjectPath = $state<string | null>(null);
	#chatProjectBreadcrumbs = $state.raw<FileTreeBreadcrumb[]>([]);
	#effectiveProjectKey = $state('');
	#active = false;
	#navigationController: AbortController | null = null;
	#refreshController: AbortController | null = null;
	#navigationToken = 0;
	#refreshToken = 0;
	#childControllers = new Map<string, AbortController>();
	#materializedRows = $derived.by(() =>
		buildVisibleFileRows({
			rootEntries: this.rootEntries,
			childrenByDirectory: this.childrenCache,
			expandedDirectories: this.expandedDirs,
			sortEntries: (entries) => this.sortEntries(entries),
		}),
	);
	#filteredRows = $derived.by(() => filterFileRows(this.#materializedRows, this.filterInput));

	constructor() {
		this.#loadPreferences();
	}

	get projectPath(): string | null {
		return this.#projectPath;
	}

	get effectiveProjectKey(): string | null {
		return this.#effectiveProjectKey || null;
	}

	get readyResponse(): FileTreeResponse | null {
		return this.navigation.kind === 'ready' ? this.navigation.response : null;
	}

	get retainedResponse(): FileTreeResponse | null {
		if (this.navigation.kind === 'ready') return this.navigation.response;
		if (this.navigation.kind === 'loading' || this.navigation.kind === 'error') {
			return this.navigation.previous;
		}
		return null;
	}

	get fileRootPath(): string | null {
		return this.retainedResponse?.fileRootPath ?? null;
	}

	get currentDirectoryPath(): string | null {
		return this.readyResponse?.directory.path ?? null;
	}

	get currentBreadcrumbs(): readonly FileTreeBreadcrumb[] {
		if (this.navigation.kind === 'ready') return this.navigation.response.directory.breadcrumbs;
		if (this.navigation.kind === 'loading' || this.navigation.kind === 'error') {
			return this.navigation.target.breadcrumbs;
		}
		return [];
	}

	get currentDirectoryLabel(): string {
		const breadcrumb = this.currentBreadcrumbs.at(-1);
		if (breadcrumb) return breadcrumb.name;
		if (this.navigation.kind === 'loading' || this.navigation.kind === 'error') {
			return this.navigation.target.label;
		}
		return this.#projectPath ?? '';
	}

	get parentPath(): string | null {
		return this.readyResponse?.directory.parentPath ?? null;
	}

	get rootEntries(): readonly FileTreeEntry[] {
		return this.readyResponse?.entries ?? [];
	}

	get isNavigationLoading(): boolean {
		return this.navigation.kind === 'loading';
	}

	get isAtChatProject(): boolean {
		return Boolean(
			this.#canonicalChatProjectPath &&
			this.currentDirectoryPath === this.#canonicalChatProjectPath,
		);
	}

	get visibleColumnKeys(): FileTreeColumnKey[] {
		return FILE_TREE_COLUMN_KEYS.filter((column) => this.isColumnVisible(column));
	}

	get columnGridTemplate(): string {
		return this.visibleColumnKeys.map((key) => `minmax(0, ${this.columnWidths[key]}fr)`).join(' ');
	}

	get materializedRows() {
		return this.#materializedRows;
	}

	get filteredRows() {
		return this.#filteredRows;
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		if (projectState.kind === 'resolving') return;
		if (projectState.kind === 'absent') {
			this.#projectPath = null;
			this.#effectiveProjectKey = '';
			this.#canonicalChatProjectPath = null;
			this.#chatProjectBreadcrumbs = [];
			this.#resetBrowsingState();
			return;
		}

		const { project } = projectState;
		this.#projectPath = project.projectPath;
		if (project.effectiveProjectKey === this.#effectiveProjectKey) {
			this.#resumePendingWork();
			return;
		}

		this.#resetBrowsingState();
		this.#effectiveProjectKey = project.effectiveProjectKey;
		this.#canonicalChatProjectPath = null;
		this.#chatProjectBreadcrumbs = [];
		if (this.#active) void this.navigateTo(this.#initialTarget());
	}

	activate(): void {
		if (this.#active) return;
		this.#active = true;
		this.#resumePendingWork();
	}

	deactivate(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#abortRequests();
	}

	reset(): void {
		this.#active = false;
		this.#projectPath = null;
		this.#effectiveProjectKey = '';
		this.#canonicalChatProjectPath = null;
		this.#chatProjectBreadcrumbs = [];
		this.#resetBrowsingState();
	}

	async navigateTo(target: FileTreeDirectoryTarget): Promise<void> {
		const previous = this.retainedResponse;
		this.#clearFilter();
		this.#clearDirectoryCaches();
		this.navigation = { kind: 'loading', target, previous };
		if (!this.#active) return;
		await this.#performNavigation(target, previous);
	}

	async enterDirectory(entry: FileTreeEntry): Promise<void> {
		if (entry.type !== 'directory') return;
		await this.navigateTo({
			path: entry.path,
			label: entry.name,
			breadcrumbs: [...this.currentBreadcrumbs, { name: entry.name, path: entry.path }],
			reason: 'directory-row',
			focusPathOnSuccess: FILE_TREE_PARENT_ROW_KEY,
		});
	}

	async goToParent(): Promise<void> {
		const response = this.readyResponse;
		const parentPath = response?.directory.parentPath;
		if (!response || !parentPath) return;
		const breadcrumbs = response.directory.breadcrumbs.slice(0, -1);
		await this.navigateTo({
			path: parentPath,
			label: breadcrumbs.at(-1)?.name ?? parentPath,
			breadcrumbs,
			reason: 'parent-row',
			focusPathOnSuccess: response.directory.path,
		});
	}

	async navigateToBreadcrumb(index: number): Promise<void> {
		const breadcrumbs = [...this.currentBreadcrumbs];
		const breadcrumb = breadcrumbs[index];
		if (!breadcrumb || index === breadcrumbs.length - 1) return;
		await this.navigateTo({
			path: breadcrumb.path,
			label: breadcrumb.name,
			breadcrumbs: breadcrumbs.slice(0, index + 1),
			reason: 'breadcrumb',
			focusPathOnSuccess: breadcrumbs[index + 1]?.path,
		});
	}

	async goToChatProject(): Promise<void> {
		const path = this.#canonicalChatProjectPath ?? this.#projectPath;
		if (!path || this.isAtChatProject) return;
		const captureAsChatProject = this.#canonicalChatProjectPath === null;
		await this.navigateTo({
			path,
			label: this.#chatProjectBreadcrumbs.at(-1)?.name ?? path,
			breadcrumbs: [...this.#chatProjectBreadcrumbs],
			reason: 'chat-project',
			focusPathOnSuccess: FILE_TREE_PARENT_ROW_KEY,
			captureAsChatProject,
		});
	}

	async retryNavigation(): Promise<void> {
		if (this.navigation.kind !== 'error') return;
		const { target, previous } = this.navigation;
		this.navigation = { kind: 'loading', target, previous };
		if (!this.#active) return;
		await this.#performNavigation(target, previous);
	}

	backFromNavigationError(): void {
		if (this.navigation.kind !== 'error') return;
		this.navigation = this.navigation.previous
			? { kind: 'ready', response: this.navigation.previous }
			: { kind: 'idle' };
		this.refreshError = null;
	}

	async refresh(): Promise<void> {
		const response = this.readyResponse;
		if (!response || this.isRefreshing || !this.#active) return;
		this.#refreshController?.abort();
		const controller = new AbortController();
		const token = ++this.#refreshToken;
		const directoryPath = response.directory.path;
		this.#refreshController = controller;
		this.isRefreshing = true;
		this.refreshError = null;
		try {
			const refreshed = await getTree({ directoryPath }, { signal: controller.signal });
			if (
				controller.signal.aborted ||
				token !== this.#refreshToken ||
				this.readyResponse?.directory.path !== directoryPath
			) {
				return;
			}
			const expandedPaths = [...this.expandedDirs];
			this.navigation = { kind: 'ready', response: refreshed };
			this.#abortChildren();
			this.childrenCache = new Map();
			this.childErrors = new Map();
			this.expandedDirs = new Set(expandedPaths);
			for (const path of expandedPaths) void this.fetchChildren(path);
		} catch (error) {
			if (isAbortError(error) || token !== this.#refreshToken) return;
			this.refreshError = fileTreeNavigationError(error);
		} finally {
			if (this.#refreshController === controller) {
				this.#refreshController = null;
				this.isRefreshing = false;
			}
		}
	}

	dismissRefreshError(): void {
		this.refreshError = null;
	}

	toggleDirectory(path: string): void {
		const expanded = new Set(this.expandedDirs);
		if (expanded.has(path)) {
			expanded.delete(path);
		} else {
			expanded.add(path);
			if (!this.childrenCache.has(path)) void this.fetchChildren(path);
		}
		this.expandedDirs = expanded;
	}

	async fetchChildren(path: string): Promise<void> {
		if (!this.#active || this.childrenCache.has(path) || this.loadingDirs.has(path)) {
			return;
		}
		const controller = new AbortController();
		this.#childControllers.get(path)?.abort();
		this.#childControllers.set(path, controller);
		this.loadingDirs = new Set(this.loadingDirs).add(path);
		const errors = new Map(this.childErrors);
		errors.delete(path);
		this.childErrors = errors;
		try {
			const response = await getTree({ directoryPath: path }, { signal: controller.signal });
			if (controller.signal.aborted || this.#childControllers.get(path) !== controller) return;
			const cache = new Map(this.childrenCache);
			cache.set(path, response.entries);
			this.childrenCache = cache;
		} catch (error) {
			if (isAbortError(error) || this.#childControllers.get(path) !== controller) return;
			const nextErrors = new Map(this.childErrors);
			nextErrors.set(path, fileTreeNavigationError(error));
			this.childErrors = nextErrors;
		} finally {
			if (this.#childControllers.get(path) === controller) {
				this.#childControllers.delete(path);
				const loading = new Set(this.loadingDirs);
				loading.delete(path);
				this.loadingDirs = loading;
			}
		}
	}

	retryDirectory(path: string): void {
		const cache = new Map(this.childrenCache);
		cache.delete(path);
		this.childrenCache = cache;
		const errors = new Map(this.childErrors);
		errors.delete(path);
		this.childErrors = errors;
		const expanded = new Set(this.expandedDirs);
		expanded.add(path);
		this.expandedDirs = expanded;
		void this.fetchChildren(path);
	}

	openFilter(): void {
		this.filterOpen = true;
	}

	closeFilter(): void {
		this.filterOpen = false;
		this.filterInput = '';
	}

	clearFilter(): void {
		this.filterInput = '';
	}

	setSortKey(key: SortKey): void {
		this.sortKey = key;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortKey, key);
	}

	setSortDirection(direction: SortDirection): void {
		this.sortDirection = direction;
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeSortDirection, direction);
	}

	toggleSort(key: SortKey): void {
		if (this.sortKey === key) {
			this.setSortDirection(this.sortDirection === 'asc' ? 'desc' : 'asc');
			return;
		}
		this.setSortKey(key);
		this.setSortDirection('asc');
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

	setColumnVisible(column: OptionalFileTreeColumnKey, visible: boolean): void {
		this.visibleColumns = { ...this.visibleColumns, [column]: visible };
		this.#persist(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility, JSON.stringify(this.visibleColumns));
		if (!visible && this.sortKey === column) {
			this.setSortKey('name');
			this.setSortDirection('asc');
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

	consumeFocusPathAfterNavigation(): string | null {
		const path = this.focusPathAfterNavigation;
		this.focusPathAfterNavigation = null;
		return path;
	}

	#initialTarget(): FileTreeDirectoryTarget {
		const path = this.#projectPath ?? '';
		return {
			path,
			label: path,
			breadcrumbs: [],
			reason: 'initial',
			captureAsChatProject: true,
		};
	}

	#resumePendingWork(): void {
		if (!this.#active || !this.#effectiveProjectKey || !this.#projectPath) return;
		if (this.navigation.kind === 'idle') {
			void this.navigateTo(this.#initialTarget());
			return;
		}
		if (this.navigation.kind === 'loading' && !this.#navigationController) {
			void this.#performNavigation(this.navigation.target, this.navigation.previous);
			return;
		}
		if (this.navigation.kind === 'ready') {
			for (const path of this.expandedDirs) {
				if (!this.childrenCache.has(path) && !this.loadingDirs.has(path)) {
					void this.fetchChildren(path);
				}
			}
		}
	}

	async #performNavigation(
		target: FileTreeDirectoryTarget,
		previous: FileTreeResponse | null,
	): Promise<void> {
		this.#navigationController?.abort();
		this.#abortRefresh();
		this.#abortChildren();
		const controller = new AbortController();
		const token = ++this.#navigationToken;
		this.#navigationController = controller;
		this.navigation = { kind: 'loading', target, previous };
		try {
			const response = await getTree({ directoryPath: target.path }, { signal: controller.signal });
			if (controller.signal.aborted || token !== this.#navigationToken) return;
			this.navigation = { kind: 'ready', response };
			this.refreshError = null;
			this.focusPathAfterNavigation = target.focusPathOnSuccess ?? null;
			if (target.captureAsChatProject) {
				this.#canonicalChatProjectPath = response.directory.path;
				this.#chatProjectBreadcrumbs = [...response.directory.breadcrumbs];
			}
		} catch (error) {
			if (isAbortError(error) || token !== this.#navigationToken) return;
			this.navigation = {
				kind: 'error',
				target,
				previous,
				error: fileTreeNavigationError(error),
			};
		} finally {
			if (this.#navigationController === controller) this.#navigationController = null;
		}
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
					(left.modified ? new Date(left.modified).getTime() : 0) -
					(right.modified ? new Date(right.modified).getTime() : 0);
				break;
			case 'permissions':
				comparison = left.permissionsRwx.localeCompare(right.permissionsRwx, undefined, {
					sensitivity: 'base',
				});
				break;
			case 'name':
			default:
				comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
				break;
		}
		if (comparison === 0) {
			comparison = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
		}
		return this.sortDirection === 'asc' ? comparison : -comparison;
	}

	#clearFilter(): void {
		this.filterOpen = false;
		this.filterInput = '';
	}

	#clearDirectoryCaches(): void {
		this.#abortChildren();
		this.childrenCache = new Map();
		this.expandedDirs = new Set();
		this.loadingDirs = new Set();
		this.childErrors = new Map();
	}

	#abortChildren(): void {
		for (const controller of this.#childControllers.values()) controller.abort();
		this.#childControllers.clear();
		this.loadingDirs = new Set();
	}

	#abortRequests(): void {
		this.#navigationController?.abort();
		this.#navigationController = null;
		this.#navigationToken += 1;
		this.#abortRefresh();
		this.#abortChildren();
	}

	#abortRefresh(): void {
		this.#refreshController?.abort();
		this.#refreshController = null;
		this.#refreshToken += 1;
		this.isRefreshing = false;
	}

	#resetBrowsingState(): void {
		this.#abortRequests();
		this.navigation = { kind: 'idle' };
		this.refreshError = null;
		this.focusPathAfterNavigation = null;
		this.#clearFilter();
		this.#clearDirectoryCaches();
	}

	#loadPreferences(): void {
		const sortKey = getLocalStorageItem(LOCAL_STORAGE_KEYS.fileTreeSortKey);
		if (sortKey && FILE_TREE_COLUMN_KEYS.includes(sortKey as FileTreeColumnKey)) {
			this.sortKey = sortKey as SortKey;
		}
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
