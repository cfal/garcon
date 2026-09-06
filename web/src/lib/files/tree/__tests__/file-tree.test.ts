import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files';
import {
	DEFAULT_FILE_TREE_COLUMN_VISIBILITY,
	DEFAULT_FILE_TREE_COLUMN_WIDTHS,
	FileTreeStore,
	resizeVisibleFileTreeColumnBoundary,
} from '$lib/files/tree/file-tree.svelte.js';
import { FILE_TREE_PARENT_ROW_KEY } from '$lib/files/tree/file-tree-render-rows.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';

vi.mock('$lib/api/files', () => ({ getTree: vi.fn() }));

const mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (key: string) => mockStorage.get(key) ?? null,
	setItem: (key: string, value: string) => mockStorage.set(key, value),
	removeItem: (key: string) => mockStorage.delete(key),
	clear: () => mockStorage.clear(),
});

function entry(
	name: string,
	type: 'file' | 'directory',
	parent = '/workspace/project',
	extra: Partial<FileTreeEntry> = {},
): FileTreeEntry {
	const path = `${parent}/${name}`;
	return {
		name,
		path,
		relativePath: path.slice('/workspace/'.length),
		type,
		size: type === 'file' ? 10 : 4096,
		modified: '2026-07-15T10:00:00.000Z',
		permissionsRwx: type === 'file' ? 'rw-r--r--' : 'rwxr-xr-x',
		...extra,
	};
}

function response(
	directoryPath = '/workspace/project',
	entries: FileTreeEntry[] = [],
	homeDirectoryPath: string | null = '/workspace',
): FileTreeResponse {
	function breadcrumbsForPath(targetPath: string) {
		const relativePath = targetPath === '/workspace' ? '' : targetPath.slice('/workspace/'.length);
		const segments = relativePath ? relativePath.split('/') : [];
		let breadcrumbPath = '/workspace';
		const breadcrumbs = [{ name: 'workspace', path: breadcrumbPath }];
		for (const segment of segments) {
			breadcrumbPath += `/${segment}`;
			breadcrumbs.push({ name: segment, path: breadcrumbPath });
		}
		return breadcrumbs;
	}
	const relativePath =
		directoryPath === '/workspace' ? '' : directoryPath.slice('/workspace/'.length);
	return {
		fileRootPath: '/workspace',
		homeDirectory:
			homeDirectoryPath === null
				? null
				: { path: homeDirectoryPath, breadcrumbs: breadcrumbsForPath(homeDirectoryPath) },
		directory: {
			path: directoryPath,
			relativePath,
			parentPath:
				directoryPath === '/workspace'
					? null
					: directoryPath.slice(0, directoryPath.lastIndexOf('/')) || '/',
			breadcrumbs: breadcrumbsForPath(directoryPath),
		},
		entries,
	};
}

function availableProject(
	projectPath = '/workspace/project',
	effectiveProjectKey = '/workspace/project',
	chatId = 'chat-1',
): WorkspaceProjectState {
	return { kind: 'available', project: { projectPath, effectiveProjectKey, chatId } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FileTreeStore', () => {
	let store: FileTreeStore;

	beforeEach(() => {
		vi.resetAllMocks();
		mockStorage.clear();
		store = new FileTreeStore();
	});

	it('starts at the chat project and captures the canonical base and anchor', async () => {
		vi.mocked(filesApi.getTree).mockResolvedValue(
			response('/workspace/project', [entry('src', 'directory')]),
		);

		store.setProjectState(availableProject());
		store.activate();
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: { path: '/workspace/project', reason: 'initial' },
		});
		await tick();

		expect(store.currentDirectoryPath).toBe('/workspace/project');
		expect(store.fileRootPath).toBe('/workspace');
		expect(store.isAtChatProject).toBe(true);
		expect(filesApi.getTree).toHaveBeenCalledWith(
			{ directoryPath: '/workspace/project' },
			expect.any(Object),
		);
	});

	it('captures the chat-project anchor when returning after the initial load fails', async () => {
		vi.mocked(filesApi.getTree)
			.mockRejectedValueOnce(new Error('Initial directory unavailable'))
			.mockResolvedValueOnce(response('/workspace/project'));

		store.setProjectState(availableProject());
		store.activate();
		await tick();
		expect(store.navigation.kind).toBe('error');

		await store.goToChatProject();

		expect(store.currentDirectoryPath).toBe('/workspace/project');
		expect(store.isAtChatProject).toBe(true);
	});

	it('shows a destination loading state synchronously when entering a directory', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [entry('src', 'directory')]))
			.mockResolvedValueOnce(response('/workspace/project/src'));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		const navigation = store.enterDirectory(entry('src', 'directory'));
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: { path: '/workspace/project/src' },
		});
		expect(store.rootEntries).toEqual([]);
		await navigation;

		expect(store.currentDirectoryPath).toBe('/workspace/project/src');
		expect(store.consumeFocusPathAfterNavigation()).toBe(FILE_TREE_PARENT_ROW_KEY);
	});

	it('keeps navigation failure at the destination and restores previous data on Back', async () => {
		const initial = response('/workspace/project', [entry('src', 'directory')]);
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(initial)
			.mockRejectedValueOnce(new Error('Directory disappeared'));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		await store.enterDirectory(entry('src', 'directory'));
		expect(store.navigation).toMatchObject({
			kind: 'error',
			target: { label: 'src' },
			error: { message: 'Directory disappeared' },
		});

		store.backFromNavigationError();
		expect(store.readyResponse).toEqual(initial);
	});

	it('ignores an older navigation response after a newer destination wins', async () => {
		let resolveA!: (value: FileTreeResponse) => void;
		let resolveB!: (value: FileTreeResponse) => void;
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(
				response('/workspace/project', [entry('a', 'directory'), entry('b', 'directory')]),
			)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveB = resolve)));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		void store.enterDirectory(entry('a', 'directory'));
		void store.enterDirectory(entry('b', 'directory'));
		resolveB(response('/workspace/project/b'));
		await tick();
		resolveA(response('/workspace/project/a'));
		await tick();

		expect(store.currentDirectoryPath).toBe('/workspace/project/b');
	});

	it('retains ready rows while refresh is pending or fails', async () => {
		let rejectRefresh!: (error: Error) => void;
		const initial = response('/workspace/project', [entry('old.ts', 'file')]);
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(initial)
			.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectRefresh = reject)));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		const refresh = store.refresh();
		expect(store.isRefreshing).toBe(true);
		expect(store.rootEntries[0]?.name).toBe('old.ts');
		rejectRefresh(new Error('offline'));
		await refresh;

		expect(store.rootEntries[0]?.name).toBe('old.ts');
		expect(store.refreshError?.message).toBe('offline');
	});

	it('preserves disclosure changes made while refresh is pending', async () => {
		let resolveRefresh!: (value: FileTreeResponse) => void;
		const first = entry('first', 'directory');
		const second = entry('second', 'directory');
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [first, second]))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveRefresh = resolve)))
			.mockResolvedValue(response(second.path));
		store.setProjectState(availableProject());
		store.activate();
		await tick();
		store.expandedDirs = new Set([first.path]);
		store.childrenCache = new Map([
			[first.path, []],
			[second.path, []],
		]);

		const refresh = store.refresh();
		store.toggleDirectory(first.path);
		store.toggleDirectory(second.path);
		resolveRefresh(response('/workspace/project', [first, second]));
		await refresh;

		expect(store.expandedDirs.has(first.path)).toBe(false);
		expect(store.expandedDirs.has(second.path)).toBe(true);
		expect(filesApi.getTree).toHaveBeenLastCalledWith(
			{ directoryPath: second.path },
			expect.any(Object),
		);
	});

	it('loads expanded children and exposes retryable child failures', async () => {
		const src = entry('src', 'directory');
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [src]))
			.mockRejectedValueOnce(new Error('child failed'))
			.mockResolvedValueOnce(response(src.path, [entry('index.ts', 'file', src.path)]));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		store.toggleDirectory(src.path);
		await tick();
		expect(store.expandedDirs.has(src.path)).toBe(true);
		expect(store.childErrors.get(src.path)?.message).toBe('child failed');

		store.retryDirectory(src.path);
		await tick();
		expect(store.childrenCache.get(src.path)?.[0]?.name).toBe('index.ts');
	});

	it('aborts and resumes incomplete work across presentation visibility', async () => {
		let call = 0;
		vi.mocked(filesApi.getTree).mockImplementation((_params, options) => {
			call += 1;
			if (call === 1) {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					);
				});
			}
			return Promise.resolve(response('/workspace/project'));
		});
		store.setProjectState(availableProject());
		store.activate();
		await tick();
		store.deactivate();
		store.activate();
		await tick();

		expect(filesApi.getTree).toHaveBeenCalledTimes(2);
		expect(store.navigation.kind).toBe('ready');
	});

	it('retains the location for same-project resolution and resets for a new project', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project'))
			.mockResolvedValueOnce(response('/workspace/other'));
		store.setProjectState(availableProject());
		store.activate();
		await tick();
		store.setProjectState({
			kind: 'resolving',
			context: { chatId: 'draft', projectPath: '/workspace/project' },
		});
		expect(store.currentDirectoryPath).toBe('/workspace/project');

		store.setProjectState(availableProject('/workspace/other', '/workspace/other', 'chat-2'));
		await tick();
		expect(store.currentDirectoryPath).toBe('/workspace/other');
		expect(filesApi.getTree).toHaveBeenCalledTimes(2);
	});

	it('resets when the chat project path changes within the same effective project', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [entry('old.ts', 'file')]))
			.mockResolvedValueOnce(
				response('/workspace/project/packages/app', [
					entry('new.ts', 'file', '/workspace/project/packages/app'),
				]),
			)
			.mockResolvedValueOnce(response('/workspace/project/packages/app'));
		store.setProjectState(availableProject());
		store.activate();
		await tick();
		expect(store.rootEntries[0]?.name).toBe('old.ts');

		store.setProjectState(
			availableProject('/workspace/project/packages/app', '/workspace/project'),
		);
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: { path: '/workspace/project/packages/app', reason: 'initial' },
		});
		expect(store.rootEntries).toEqual([]);
		await tick();

		expect(store.currentDirectoryPath).toBe('/workspace/project/packages/app');
		expect(store.rootEntries[0]?.name).toBe('new.ts');
		await store.refresh();
		expect(filesApi.getTree).toHaveBeenLastCalledWith(
			{ directoryPath: '/workspace/project/packages/app' },
			expect.any(Object),
		);
	});

	it('keeps focus on the parent row so repeated upward navigation works', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project/src'))
			.mockResolvedValueOnce(response('/workspace/project'))
			.mockResolvedValueOnce(response('/workspace'));
		store.setProjectState(availableProject('/workspace/project/src'));
		store.activate();
		await tick();

		await store.goToParent();
		expect(store.currentDirectoryPath).toBe('/workspace/project');
		expect(store.consumeFocusPathAfterNavigation()).toBe(FILE_TREE_PARENT_ROW_KEY);

		await store.goToParent();
		expect(store.currentDirectoryPath).toBe('/workspace');
		expect(store.consumeFocusPathAfterNavigation()).toBe(FILE_TREE_PARENT_ROW_KEY);
	});

	it('navigates to parent and directly back to the chat project', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project'))
			.mockResolvedValueOnce(response('/workspace'))
			.mockResolvedValueOnce(response('/workspace/project'));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		await store.goToParent();
		expect(store.currentDirectoryPath).toBe('/workspace');
		expect(store.isAtChatProject).toBe(false);
		await store.goToChatProject();
		expect(store.currentDirectoryPath).toBe('/workspace/project');
	});

	it('navigates to the literal Home directory and no-ops once it arrives', async () => {
		const homePath = '/workspace/users/me';
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [], homePath))
			.mockResolvedValueOnce(response(homePath, [], homePath));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		expect(store.isAtHome).toBe(false);
		const navigation = store.goToHome();
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: {
				path: homePath,
				label: 'me',
				breadcrumbs: [
					{ name: 'workspace', path: '/workspace' },
					{ name: 'users', path: '/workspace/users' },
					{ name: 'me', path: homePath },
				],
				reason: 'home',
			},
		});
		await navigation;

		expect(store.currentDirectoryPath).toBe(homePath);
		expect(store.isAtHome).toBe(true);
		expect(store.consumeFocusPathAfterNavigation()).toBe(FILE_TREE_PARENT_ROW_KEY);
		const callCount = vi.mocked(filesApi.getTree).mock.calls.length;
		await store.goToHome();
		expect(filesApi.getTree).toHaveBeenCalledTimes(callCount);
	});

	it('navigates Home from an error using the retained Home target', async () => {
		const src = entry('src', 'directory');
		const homePath = '/workspace/users/me';
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project', [src], homePath))
			.mockRejectedValueOnce(new Error('Directory unavailable'))
			.mockResolvedValueOnce(response(homePath, [], homePath));
		store.setProjectState(availableProject());
		store.activate();
		await tick();

		await store.enterDirectory(src);
		expect(store.navigation.kind).toBe('error');
		expect(store.homeDirectory?.path).toBe(homePath);

		await store.goToHome();

		expect(store.currentDirectoryPath).toBe(homePath);
		expect(store.isAtHome).toBe(true);
	});

	it('leaves Home unavailable without treating the file root as Home', async () => {
		vi.mocked(filesApi.getTree).mockResolvedValueOnce(response('/workspace', [], null));
		store.setProjectState(availableProject('/workspace'));
		store.activate();
		await tick();

		expect(store.homeDirectory).toBeNull();
		expect(store.isAtHome).toBe(false);
		const callCount = vi.mocked(filesApi.getTree).mock.calls.length;

		await store.goToHome();

		expect(filesApi.getTree).toHaveBeenCalledTimes(callCount);
	});

	it('restores row focus after breadcrumb navigation', async () => {
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(response('/workspace/project/src'))
			.mockResolvedValueOnce(response('/workspace'));
		store.setProjectState(availableProject('/workspace/project/src'));
		store.activate();
		await tick();

		await store.navigateToBreadcrumb(0);

		expect(store.currentDirectoryPath).toBe('/workspace');
		expect(store.consumeFocusPathAfterNavigation()).toBe('/workspace/project');
	});

	it('filters a cached materialized order without sorting the tree again', () => {
		store.navigation = {
			kind: 'ready',
			response: response('/workspace/project', [entry('b.ts', 'file'), entry('a.ts', 'file')]),
		};
		const sortEntries = vi.spyOn(store, 'sortEntries');

		expect(store.filteredRows.map((row) => row.entry.name)).toEqual(['a.ts', 'b.ts']);
		const callsAfterMaterialization = sortEntries.mock.calls.length;
		store.filterInput = 'b';

		expect(store.filteredRows.map((row) => row.entry.name)).toEqual(['b.ts']);
		expect(sortEntries).toHaveBeenCalledTimes(callsAfterMaterialization);
	});

	it('persists breadcrumb, icon, view, and optional-column preferences', () => {
		expect(store.showBreadcrumbs).toBe(true);
		expect(store.showIcons).toBe(true);
		expect(store.viewPreference).toBe('responsive');
		expect(store.visibleColumns).toEqual(DEFAULT_FILE_TREE_COLUMN_VISIBILITY);

		store.setShowBreadcrumbs(false);
		store.setShowIcons(false);
		store.setAlwaysUseDetailedRows(true);
		store.setColumnVisible('permissions', true);

		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs)).toBe('false');
		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeShowIcons)).toBe('false');
		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeViewPreference)).toBe('always-details');
		expect(JSON.parse(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility) ?? '')).toEqual({
			size: true,
			modified: true,
			permissions: true,
		});
	});

	it('loads valid preferences and ignores malformed values', () => {
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs, 'false');
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeShowIcons, 'false');
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeViewPreference, 'always-details');
		mockStorage.set(
			LOCAL_STORAGE_KEYS.fileTreeColumnVisibility,
			JSON.stringify({ size: false, modified: true, permissions: true }),
		);
		const loaded = new FileTreeStore();
		expect(loaded.showBreadcrumbs).toBe(false);
		expect(loaded.showIcons).toBe(false);
		expect(loaded.viewPreference).toBe('always-details');
		expect(loaded.visibleColumnKeys).toEqual(['name', 'modified', 'permissions']);

		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility, '{bad');
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeShowIcons, 'sometimes');
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeViewPreference, 'tiles');
		const malformed = new FileTreeStore();
		expect(malformed.viewPreference).toBe('responsive');
		expect(malformed.showIcons).toBe(true);
		expect(malformed.visibleColumns).toEqual(DEFAULT_FILE_TREE_COLUMN_VISIBILITY);
	});

	it('resets hidden active sorting and resizes only adjacent visible columns', () => {
		store.setColumnVisible('permissions', true);
		store.setSort('size', 'desc');
		store.setColumnVisible('size', false);
		expect(store.sortKey).toBe('name');
		expect(store.sortDirection).toBe('asc');

		const resized = resizeVisibleFileTreeColumnBoundary(
			DEFAULT_FILE_TREE_COLUMN_WIDTHS,
			['name', 'modified', 'permissions'],
			'name',
			10,
		);
		expect(resized.size).toBe(DEFAULT_FILE_TREE_COLUMN_WIDTHS.size);
		expect(resized.permissions).toBe(DEFAULT_FILE_TREE_COLUMN_WIDTHS.permissions);
		expect(resized.name).toBeGreaterThan(DEFAULT_FILE_TREE_COLUMN_WIDTHS.name);
		expect(resized.modified).toBeLessThan(DEFAULT_FILE_TREE_COLUMN_WIDTHS.modified);
	});

	it('selects only visible sort keys and starts a new key ascending', () => {
		store.setSort('name', 'desc');

		store.selectSortKey('modified');
		expect(store.sortKey).toBe('modified');
		expect(store.sortDirection).toBe('asc');
		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeSortKey)).toBe('modified');
		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeSortDirection)).toBe('asc');

		store.selectSortKey('permissions');
		store.selectSortKey('invalid');
		expect(store.sortKey).toBe('modified');
	});
});
