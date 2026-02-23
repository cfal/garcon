// Reactive store for the file tree panel. Owns all file browsing state,
// API interactions, sorting, filtering, and preference persistence so the
// component remains a thin rendering shell.

import { getTree, type FileTreeNode } from '$lib/api/files.js';

export type SortKey = 'name' | 'size' | 'modified' | 'permissions';
export type SortDirection = 'asc' | 'desc';

const STORAGE_SORT_KEY = 'file-tree-sort-key';
const STORAGE_SORT_DIR_KEY = 'file-tree-sort-direction';
const STORAGE_FOLDERS_FIRST_KEY = 'file-tree-folders-first';
const STORAGE_SHOW_HIDDEN_KEY = 'file-tree-show-hidden-files';

export class FileTreeStore {
	rootFiles = $state<FileTreeNode[]>([]);
	childrenCache = $state<Map<string, FileTreeNode[]>>(new Map());
	loadingDirs = $state<Set<string>>(new Set());
	expandedDirs = $state<Set<string>>(new Set());
	isLoading = $state(false);

	searchInput = $state('');
	debouncedQuery = $state('');
	sortKey = $state<SortKey>('name');
	sortDirection = $state<SortDirection>('asc');
	foldersFirst = $state(true);
	showHiddenFiles = $state(true);

	#projectPath: string | null = null;
	#chatId: string | null = null;
	#rootController: AbortController | null = null;
	#rootToken = 0;
	#childControllers = new Map<string, AbortController>();
	#currentRootKey = '';

	constructor() {
		this.#loadPreferences();
	}

	// Initializes the store for a given project/chat combination.
	// Resets state and fetches root when the key changes.
	init(projectPath: string | null, chatId: string | null): void {
		const key = chatId && projectPath ? `${chatId}::${projectPath}` : '';
		if (!key) {
			this.#projectPath = projectPath;
			this.#chatId = chatId;
			this.#resetState();
			return;
		}
		if (key === this.#currentRootKey) return;

		this.#projectPath = projectPath;
		this.#chatId = chatId;
		this.#currentRootKey = key;
		void this.fetchRoot();
	}

	reset(): void {
		this.#rootController?.abort();
		for (const ctrl of this.#childControllers.values()) ctrl.abort();
		this.#childControllers.clear();
		this.#resetState();
	}

	#resetState(): void {
		this.rootFiles = [];
		this.childrenCache = new Map();
		this.expandedDirs = new Set();
		this.loadingDirs = new Set();
		this.isLoading = false;
		this.#currentRootKey = '';
	}

	// Fetches the root directory listing.
	async fetchRoot(): Promise<void> {
		this.#rootController?.abort();
		const controller = new AbortController();
		this.#rootController = controller;
		const token = ++this.#rootToken;
		this.isLoading = true;

		try {
			const data = await getTree(
				{ chatId: this.#chatId, projectPath: this.#projectPath },
				{ signal: controller.signal },
			);
			if (controller.signal.aborted || token !== this.#rootToken) return;
			this.rootFiles = data;
			this.childrenCache = new Map();
			this.expandedDirs = new Set();
			this.loadingDirs = new Set();
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'AbortError') return;
			console.error('[FileTree] Failed to fetch root:', err);
			if (token === this.#rootToken) this.rootFiles = [];
		} finally {
			if (token === this.#rootToken) {
				this.isLoading = false;
				this.#rootController = null;
			}
		}
	}

	// Fetches children for a given directory path.
	async fetchChildren(dirPath: string): Promise<void> {
		if (this.childrenCache.has(dirPath) || this.loadingDirs.has(dirPath)) return;

		const nextLoading = new Set(this.loadingDirs);
		nextLoading.add(dirPath);
		this.loadingDirs = nextLoading;

		this.#childControllers.get(dirPath)?.abort();
		const controller = new AbortController();
		this.#childControllers.set(dirPath, controller);

		try {
			const children = await getTree(
				{ chatId: this.#chatId, projectPath: this.#projectPath, dirPath },
				{ signal: controller.signal },
			);
			if (controller.signal.aborted) return;
			const updated = new Map(this.childrenCache);
			updated.set(dirPath, children);
			this.childrenCache = updated;
		} catch (err: unknown) {
			if (err instanceof Error && err.name === 'AbortError') return;
			console.error(`[FileTree] Failed to fetch ${dirPath}:`, err);
		} finally {
			const done = new Set(this.loadingDirs);
			done.delete(dirPath);
			this.loadingDirs = done;
			this.#childControllers.delete(dirPath);
		}
	}

	// Re-fetches root from scratch.
	refresh(): void {
		this.#currentRootKey = '';
		void this.fetchRoot();
	}

	// Toggles a directory's expanded state. Fetches children on first expand.
	toggleDirectory(path: string): void {
		const next = new Set(this.expandedDirs);
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
			if (!this.childrenCache.has(path)) {
				void this.fetchChildren(path);
			}
		}
		this.expandedDirs = next;
	}

	// Returns children for a node if available.
	getChildren(item: FileTreeNode): FileTreeNode[] | null {
		if (item.children) return item.children;
		const cached = this.childrenCache.get(item.path);
		if (!cached) return null;
		return this.#sortNodes(cached);
	}

	// Sort/filter preference setters that also persist to localStorage.

	setSortKey(key: SortKey): void {
		this.sortKey = key;
		this.#persist(STORAGE_SORT_KEY, key);
	}

	setSortDirection(dir: SortDirection): void {
		this.sortDirection = dir;
		this.#persist(STORAGE_SORT_DIR_KEY, dir);
	}

	setFoldersFirst(value: boolean): void {
		this.foldersFirst = value;
		this.#persist(STORAGE_FOLDERS_FIRST_KEY, String(value));
	}

	setShowHiddenFiles(value: boolean): void {
		this.showHiddenFiles = value;
		this.#persist(STORAGE_SHOW_HIDDEN_KEY, String(value));
	}

	toggleSort(key: SortKey): void {
		if (this.sortKey === key) {
			this.setSortDirection(this.sortDirection === 'asc' ? 'desc' : 'asc');
		} else {
			this.setSortKey(key);
			this.setSortDirection('asc');
		}
	}

	// Applies visibility filter and sorts a node array.
	#sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
		let filtered = nodes;
		if (!this.showHiddenFiles) {
			filtered = nodes.filter((n) => !n.name.startsWith('.'));
		}
		return [...filtered].sort((a, b) => this.#compareNodes(a, b));
	}

	#compareNodes(a: FileTreeNode, b: FileTreeNode): number {
		if (this.foldersFirst && a.type !== b.type) {
			return a.type === 'directory' ? -1 : 1;
		}

		let cmp = 0;
		switch (this.sortKey) {
			case 'size': {
				const av = a.type === 'file' ? (a.size ?? 0) : 0;
				const bv = b.type === 'file' ? (b.size ?? 0) : 0;
				cmp = av - bv;
				break;
			}
			case 'modified': {
				const av = a.modified ? new Date(a.modified).getTime() : 0;
				const bv = b.modified ? new Date(b.modified).getTime() : 0;
				cmp = av - bv;
				break;
			}
			case 'permissions':
				cmp = (a.permissionsRwx ?? '').toLowerCase().localeCompare(
					(b.permissionsRwx ?? '').toLowerCase(), undefined, { sensitivity: 'base' },
				);
				break;
			case 'name':
			default:
				cmp = a.name.toLowerCase().localeCompare(
					b.name.toLowerCase(), undefined, { sensitivity: 'base' },
				);
				break;
		}

		if (cmp === 0) {
			cmp = a.name.toLowerCase().localeCompare(
				b.name.toLowerCase(), undefined, { sensitivity: 'base' },
			);
		}
		return this.sortDirection === 'asc' ? cmp : -cmp;
	}

	// Builds the sorted/filtered tree for display.
	buildTree(items: FileTreeNode[]): FileTreeNode[] {
		return this.#sortNodes(items).map((item) => {
			if (item.type === 'directory' && this.childrenCache.has(item.path)) {
				return { ...item, children: this.buildTree(this.childrenCache.get(item.path) ?? []) };
			}
			return item;
		});
	}

	// Recursively filters the tree by search query.
	filterTree(items: FileTreeNode[], query: string): FileTreeNode[] {
		return items.reduce<FileTreeNode[]>((acc, item) => {
			const matches = item.name.toLowerCase().includes(query);
			let filteredChildren: FileTreeNode[] = [];
			if (item.type === 'directory' && item.children) {
				filteredChildren = this.filterTree(item.children, query);
			}
			if (matches || filteredChildren.length > 0) {
				acc.push({ ...item, children: filteredChildren });
			}
			return acc;
		}, []);
	}

	#loadPreferences(): void {
		try {
			const sk = localStorage.getItem(STORAGE_SORT_KEY);
			if (sk && ['name', 'size', 'modified', 'permissions'].includes(sk)) {
				this.sortKey = sk as SortKey;
			}
			const sd = localStorage.getItem(STORAGE_SORT_DIR_KEY);
			if (sd && ['asc', 'desc'].includes(sd)) {
				this.sortDirection = sd as SortDirection;
			}
			const ff = localStorage.getItem(STORAGE_FOLDERS_FIRST_KEY);
			if (ff === 'true' || ff === 'false') this.foldersFirst = ff === 'true';
			const sh = localStorage.getItem(STORAGE_SHOW_HIDDEN_KEY);
			if (sh === 'true' || sh === 'false') this.showHiddenFiles = sh === 'true';
		} catch { /* localStorage unavailable */ }
	}

	#persist(key: string, value: string): void {
		try { localStorage.setItem(key, value); } catch { /* ignore */ }
	}
}
