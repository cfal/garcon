import { buildVisibleFileRows, filterFileRows } from './file-tree-rows.js';
import { FileTreeDirectoryLoader } from './file-tree-directory-loader.svelte.js';
import { FileTreePreferences } from './file-tree-preferences.svelte.js';
import type {
	FileTreeViewPreference,
	SortKey,
	SortDirection,
	OptionalFileTreeColumnKey,
	FileTreeColumnKey,
	FileTreeColumnWidths,
} from './file-tree-preferences.svelte.js';
import type { FileTreeDirectoryTarget } from './file-tree-navigation.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { FileTreeEntry } from '$shared/file-contracts';

export {
	DEFAULT_FILE_TREE_COLUMN_VISIBILITY,
	DEFAULT_FILE_TREE_COLUMN_WIDTHS,
	FILE_TREE_COLUMN_MIN_WIDTHS,
	resizeVisibleFileTreeColumnBoundary,
	type FileTreeColumnKey,
	type FileTreeColumnWidths,
	type FileTreeColumnVisibility,
	type FileTreeViewPreference,
	type OptionalFileTreeColumnKey,
	type SortDirection,
	type SortKey,
} from './file-tree-preferences.svelte.js';

export class FileTreeStore {
	readonly #preferences = new FileTreePreferences();
	readonly #directories: FileTreeDirectoryLoader = new FileTreeDirectoryLoader({
		clearFilter: () => this.closeFilter(),
		visibleRows: () => this.#materializedRows,
	});

	filterOpen = $state(false);
	filterInput = $state('');

	#materializedRows = $derived.by(() =>
		buildVisibleFileRows({
			rootEntries: this.rootEntries,
			childrenByDirectory: this.childrenCache,
			expandedDirectories: this.expandedDirs,
			sortEntries: (entries) => this.sortEntries(entries),
		}),
	);
	#filteredRows = $derived.by(() => filterFileRows(this.#materializedRows, this.filterInput));

	get materializedRows() {
		return this.#materializedRows;
	}

	get filteredRows() {
		return this.#filteredRows;
	}

	get knownFiles(): readonly FileTreeEntry[] {
		return this.#materializedRows.flatMap((row) => (row.entry.type === 'file' ? [row.entry] : []));
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

	get executorId() {
		return this.#directories.executorId;
	}

	get navigation() {
		return this.#directories.navigation;
	}
	set navigation(value: FileTreeDirectoryLoader['navigation']) {
		this.#directories.navigation = value;
	}

	get isRefreshing() {
		return this.#directories.isRefreshing;
	}
	set isRefreshing(value: FileTreeDirectoryLoader['isRefreshing']) {
		this.#directories.isRefreshing = value;
	}

	get refreshError() {
		return this.#directories.refreshError;
	}
	set refreshError(value: FileTreeDirectoryLoader['refreshError']) {
		this.#directories.refreshError = value;
	}

	get childrenCache() {
		return this.#directories.childrenCache;
	}
	set childrenCache(value: FileTreeDirectoryLoader['childrenCache']) {
		this.#directories.childrenCache = value;
	}

	get loadingDirs() {
		return this.#directories.loadingDirs;
	}
	set loadingDirs(value: FileTreeDirectoryLoader['loadingDirs']) {
		this.#directories.loadingDirs = value;
	}

	get expandedDirs() {
		return this.#directories.expandedDirs;
	}
	set expandedDirs(value: FileTreeDirectoryLoader['expandedDirs']) {
		this.#directories.expandedDirs = value;
	}

	get childErrors() {
		return this.#directories.childErrors;
	}
	set childErrors(value: FileTreeDirectoryLoader['childErrors']) {
		this.#directories.childErrors = value;
	}

	get focusPathAfterNavigation() {
		return this.#directories.focusPathAfterNavigation;
	}
	set focusPathAfterNavigation(value: FileTreeDirectoryLoader['focusPathAfterNavigation']) {
		this.#directories.focusPathAfterNavigation = value;
	}

	get projectPath() {
		return this.#directories.projectPath;
	}

	get effectiveProjectKey() {
		return this.#directories.effectiveProjectKey;
	}

	get readyResponse() {
		return this.#directories.readyResponse;
	}

	get retainedResponse() {
		return this.#directories.retainedResponse;
	}

	get fileRootPath() {
		return this.#directories.fileRootPath;
	}

	get homeDirectory() {
		return this.#directories.homeDirectory;
	}

	get currentDirectoryPath() {
		return this.#directories.currentDirectoryPath;
	}

	get currentBreadcrumbs() {
		return this.#directories.currentBreadcrumbs;
	}

	get currentDirectoryLabel() {
		return this.#directories.currentDirectoryLabel;
	}

	get parentPath() {
		return this.#directories.parentPath;
	}

	get rootEntries() {
		return this.#directories.rootEntries;
	}

	get isNavigationLoading() {
		return this.#directories.isNavigationLoading;
	}

	get isAtChatProject() {
		return this.#directories.isAtChatProject;
	}

	get isAtHome() {
		return this.#directories.isAtHome;
	}

	browseExecutor(executorId: string): void {
		this.#directories.browseExecutor(executorId);
	}

	setExecutorAvailable(available: boolean): void {
		this.#directories.setExecutorAvailable(available);
	}

	invalidateExecutorPaths(): void {
		this.#directories.invalidateExecutorPaths();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.#directories.setProjectState(projectState);
	}

	activate(): void {
		this.#directories.activate();
	}

	deactivate(): void {
		this.#directories.deactivate();
	}

	reset(): void {
		this.#directories.reset();
	}

	navigateTo(target: FileTreeDirectoryTarget): Promise<void> {
		return this.#directories.navigateTo(target);
	}

	enterDirectory(entry: FileTreeEntry): Promise<void> {
		return this.#directories.enterDirectory(entry);
	}

	goToParent(): Promise<void> {
		return this.#directories.goToParent();
	}

	navigateToBreadcrumb(index: number): Promise<void> {
		return this.#directories.navigateToBreadcrumb(index);
	}

	goToHome(): Promise<void> {
		return this.#directories.goToHome();
	}

	goToChatProject(): Promise<void> {
		return this.#directories.goToChatProject();
	}

	revealFile(relativePath: string): Promise<boolean> {
		return this.#directories.revealFile(relativePath);
	}

	retryNavigation(): Promise<void> {
		return this.#directories.retryNavigation();
	}

	backFromNavigationError(): void {
		this.#directories.backFromNavigationError();
	}

	refresh(): Promise<void> {
		return this.#directories.refresh();
	}

	dismissRefreshError(): void {
		this.#directories.dismissRefreshError();
	}

	toggleDirectory(path: string): void {
		this.#directories.toggleDirectory(path);
	}

	fetchChildren(path: string): Promise<void> {
		return this.#directories.fetchChildren(path);
	}

	retryDirectory(path: string): void {
		this.#directories.retryDirectory(path);
	}

	consumeFocusPathAfterNavigation(): string | null {
		return this.#directories.consumeFocusPathAfterNavigation();
	}

	get sortKey() {
		return this.#preferences.sortKey;
	}
	set sortKey(value: FileTreePreferences['sortKey']) {
		this.#preferences.sortKey = value;
	}

	get sortDirection() {
		return this.#preferences.sortDirection;
	}
	set sortDirection(value: FileTreePreferences['sortDirection']) {
		this.#preferences.sortDirection = value;
	}

	get foldersFirst() {
		return this.#preferences.foldersFirst;
	}
	set foldersFirst(value: FileTreePreferences['foldersFirst']) {
		this.#preferences.foldersFirst = value;
	}

	get showHiddenFiles() {
		return this.#preferences.showHiddenFiles;
	}
	set showHiddenFiles(value: FileTreePreferences['showHiddenFiles']) {
		this.#preferences.showHiddenFiles = value;
	}

	get showBreadcrumbs() {
		return this.#preferences.showBreadcrumbs;
	}
	set showBreadcrumbs(value: FileTreePreferences['showBreadcrumbs']) {
		this.#preferences.showBreadcrumbs = value;
	}

	get showIcons() {
		return this.#preferences.showIcons;
	}
	set showIcons(value: FileTreePreferences['showIcons']) {
		this.#preferences.showIcons = value;
	}

	get viewPreference() {
		return this.#preferences.viewPreference;
	}
	set viewPreference(value: FileTreePreferences['viewPreference']) {
		this.#preferences.viewPreference = value;
	}

	get visibleColumns() {
		return this.#preferences.visibleColumns;
	}
	set visibleColumns(value: FileTreePreferences['visibleColumns']) {
		this.#preferences.visibleColumns = value;
	}

	get columnWidths() {
		return this.#preferences.columnWidths;
	}
	set columnWidths(value: FileTreePreferences['columnWidths']) {
		this.#preferences.columnWidths = value;
	}

	get visibleColumnKeys() {
		return this.#preferences.visibleColumnKeys;
	}

	get columnGridTemplate() {
		return this.#preferences.columnGridTemplate;
	}

	setViewPreference(preference: FileTreeViewPreference): void {
		this.#preferences.setViewPreference(preference);
	}

	setAlwaysUseDetailedRows(always: boolean): void {
		this.#preferences.setAlwaysUseDetailedRows(always);
	}

	selectSortKey(value: string): void {
		this.#preferences.selectSortKey(value);
	}

	setSort(key: SortKey, direction: SortDirection): void {
		this.#preferences.setSort(key, direction);
	}

	setSortDirection(direction: SortDirection): void {
		this.#preferences.setSortDirection(direction);
	}

	toggleSort(key: SortKey): void {
		this.#preferences.toggleSort(key);
	}

	setFoldersFirst(value: boolean): void {
		this.#preferences.setFoldersFirst(value);
	}

	setShowHiddenFiles(value: boolean): void {
		this.#preferences.setShowHiddenFiles(value);
		this.#directories.reconcileDirectoryDemand();
	}

	setShowBreadcrumbs(value: boolean): void {
		this.#preferences.setShowBreadcrumbs(value);
	}

	setShowIcons(value: boolean): void {
		this.#preferences.setShowIcons(value);
	}

	setColumnVisible(column: OptionalFileTreeColumnKey, visible: boolean): void {
		this.#preferences.setColumnVisible(column, visible);
	}

	isColumnVisible(column: FileTreeColumnKey): boolean {
		return this.#preferences.isColumnVisible(column);
	}

	previewColumnWidths(widths: Readonly<FileTreeColumnWidths>): void {
		this.#preferences.previewColumnWidths(widths);
	}

	commitColumnWidths(): void {
		this.#preferences.commitColumnWidths();
	}

	setColumnWidths(widths: Readonly<FileTreeColumnWidths>): void {
		this.#preferences.setColumnWidths(widths);
	}

	resetColumnWidths(): void {
		this.#preferences.resetColumnWidths();
	}

	sortEntries(entries: readonly FileTreeEntry[]): FileTreeEntry[] {
		return this.#preferences.sortEntries(entries);
	}
}
