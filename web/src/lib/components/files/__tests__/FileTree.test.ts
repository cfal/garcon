import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import * as filesApi from '$lib/api/files';
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
): FileTreeEntry {
	return {
		name,
		path: `${parent}/${name}`,
		relativePath: `project/${name}`,
		type,
		size: type === 'file' ? 42 : 4096,
		modified: null,
		permissionsRwx: type === 'file' ? 'rw-r--r--' : 'rwxr-xr-x',
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

function renderReady(entries: FileTreeEntry[]) {
	const store = new FileTreeStore();
	store.navigation = { kind: 'ready', response: response(entries) };
	const onFileSelect = vi.fn();
	const result = render(FileTree, {
		store,
		presentation: 'main',
		onFileSelect,
		onImageSelect: onFileSelect,
	});
	return { ...result, store, onFileSelect };
}

describe('FileTree', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetAllMocks();
		copyToClipboard.mockResolvedValue(true);
	});

	afterEach(cleanup);

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

	it('opens a file from anywhere on its row', async () => {
		const readme = entry('README.md', 'file');
		const { onFileSelect } = renderReady([readme]);

		await fireEvent.click(screen.getByRole('rowheader', { name: 'README.md' }));
		expect(onFileSelect).toHaveBeenCalledWith(readme);
	});

	it('copies file paths without activating rows and omits the action from directories', async () => {
		const src = entry('src', 'directory');
		const readme = entry('README.md', 'file');
		const { onFileSelect } = renderReady([src, readme]);
		const copyButton = screen.getByRole('button', { name: 'Copy file path' });

		expect(screen.getAllByRole('button', { name: 'Copy file path' })).toHaveLength(1);
		await fireEvent.keyDown(copyButton, { key: 'Enter' });
		expect(onFileSelect).not.toHaveBeenCalled();

		await fireEvent.click(copyButton);
		expect(copyToClipboard).toHaveBeenCalledWith(readme.relativePath, undefined);
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
		expect(screen.getByRole('rowheader', { name: 'src' })).toBeTruthy();
		expect(screen.getByRole('rowheader', { name: 'App.svelte' })).toBeTruthy();
		expect(screen.queryByRole('rowheader', { name: 'README.md' })).toBeNull();
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
		render(FileTree, { store, presentation: 'main', onFileSelect: vi.fn() });

		expect(screen.getByRole('alert')).toBeTruthy();
		expect(screen.getByText('Could not open this directory')).toBeTruthy();
		expect(screen.getByText('Directory not found')).toBeTruthy();
		const retry = screen.getByRole('button', { name: 'Retry' });
		await waitFor(() => expect(document.activeElement).toBe(retry));
		expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
	});
});
