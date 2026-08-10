import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import * as filesApi from '$lib/api/files';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import FileTree from '../FileTree.svelte';

const { copyToClipboard } = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
}));

vi.mock('$lib/api/files', () => ({ getTree: vi.fn() }));
vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard }));

function entry(
	name: string,
	type: 'file' | 'directory',
	parent = '/workspace/project',
	extra: Partial<FileTreeEntry> = {},
): FileTreeEntry {
	return {
		name,
		path: `${parent}/${name}`,
		relativePath: `project/${name}`,
		type,
		size: type === 'file' ? 42 : 4096,
		modified: null,
		permissionsRwx: type === 'file' ? 'rw-r--r--' : 'rwxr-xr-x',
		...extra,
	};
}

function response(
	entries: FileTreeEntry[],
	directoryPath = '/workspace/project',
): FileTreeResponse {
	return {
		fileRootPath: '/workspace',
		directory: {
			path: directoryPath,
			relativePath: directoryPath === '/workspace' ? '' : 'project',
			parentPath: directoryPath === '/workspace' ? null : '/workspace',
			breadcrumbs:
				directoryPath === '/workspace'
					? [{ name: 'workspace', path: '/workspace' }]
					: [
							{ name: 'workspace', path: '/workspace' },
							{ name: 'project', path: '/workspace/project' },
						],
		},
		entries,
	};
}

function responseAt(directoryPath: string, entries: FileTreeEntry[]): FileTreeResponse {
	const segments = directoryPath.slice('/workspace'.length).split('/').filter(Boolean);
	let breadcrumbPath = '/workspace';
	return {
		fileRootPath: '/workspace',
		directory: {
			path: directoryPath,
			relativePath: segments.join('/'),
			parentPath:
				directoryPath === '/workspace'
					? null
					: directoryPath.slice(0, directoryPath.lastIndexOf('/')) || '/',
			breadcrumbs: [
				{ name: 'workspace', path: '/workspace' },
				...segments.map((segment) => {
					breadcrumbPath = `${breadcrumbPath}/${segment}`;
					return { name: segment, path: breadcrumbPath };
				}),
			],
		},
		entries,
	};
}

function renderReady(entries: FileTreeEntry[]) {
	const store = new FileTreeStore();
	store.navigation = { kind: 'ready', response: response(entries) };
	const onFileSelect = vi.fn();
	const result = render(FileTree, {
		store,
		onFileSelect,
		onImageSelect: onFileSelect,
	});
	return { ...result, store, onFileSelect };
}

async function setFileTreeWidth(
	container: HTMLElement,
	width: number,
	expectedLayout: 'columns' | 'details' = width < 520 ? 'details' : 'columns',
): Promise<void> {
	const root = container.querySelector<HTMLElement>('[data-file-tree-root]');
	if (!root) throw new Error('Expected file tree root');
	ResizeObserverHarness.emit(root, width);
	await waitFor(() => expect(root.dataset.fileTreeLayout).toBe(expectedLayout));
}

describe('FileTree', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		localStorage.clear();
		vi.resetAllMocks();
		copyToClipboard.mockResolvedValue(true);
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('uses the workspace background across the Files surface', async () => {
		const { container } = renderReady([entry('README.md', 'file')]);
		await setFileTreeWidth(container, 700);

		for (const selector of [
			'[data-file-tree-root]',
			'[data-file-tree-toolbar]',
			'[data-file-tree-breadcrumbs]',
			'[data-file-tree-column-grid]',
		]) {
			const element = container.querySelector(selector);
			expect(element?.classList.contains('bg-background')).toBe(true);
			expect(element?.classList.contains('bg-card')).toBe(false);
		}
	});

	it('expands only from disclosure and enters from the rest of the directory row', async () => {
		const src = entry('src', 'directory');
		const { container, store } = renderReady([src]);

		await fireEvent.click(screen.getByRole('button', { name: 'Expand src' }));
		expect(store.expandedDirs.has(src.path)).toBe(true);
		expect(store.currentDirectoryPath).toBe('/workspace/project');

		const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		if (!row) throw new Error('Expected directory row');
		await fireEvent.click(row);
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: { path: src.path, reason: 'directory-row' },
		});
	});

	it('replaces directory rows across consecutive entries and breadcrumb navigation', async () => {
		const firstPath = '/workspace/project/first';
		const secondPath = `${firstPath}/second`;
		const first = entry('first', 'directory');
		const second = entry('second', 'directory', firstPath);
		const firstOnly = entry('first-only.txt', 'file', firstPath);
		const secondOnly = entry('second-only.txt', 'file', secondPath);
		const projectOnly = entry('project-only.txt', 'file');
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(responseAt(firstPath, [second, firstOnly]))
			.mockResolvedValueOnce(responseAt(secondPath, [secondOnly]))
			.mockResolvedValueOnce(responseAt('/workspace/project', [first, projectOnly]));
		const { container, store } = renderReady([first]);
		store.activate();

		await fireEvent.click(
			container.querySelector<HTMLElement>(`[data-file-tree-row-key="${first.path}"]`)!,
		);
		await screen.findByRole('rowheader', { name: /^first-only\.txt/ });
		await fireEvent.click(
			container.querySelector<HTMLElement>(`[data-file-tree-row-key="${second.path}"]`)!,
		);
		await screen.findByRole('rowheader', { name: /^second-only\.txt/ });

		expect(screen.queryByRole('rowheader', { name: /^first-only\.txt/ })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: '/workspace/project' }));
		await screen.findByRole('rowheader', { name: /^project-only\.txt/ });

		expect(store.currentDirectoryPath).toBe('/workspace/project');
		expect(screen.queryByRole('rowheader', { name: /^second-only\.txt/ })).toBeNull();
		const keys = [...container.querySelectorAll<HTMLElement>('[data-file-tree-row-key]')].map(
			(row) => row.dataset.fileTreeRowKey,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('keeps overlapping child names owned by their expanded sibling directories', async () => {
		const first = entry('first', 'directory');
		const second = entry('second', 'directory');
		const firstChild = entry('shared.txt', 'file', first.path);
		const secondChild = entry('shared.txt', 'file', second.path);
		vi.mocked(filesApi.getTree)
			.mockResolvedValueOnce(responseAt(first.path, [firstChild]))
			.mockResolvedValueOnce(responseAt(second.path, [secondChild]));
		const { container, store } = renderReady([first, second]);
		store.activate();

		await fireEvent.click(screen.getByRole('button', { name: 'Expand first' }));
		await waitFor(() => expect(store.childrenCache.get(first.path)).toEqual([firstChild]));
		await fireEvent.click(screen.getByRole('button', { name: 'Expand second' }));
		await waitFor(() => expect(store.childrenCache.get(second.path)).toEqual([secondChild]));

		expect(screen.getAllByRole('rowheader', { name: /^shared\.txt/ })).toHaveLength(2);
		const keys = [...container.querySelectorAll<HTMLElement>('[data-file-tree-row-key]')].map(
			(row) => row.dataset.fileTreeRowKey,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('opens a file from anywhere on its row', async () => {
		const readme = entry('README.md', 'file');
		const { onFileSelect } = renderReady([readme]);

		await fireEvent.click(screen.getByRole('rowheader', { name: /^README\.md/ }));
		expect(onFileSelect).toHaveBeenCalledWith(readme);
	});

	it('copies file paths without activating rows and omits the action from directories', async () => {
		const src = entry('src', 'directory');
		const readme = entry('README.md', 'file');
		const { container, onFileSelect } = renderReady([src, readme]);
		const copyButton = screen.getByRole('button', { name: 'Copy file path' });
		const readmeRow = container.querySelector<HTMLElement>(
			`[data-file-tree-row-key="${readme.path}"]`,
		);
		if (!readmeRow) throw new Error('Expected file row');

		expect(screen.getAllByRole('button', { name: 'Copy file path' })).toHaveLength(1);
		expect(readmeRow.querySelector('[data-file-tree-subtitle]')).toBeTruthy();
		await fireEvent.keyDown(copyButton, { key: 'Enter' });
		expect(onFileSelect).not.toHaveBeenCalled();

		await fireEvent.click(copyButton);
		expect(copyToClipboard).toHaveBeenCalledWith(readme.relativePath, undefined);
		expect(onFileSelect).not.toHaveBeenCalled();
		copyButton.focus();
		expect(document.activeElement).toBe(copyButton);

		await setFileTreeWidth(container, 700);
		expect(container.querySelector<HTMLElement>(`[data-file-tree-row-key="${readme.path}"]`)).toBe(
			readmeRow,
		);
		expect(readmeRow.querySelector('[data-copy-file-path]')).toBe(copyButton);
		expect(document.activeElement).toBe(copyButton);
		expect(copyButton.getAttribute('aria-label')).toBe('File path copied');
		expect(readmeRow.querySelectorAll('[role="gridcell"]')).toHaveLength(2);
		expect(readmeRow.querySelector('[data-file-tree-subtitle]')).toBeNull();
		await fireEvent.click(copyButton);
		expect(copyToClipboard).toHaveBeenCalledTimes(2);
		expect(onFileSelect).not.toHaveBeenCalled();
	});

	it('pins the parent row while filtering all materialized rows', async () => {
		const src = entry('src', 'directory');
		const readme = entry('README.md', 'file');
		const app = entry('App.svelte', 'file', src.path);
		const { store } = renderReady([src, readme]);
		store.expandedDirs = new Set([src.path]);
		store.childrenCache = new Map([[src.path, [app]]]);
		await Promise.resolve();

		await fireEvent.click(screen.getByRole('button', { name: 'Filter files' }));
		const input = screen.getByPlaceholderText('Filter by name...');
		await fireEvent.input(input, { target: { value: 'app' } });

		expect(screen.getByRole('rowheader', { name: /Parent directory/ })).toBeTruthy();
		expect(screen.getByRole('rowheader', { name: /^src/ })).toBeTruthy();
		expect(screen.getByRole('rowheader', { name: /^App\.svelte/ })).toBeTruthy();
		expect(screen.queryByRole('rowheader', { name: /^README\.md/ })).toBeNull();
		expect(filesApi.getTree).not.toHaveBeenCalled();
	});

	it('navigates upward from the parent row', async () => {
		const { store } = renderReady([entry('README.md', 'file')]);

		await fireEvent.click(screen.getByRole('rowheader', { name: /Parent directory/ }));
		expect(store.navigation).toMatchObject({
			kind: 'loading',
			target: { path: '/workspace', reason: 'parent-row' },
		});
	});

	it('keeps focus on an inert parent row after navigating to the root', async () => {
		const rootChild = entry('project', 'directory', '/workspace', {
			relativePath: 'project',
		});
		vi.mocked(filesApi.getTree).mockResolvedValueOnce(response([rootChild], '/workspace'));
		const { container, store } = renderReady([entry('README.md', 'file')]);
		store.activate();
		const parentRow = container.querySelector<HTMLElement>('[data-file-tree-parent-row]');
		if (!parentRow) throw new Error('Expected parent row');

		await fireEvent.click(parentRow);

		await waitFor(() => expect(store.currentDirectoryPath).toBe('/workspace'));
		const rootBoundary = container.querySelector<HTMLElement>('[data-file-tree-parent-row]');
		const viewport = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!rootBoundary || !viewport) throw new Error('Expected root file tree');
		await waitFor(() => expect(document.activeElement).toBe(rootBoundary));
		expect(rootBoundary.getAttribute('aria-disabled')).toBe('true');
		expect(viewport.scrollTop).toBe(0);

		await fireEvent.click(rootBoundary);
		await fireEvent.keyDown(rootBoundary, { key: 'Enter' });

		expect(filesApi.getTree).toHaveBeenCalledOnce();
		expect(store.currentDirectoryPath).toBe('/workspace');
	});

	it('supports treegrid keyboard expansion and activation', async () => {
		const src = entry('src', 'directory');
		const { container, store } = renderReady([src]);
		const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		if (!row) throw new Error('Expected directory row');

		await fireEvent.keyDown(row, { key: 'ArrowRight' });
		expect(store.expandedDirs.has(src.path)).toBe(true);
		await fireEvent.keyDown(row, { key: 'Enter' });
		expect(store.navigation.kind).toBe('loading');
	});

	it('moves one roving focus target with arrow, Home, and End keys', async () => {
		const src = entry('src', 'directory');
		const readme = entry('README.md', 'file');
		const { container } = renderReady([src, readme]);
		const rows = [...container.querySelectorAll<HTMLElement>('[data-file-tree-row]')];
		const parent = rows.find((row) => row.dataset.fileTreeRowKey === 'file-tree-parent-row');
		const srcRow = rows.find((row) => row.dataset.fileTreeRowKey === src.path);
		const readmeRow = rows.find((row) => row.dataset.fileTreeRowKey === readme.path);
		if (!parent || !srcRow || !readmeRow) throw new Error('Expected all file rows');

		srcRow.focus();
		await fireEvent.keyDown(srcRow, { key: 'End' });
		await waitFor(() => expect(document.activeElement).toBe(readmeRow));
		await fireEvent.keyDown(readmeRow, { key: 'Home' });
		await waitFor(() => expect(document.activeElement).toBe(parent));
		await fireEvent.keyDown(parent, { key: 'ArrowDown' });
		await waitFor(() => expect(document.activeElement).toBe(srcRow));
	});

	it('includes child failures in roving focus and retries them with Enter', async () => {
		const src = entry('src', 'directory');
		const { container, store } = renderReady([src]);
		store.expandedDirs = new Set([src.path]);
		store.childErrors = new Map([[src.path, { message: 'failed', retryable: true }]]);
		await Promise.resolve();
		const retry = vi.spyOn(store, 'retryDirectory');
		const srcRow = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		const errorRow = container.querySelector<HTMLElement>(
			'[data-file-tree-row-key^="file-tree-child-status:"]',
		);
		if (!srcRow || !errorRow) throw new Error('Expected directory and child error rows');
		expect(errorRow.querySelector('.file-tree-entry-icon')).toBeTruthy();

		srcRow.focus();
		await fireEvent.keyDown(srcRow, { key: 'ArrowRight' });
		await waitFor(() => expect(document.activeElement).toBe(errorRow));
		await fireEvent.keyDown(errorRow, { key: 'Enter' });
		expect(retry).toHaveBeenCalledWith(src.path);
		await waitFor(() => expect(document.activeElement).toBe(srcRow));
	});

	it('restores focus to the directory after clicking child Retry', async () => {
		const src = entry('src', 'directory');
		const { container, store } = renderReady([src]);
		store.expandedDirs = new Set([src.path]);
		store.childErrors = new Map([[src.path, { message: 'failed', retryable: true }]]);
		await Promise.resolve();
		const srcRow = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		if (!srcRow) throw new Error('Expected directory row');

		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(document.activeElement).toBe(srcRow));
	});

	it('shows Refresh in the toolbar while keeping view options in one persistent menu', async () => {
		const { store } = renderReady([entry('README.md', 'file')]);
		const refresh = screen.getByRole('button', { name: 'Refresh files' });
		expect(refresh).toBeTruthy();
		store.isRefreshing = true;
		await Promise.resolve();
		expect(screen.getByRole('treegrid').getAttribute('aria-busy')).toBe('true');

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(screen.queryByRole('menuitem', { name: 'Refresh files' })).toBeNull();
		const permissions = screen.getByRole('menuitemcheckbox', { name: 'Permissions' });
		expect(permissions.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(permissions);
		expect(store.visibleColumns.permissions).toBe(true);
	});

	it('shows breadcrumbs by default and toggles them from the same menu', async () => {
		const { store } = renderReady([entry('README.md', 'file')]);
		expect(screen.getByRole('navigation', { name: 'File location' })).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show breadcrumbs' }));
		expect(store.showBreadcrumbs).toBe(false);
		expect(screen.queryByRole('navigation', { name: 'File location' })).toBeNull();
	});

	it('shows entry icons by default and toggles them from the settings menu', async () => {
		const readme = entry('README.md', 'file');
		const src = entry('src', 'directory');
		const { container, store } = renderReady([readme, src]);
		const readmeRow = container.querySelector<HTMLElement>(
			`[data-file-tree-row-key="${readme.path}"]`,
		);
		const srcRow = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		const parentRow = container.querySelector<HTMLElement>('[data-file-tree-parent-row]');
		if (!readmeRow || !srcRow || !parentRow) throw new Error('Expected file tree rows');

		expect(store.showIcons).toBe(true);
		expect(readmeRow.querySelector('.file-tree-entry-icon')).toBeTruthy();
		expect(srcRow.querySelector('.file-tree-entry-icon')).toBeTruthy();
		expect(parentRow.querySelector('.file-tree-entry-icon')).toBeTruthy();

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const showIcons = screen.getByRole('menuitemcheckbox', { name: 'Show icons' });
		expect(showIcons.getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(showIcons);

		expect(store.showIcons).toBe(false);
		expect(readmeRow.querySelector('.file-tree-entry-icon')).toBeNull();
		expect(srcRow.querySelector('.file-tree-entry-icon')).toBeNull();
		expect(parentRow.querySelector('.file-tree-entry-icon')).toBeNull();
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const hiddenIcons = screen.getByRole('menuitemcheckbox', { name: 'Show icons' });
		expect(hiddenIcons.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(hiddenIcons);

		expect(store.showIcons).toBe(true);
		expect(readmeRow.querySelector('.file-tree-entry-icon')).toBeTruthy();
		expect(srcRow.querySelector('.file-tree-entry-icon')).toBeTruthy();
		expect(parentRow.querySelector('.file-tree-entry-icon')).toBeTruthy();
	});

	it('pins detailed rows, closes the menu, and exposes detail sorting when reopened', async () => {
		const { container, store } = renderReady([entry('README.md', 'file')]);
		await setFileTreeWidth(container, 700);
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const detailsMode = screen.getByRole('menuitemcheckbox', {
			name: 'Always use detailed rows',
		});
		expect(detailsMode.getAttribute('aria-checked')).toBe('false');

		await fireEvent.click(detailsMode);
		expect(store.viewPreference).toBe('always-details');
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(
			container.querySelector('[data-file-tree-root]')?.getAttribute('data-file-tree-layout'),
		).toBe('details');
		await setFileTreeWidth(container, 480);
		expect(
			container.querySelector('[data-file-tree-root]')?.getAttribute('data-file-tree-layout'),
		).toBe('details');
		await setFileTreeWidth(container, 700, 'details');
		expect(
			container.querySelector('[data-file-tree-root]')?.getAttribute('data-file-tree-layout'),
		).toBe('details');

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const pinnedDetailsMode = screen.getByRole('menuitemcheckbox', {
			name: 'Always use detailed rows',
		});
		expect(pinnedDetailsMode.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByText('Details')).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: 'Reset column widths' })).toBeNull();
		expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent?.trim())).toEqual([
			'Name',
			'Size',
			'Modified',
			'Ascending',
			'Descending',
		]);

		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Modified' }));
		expect(store.sortKey).toBe('modified');
		expect(store.sortDirection).toBe('asc');
		await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Descending' }));
		expect(store.sortDirection).toBe('desc');
		expect(
			screen.getByRole('menuitemradio', { name: 'Modified' }).getAttribute('aria-checked'),
		).toBe('true');
		expect(
			screen.getByRole('menuitemradio', { name: 'Descending' }).getAttribute('aria-checked'),
		).toBe('true');

		await fireEvent.click(pinnedDetailsMode);
		expect(store.viewPreference).toBe('responsive');
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(
			container.querySelector('[data-file-tree-root]')?.getAttribute('data-file-tree-layout'),
		).toBe('columns');
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(screen.getByText('Columns')).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Reset column widths' })).toBeTruthy();
		expect(screen.queryByRole('menuitemradio')).toBeNull();
	});

	it('automatically uses detailed rows only while metadata columns do not fit', async () => {
		const { container, store } = renderReady([entry('README.md', 'file')]);
		const root = container.querySelector<HTMLElement>('[data-file-tree-root]');
		const treegrid = screen.getByRole('treegrid');
		if (!root) throw new Error('Expected file tree root');

		expect(root.dataset.fileTreeLayout).toBe('details');
		await setFileTreeWidth(container, 700);
		expect(screen.getByRole('treegrid')).toBe(treegrid);
		await setFileTreeWidth(container, 519.5);
		expect(screen.getByRole('treegrid')).toBe(treegrid);

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const alwaysDetails = screen.getByRole('menuitemcheckbox', {
			name: 'Always use detailed rows',
		});
		expect(alwaysDetails.getAttribute('aria-checked')).toBe('false');
		expect(store.viewPreference).toBe('responsive');
		expect(screen.getByText('Details')).toBeTruthy();
		expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(0);
		await fireEvent.click(alwaysDetails);
		expect(store.viewPreference).toBe('always-details');
		expect(root.dataset.fileTreeLayout).toBe('details');
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const pinnedAlwaysDetails = screen.getByRole('menuitemcheckbox', {
			name: 'Always use detailed rows',
		});
		expect(pinnedAlwaysDetails.getAttribute('aria-checked')).toBe('true');
		await fireEvent.click(pinnedAlwaysDetails);
		expect(store.viewPreference).toBe('responsive');
		expect(root.dataset.fileTreeLayout).toBe('details');
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

		await setFileTreeWidth(container, 520);
		expect(screen.getByRole('treegrid')).toBe(treegrid);
		expect(root.dataset.fileTreeLayout).toBe('columns');
	});

	it('keeps name-only rows in columns at narrow widths', async () => {
		const { container, store } = renderReady([entry('README.md', 'file')]);
		const root = container.querySelector<HTMLElement>('[data-file-tree-root]');
		if (!root) throw new Error('Expected file tree root');
		store.setColumnVisible('size', false);
		store.setColumnVisible('modified', false);
		await setFileTreeWidth(container, 200, 'columns');

		expect(root.dataset.fileTreeLayout).toBe('columns');
		await setFileTreeWidth(container, 480, 'columns');
		store.setColumnVisible('size', true);
		await waitFor(() => expect(root.dataset.fileTreeLayout).toBe('details'));
	});

	it('uses compact name-only columns while preserving the detailed-row preference', async () => {
		const { container, store } = renderReady([entry('README.md', 'file')]);
		const root = container.querySelector<HTMLElement>('[data-file-tree-root]');
		const grid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!root || !grid) throw new Error('Expected file tree root and grid');

		store.setAlwaysUseDetailedRows(true);
		store.setColumnVisible('size', false);
		store.setColumnVisible('modified', false);
		await waitFor(() => expect(root.dataset.fileTreeLayout).toBe('columns'));

		expect(store.viewPreference).toBe('always-details');
		expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
		expect(container.querySelector('[data-file-tree-subtitle]')).toBeNull();
		expect(grid.style.getPropertyValue('--file-tree-row-height')).toBe('28px');
		expect(grid.style.getPropertyValue('--file-tree-entry-icon-size')).toBe('16px');

		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(
			screen
				.getByRole('menuitemcheckbox', { name: 'Always use detailed rows' })
				.getAttribute('aria-checked'),
		).toBe('true');
		expect(screen.getByText('Columns')).toBeTruthy();

		store.setColumnVisible('modified', true);
		await waitFor(() => expect(root.dataset.fileTreeLayout).toBe('details'));
		expect(container.querySelector('[data-file-tree-subtitle]')).toBeTruthy();
		expect(grid.style.getPropertyValue('--file-tree-row-height')).toBe('44px');
		expect(grid.style.getPropertyValue('--file-tree-entry-icon-size')).toBe('32px');
	});

	it('renders configured details as an accessible one-line subtitle', async () => {
		const readme = entry('README.md', 'file', '/workspace/project', {
			modified: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
		});
		const src = entry('src', 'directory');
		const { container, store } = renderReady([readme, src]);

		store.setAlwaysUseDetailedRows(true);
		const readmeRow = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${readme.path}"]`);
			if (!row) throw new Error('Expected file row');
			return row;
		});
		const readmeSubtitle = readmeRow.querySelector<HTMLElement>('[data-file-tree-subtitle]');
		const srcRow = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${src.path}"]`);
		const srcSubtitle = srcRow?.querySelector<HTMLElement>('[data-file-tree-subtitle]');
		if (!readmeSubtitle || !srcSubtitle) throw new Error('Expected details subtitles');

		expect(readmeSubtitle.textContent).toContain('Size: 42 B');
		expect(readmeSubtitle.textContent).toContain('Modified: 2 hours ago');
		expect(readmeSubtitle.querySelector('[aria-hidden="true"]')?.textContent).toBe('·');
		expect(srcSubtitle.textContent).toContain('No details available');
		expect(readmeRow.querySelectorAll('[role="gridcell"]')).toHaveLength(0);
		expect(screen.getByRole('treegrid').getAttribute('aria-colcount')).toBe('1');
		expect(
			screen
				.getByRole('columnheader', { name: 'Name and details, sorted by Name' })
				.getAttribute('aria-sort'),
		).toBe('ascending');
		expect(screen.getByRole('treegrid').style.getPropertyValue('--file-tree-entry-icon-size')).toBe(
			'32px',
		);
		expect(
			container
				.querySelector('[data-file-tree-parent-row] svg')
				?.classList.contains('file-tree-entry-icon'),
		).toBe(true);
		expect(readmeRow.querySelector('[data-file-tree-entry-text]')?.classList.contains('h-8')).toBe(
			true,
		);

		store.setColumnVisible('permissions', true);
		await waitFor(() => expect(readmeSubtitle.textContent).toContain('Permissions: rw-r--r--'));
		expect(srcSubtitle.textContent).toContain('Permissions: rwxr-xr-x');
		const subtitleText = readmeSubtitle.textContent ?? '';
		expect(subtitleText.indexOf('Size:')).toBeLessThan(subtitleText.indexOf('Modified:'));
		expect(subtitleText.indexOf('Modified:')).toBeLessThan(subtitleText.indexOf('Permissions:'));
	});

	it('exposes complete breadcrumb paths as accessible names', () => {
		renderReady([entry('README.md', 'file')]);

		expect(screen.getByRole('button', { name: '/workspace' })).toBeTruthy();
		const current = screen.getByTitle('/workspace/project');
		expect(current.getAttribute('aria-current')).toBe('location');
		expect(current.textContent).toContain('/workspace/project');
		expect(current.hasAttribute('aria-label')).toBe(false);
	});

	it('announces destination errors and moves focus to Retry', async () => {
		const store = new FileTreeStore();
		store.navigation = {
			kind: 'error',
			target: {
				path: '/workspace/missing',
				label: 'missing',
				breadcrumbs: [{ name: 'workspace', path: '/workspace' }],
				reason: 'directory-row',
			},
			previous: response([]),
			error: { message: 'Directory not found', retryable: false },
		};
		render(FileTree, { store, onFileSelect: vi.fn() });

		expect(screen.getByRole('alert')).toBeTruthy();
		expect(screen.getByText('Could not open this directory')).toBeTruthy();
		expect(screen.getByText('Directory not found')).toBeTruthy();
		const retry = screen.getByRole('button', { name: 'Retry' });
		await waitFor(() => expect(document.activeElement).toBe(retry));
		expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
	});
});
