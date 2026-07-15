import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as filesApi from '$lib/api/files';
import {
	DEFAULT_FILE_TREE_COLUMN_VISIBILITY,
	DEFAULT_FILE_TREE_COLUMN_WIDTHS,
	FILE_TREE_PARENT_ROW_KEY,
	FileTreeStore,
	resizeVisibleFileTreeColumnBoundary,
} from '$lib/files/tree/file-tree.svelte.js';
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
): FileTreeResponse {
	const relativePath =
		directoryPath === '/workspace' ? '' : directoryPath.slice('/workspace/'.length);
	const segments = relativePath ? relativePath.split('/') : [];
	let breadcrumbPath = '/workspace';
	const breadcrumbs = [{ name: 'workspace', path: breadcrumbPath }];
	for (const segment of segments) {
		breadcrumbPath += `/${segment}`;
		breadcrumbs.push({ name: segment, path: breadcrumbPath });
	}
	return {
		fileRootPath: '/workspace',
		directory: {
			path: directoryPath,
			relativePath,
			parentPath:
				directoryPath === '/workspace'
					? null
					: directoryPath.slice(0, directoryPath.lastIndexOf('/')) || '/',
			breadcrumbs,
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
			context: { chatId: 'draft', projectPath: '/workspace/project', effectiveProjectKey: null },
		});
		expect(store.currentDirectoryPath).toBe('/workspace/project');

		store.setProjectState(availableProject('/workspace/other', '/workspace/other', 'chat-2'));
		await tick();
		expect(store.currentDirectoryPath).toBe('/workspace/other');
		expect(filesApi.getTree).toHaveBeenCalledTimes(2);
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

	it('persists breadcrumb and optional-column defaults and changes', () => {
		expect(store.showBreadcrumbs).toBe(true);
		expect(store.visibleColumns).toEqual(DEFAULT_FILE_TREE_COLUMN_VISIBILITY);

		store.setShowBreadcrumbs(false);
		store.setColumnVisible('permissions', true);

		expect(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs)).toBe('false');
		expect(JSON.parse(mockStorage.get(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility) ?? '')).toEqual({
			size: true,
			modified: true,
			permissions: true,
		});
	});

	it('loads valid preferences and ignores malformed values', () => {
		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeShowBreadcrumbs, 'false');
		mockStorage.set(
			LOCAL_STORAGE_KEYS.fileTreeColumnVisibility,
			JSON.stringify({ size: false, modified: true, permissions: true }),
		);
		const loaded = new FileTreeStore();
		expect(loaded.showBreadcrumbs).toBe(false);
		expect(loaded.visibleColumnKeys).toEqual(['name', 'modified', 'permissions']);

		mockStorage.set(LOCAL_STORAGE_KEYS.fileTreeColumnVisibility, '{bad');
		const malformed = new FileTreeStore();
		expect(malformed.visibleColumns).toEqual(DEFAULT_FILE_TREE_COLUMN_VISIBILITY);
	});

	it('resets hidden active sorting and resizes only adjacent visible columns', () => {
		store.setColumnVisible('permissions', true);
		store.setSortKey('size');
		store.setSortDirection('desc');
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
});
