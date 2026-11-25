import { getTree } from '$lib/api/files.js';
import { effectiveExecutorId } from '$shared/executors';
import { ApiError } from '$lib/api/client.js';
import { pruneFileTreeCache } from './file-tree-cache.js';
import {
	fileTreeNavigationError,
	type FileTreeDirectoryTarget,
	type FileTreeNavigationError,
	type FileTreeNavigationState,
} from './file-tree-navigation.js';
import { FILE_TREE_PARENT_ROW_KEY } from './file-tree-render-rows.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type {
	FileTreeBreadcrumb,
	FileTreeEntry,
	FileTreeHomeDirectory,
	FileTreeResponse,
} from '$shared/file-contracts';

import type { FileTableRow } from './file-tree-rows.js';

export class FileTreeDirectoryLoader {
	#executorId = $state('local');
	get executorId(): string {
		return this.#executorId;
	}
	navigation = $state.raw<FileTreeNavigationState>({ kind: 'idle' });
	isRefreshing = $state(false);
	refreshError = $state.raw<FileTreeNavigationError | null>(null);

	childrenCache = $state.raw<Map<string, FileTreeEntry[]>>(new Map());
	loadingDirs = $state.raw<Set<string>>(new Set());
	expandedDirs = $state.raw<Set<string>>(new Set());
	childErrors = $state.raw<Map<string, FileTreeNavigationError>>(new Map());

	focusPathAfterNavigation = $state<string | null>(null);

	#projectPath = $state<string | null>(null);
	#canonicalChatProjectPath = $state<string | null>(null);
	#chatProjectBreadcrumbs = $state.raw<FileTreeBreadcrumb[]>([]);
	#effectiveProjectKey = $state('');
	#active = false;
	#projectRequestsAllowed = false;
	#navigationController: AbortController | null = null;
	#refreshController: AbortController | null = null;
	#navigationToken = 0;
	#refreshToken = 0;
	#childControllers = new Map<string, AbortController>();

	constructor(
		private readonly options: {
			clearFilter(): void;
			visibleRows(): readonly FileTableRow[];
		},
	) {}

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

	get homeDirectory(): FileTreeHomeDirectory | null {
		return this.retainedResponse?.homeDirectory ?? null;
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

	get isAtHome(): boolean {
		const homeDirectory = this.homeDirectory;
		return Boolean(homeDirectory && this.currentDirectoryPath === homeDirectory.path);
	}

	browseExecutor(executorId: string): void {
		const directoryPath = this.retainedResponse?.directory.path ?? this.#projectPath ?? '';
		this.#resetBrowsingState();
		this.#executorId = executorId;
		this.#projectPath = null;
		this.#canonicalChatProjectPath = null;
		this.#chatProjectBreadcrumbs = [];
		this.#effectiveProjectKey = `executor:${executorId}`;
		this.#projectRequestsAllowed = true;
		void this.navigateTo({
			path: directoryPath,
			label: directoryPath,
			breadcrumbs: [],
			reason: 'executor-switch',
		});
	}

	setExecutorAvailable(available: boolean): void {
		if (available === this.#projectRequestsAllowed) return;
		this.#projectRequestsAllowed = available;
		if (!available) {
			this.#abortRequests();
			return;
		}
		const response = this.readyResponse;
		if (response) {
			void this.navigateTo({
				path: response.directory.path,
				label: this.currentDirectoryLabel,
				breadcrumbs: response.directory.breadcrumbs,
				reason: 'initial',
			});
		} else if (this.navigation.kind === 'error') {
			void this.retryNavigation();
		} else {
			this.#resumePendingWork();
		}
	}

	invalidateExecutorPaths(): void {
		const response = this.retainedResponse;
		let target: FileTreeDirectoryTarget;
		if (this.navigation.kind === 'loading' || this.navigation.kind === 'error') {
			target = this.navigation.target;
		} else if (response) {
			target = {
				path: response.directory.path,
				label: response.directory.path,
				breadcrumbs: [],
				reason: 'initial',
			};
		} else {
			target = this.#initialTarget();
		}
		const captureAsChatProject =
			target.captureAsChatProject || target.path === this.#canonicalChatProjectPath;
		this.#abortRequests();
		this.#clearDirectoryCaches();
		this.#canonicalChatProjectPath = null;
		this.#chatProjectBreadcrumbs = [];
		this.refreshError = null;
		this.navigation = {
			kind: 'loading',
			target: { ...target, captureAsChatProject, breadcrumbs: [] },
			previous: null,
		};
		this.#resumePendingWork();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		const target =
			projectState.kind === 'available'
				? projectState.project
				: projectState.kind === 'absent'
					? null
					: projectState.context;
		const executorId = effectiveExecutorId(target?.executorId);
		if (this.#executorId !== executorId) {
			this.#resetBrowsingState();
			this.#effectiveProjectKey = '';
			this.#executorId = executorId;
		}
		if (projectState.kind === 'absent') {
			this.#projectRequestsAllowed = false;
			this.#projectPath = null;
			this.#effectiveProjectKey = '';
			this.#canonicalChatProjectPath = null;
			this.#chatProjectBreadcrumbs = [];
			this.#resetBrowsingState();
			return;
		}
		if (projectState.kind !== 'available') {
			this.#projectRequestsAllowed = false;
			this.#abortRequests();
			return;
		}

		const { project } = projectState;
		this.#projectRequestsAllowed = true;
		const projectPathChanged = project.projectPath !== this.#projectPath;
		this.#projectPath = project.projectPath;
		if (!projectPathChanged && project.effectiveProjectKey === this.#effectiveProjectKey) {
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
		this.childErrors = new Map();
		this.#resumePendingWork();
	}

	deactivate(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#abortRequests();
	}

	reset(): void {
		this.#active = false;
		this.#projectRequestsAllowed = false;
		this.#projectPath = null;
		this.#effectiveProjectKey = '';
		this.#canonicalChatProjectPath = null;
		this.#chatProjectBreadcrumbs = [];
		this.#resetBrowsingState();
	}

	async navigateTo(target: FileTreeDirectoryTarget): Promise<void> {
		const previous = this.retainedResponse;
		this.options.clearFilter();
		this.#clearDirectoryCaches();
		this.navigation = { kind: 'loading', target, previous };
		if (!this.#active || !this.#projectRequestsAllowed) return;
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

	// Focus stays on the parent row rather than the directory just left. Focusing
	// that directory scrolls it into view, which slides a sibling row under the
	// pointer so the next click enters it instead of continuing upward.
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
			focusPathOnSuccess: FILE_TREE_PARENT_ROW_KEY,
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

	async goToHome(): Promise<void> {
		const homeDirectory = this.homeDirectory;
		if (!homeDirectory || this.isAtHome) return;
		await this.navigateTo({
			path: homeDirectory.path,
			label: homeDirectory.breadcrumbs.at(-1)?.name ?? homeDirectory.path,
			breadcrumbs: [...homeDirectory.breadcrumbs],
			reason: 'home',
			focusPathOnSuccess: FILE_TREE_PARENT_ROW_KEY,
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

	async revealFile(relativePath: string): Promise<boolean> {
		const fileRootPath = this.fileRootPath;
		if (!fileRootPath) return false;
		const segments = relativePath.split('/').filter(Boolean);
		const fileName = segments.pop();
		if (!fileName) return false;
		const directoryPath = segments.length
			? `${fileRootPath.replace(/\/$/, '')}/${segments.join('/')}`
			: fileRootPath;
		await this.navigateTo({
			path: directoryPath,
			label: segments.at(-1) ?? this.currentDirectoryLabel,
			breadcrumbs: [],
			reason: 'reveal-file',
			focusPathOnSuccess: `${directoryPath.replace(/\/$/, '')}/${fileName}`,
		});
		return (
			this.readyResponse?.entries.some((entry) => entry.relativePath === relativePath) ?? false
		);
	}

	async retryNavigation(): Promise<void> {
		if (this.navigation.kind !== 'error') return;
		const { target, previous } = this.navigation;
		this.navigation = { kind: 'loading', target, previous };
		if (!this.#active || !this.#projectRequestsAllowed) return;
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
		if (!response || this.isRefreshing || !this.#active || !this.#projectRequestsAllowed) return;
		this.#refreshController?.abort();
		const controller = new AbortController();
		const token = ++this.#refreshToken;
		const directoryPath = response.directory.path;
		this.#refreshController = controller;
		this.isRefreshing = true;
		this.refreshError = null;
		try {
			const refreshed = await getTree(
				{ executorId: this.executorId, directoryPath },
				{ signal: controller.signal },
			);
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
			this.reconcileDirectoryDemand();
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
		const collapsing = expanded.has(path);
		if (collapsing) {
			expanded.delete(path);
		} else {
			expanded.add(path);
			const errors = new Map(this.childErrors);
			errors.delete(path);
			this.childErrors = errors;
		}
		this.expandedDirs = expanded;
		const entries = collapsing ? undefined : this.childrenCache.get(path);
		if (entries) {
			const cache = new Map(this.childrenCache);
			cache.delete(path);
			cache.set(path, entries);
			this.childrenCache = cache;
		}
		this.reconcileDirectoryDemand();
	}

	async fetchChildren(path: string): Promise<void> {
		if (
			!this.#active ||
			!this.#projectRequestsAllowed ||
			this.childrenCache.has(path) ||
			this.loadingDirs.has(path)
		) {
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
			const response = await getTree(
				{ executorId: this.executorId, directoryPath: path },
				{ signal: controller.signal },
			);
			if (controller.signal.aborted || this.#childControllers.get(path) !== controller) return;
			const cache = new Map(this.childrenCache);
			cache.set(path, response.entries);
			this.childrenCache = cache;
			this.reconcileDirectoryDemand();
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
			captureAsChatProject: this.#projectPath !== null,
		};
	}

	#resumePendingWork(): void {
		if (!this.#active || !this.#projectRequestsAllowed || !this.#effectiveProjectKey) return;
		if (this.navigation.kind === 'idle') {
			void this.navigateTo(this.#initialTarget());
			return;
		}
		if (this.navigation.kind === 'loading' && !this.#navigationController) {
			void this.#performNavigation(this.navigation.target, this.navigation.previous);
			return;
		}
		if (this.navigation.kind === 'ready') {
			this.reconcileDirectoryDemand();
		}
	}

	reconcileDirectoryDemand(): void {
		const visibleExpanded = new Set<string>();
		for (const { entry } of this.options.visibleRows()) {
			if (entry.type !== 'directory' || !this.expandedDirs.has(entry.path)) continue;
			visibleExpanded.add(entry.path);
			if (
				!this.childrenCache.has(entry.path) &&
				!this.loadingDirs.has(entry.path) &&
				!this.childErrors.has(entry.path)
			) {
				void this.fetchChildren(entry.path);
			}
		}
		this.childrenCache = pruneFileTreeCache(this.childrenCache, visibleExpanded);
	}

	async #performNavigation(
		target: FileTreeDirectoryTarget,
		previous: FileTreeResponse | null,
	): Promise<void> {
		if (!this.#active || !this.#projectRequestsAllowed) return;
		this.#navigationController?.abort();
		this.#abortRefresh();
		this.#abortChildren();
		const controller = new AbortController();
		const token = ++this.#navigationToken;
		this.#navigationController = controller;
		this.navigation = { kind: 'loading', target, previous };
		try {
			const response = await getTree(
				{ executorId: this.executorId, directoryPath: target.path },
				{ signal: controller.signal },
			);
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
			if (
				target.reason === 'executor-switch' &&
				target.path &&
				error instanceof ApiError &&
				[
					'FILE_TREE_DIRECTORY_NOT_FOUND',
					'FILE_TREE_DIRECTORY_REQUIRED',
					'outside_project_base',
				].includes(error.errorCode ?? '')
			) {
				await this.navigateTo(this.#initialTarget());
				return;
			}
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
		this.options.clearFilter();
		this.#clearDirectoryCaches();
	}
}
