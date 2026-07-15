import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import FileTreeVirtualRows from '../FileTreeVirtualRows.svelte';

function entries(count: number): FileTreeEntry[] {
	return Array.from({ length: count }, (_, index) => {
		const name = `file-${String(index).padStart(6, '0')}.ts`;
		return {
			name,
			path: `/workspace/${name}`,
			relativePath: name,
			type: 'file' as const,
			size: index,
			modified: null,
			permissionsRwx: 'rw-r--r--',
		};
	});
}

function response(items: FileTreeEntry[]): FileTreeResponse {
	return {
		fileRootPath: '/workspace',
		directory: {
			path: '/workspace',
			relativePath: '',
			parentPath: null,
			breadcrumbs: [{ name: 'workspace', path: '/workspace' }],
		},
		entries: items,
	};
}

function renderRows(count: number) {
	const store = new FileTreeStore();
	store.navigation = { kind: 'ready', response: response(entries(count)) };
	const result = render(FileTreeVirtualRows, {
		store,
		onFileSelect: vi.fn(),
	});
	return { ...result, store };
}

describe('FileTreeVirtualRows', () => {
	beforeEach(() => localStorage.clear());
	afterEach(cleanup);

	it('keeps a 100,000-row directory to a bounded mounted window with absolute ARIA positions', async () => {
		const { container } = renderRows(100_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');

		await waitFor(() => {
			expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeGreaterThan(0);
		});
		const wrappers = [...container.querySelectorAll<HTMLElement>('[data-file-tree-virtual-row]')];
		expect(wrappers.length).toBeLessThan(80);
		expect(treegrid.getAttribute('aria-rowcount')).toBe('100001');

		const rowIndexes = [
			...container.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]'),
		].map((row) => Number(row.getAttribute('aria-rowindex')));
		expect(rowIndexes[0]).toBe(1);
		expect(rowIndexes).toEqual([...rowIndexes].sort((left, right) => left - right));
	}, 15_000);

	it('focuses an initially unmounted End target and retains it while the viewport moves away', async () => {
		const { container } = renderRows(10_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		const firstPath = '/workspace/file-000000.ts';
		const lastPath = '/workspace/file-009999.ts';

		await waitFor(() => {
			expect(container.querySelector(`[data-file-tree-row-key="${firstPath}"]`)).toBeTruthy();
		});
		const first = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${firstPath}"]`)!;
		first.focus();
		await fireEvent.keyDown(first, { key: 'End' });
		await waitFor(() => {
			expect(document.activeElement?.getAttribute('data-file-tree-row-key')).toBe(lastPath);
		});
		expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeLessThan(80);

		treegrid.scrollTop = 0;
		await fireEvent.scroll(treegrid);
		await waitFor(() => {
			expect(container.querySelector(`[data-file-tree-row-key="${lastPath}"]`)).toBeTruthy();
		});
		expect(document.activeElement?.getAttribute('data-file-tree-row-key')).toBe(lastPath);
	});

	it('cancels a stale long-distance focus transfer when a newer request wins', async () => {
		const { container } = renderRows(10_000);
		const firstPath = '/workspace/file-000000.ts';
		const first = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${firstPath}"]`);
			if (!row) throw new Error('Expected first file row');
			return row;
		});
		first.focus();
		first.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
		);
		first.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
		);

		await waitFor(() =>
			expect(document.activeElement?.getAttribute('data-file-tree-row-key')).toBe(firstPath),
		);
	});

	it('reconciles removed DOM focus to the nearest surviving actionable row', async () => {
		const items = entries(3);
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response(items) };
		const { container } = render(FileTreeVirtualRows, { store, onFileSelect: vi.fn() });
		const removedPath = items[1]!.path;
		const predecessorPath = items[0]!.path;
		const removed = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${removedPath}"]`);
			if (!row) throw new Error('Expected removable file row');
			return row;
		});
		removed.focus();

		store.navigation = { kind: 'ready', response: response([items[0]!, items[2]!]) };

		await waitFor(() =>
			expect(document.activeElement?.getAttribute('data-file-tree-row-key')).toBe(predecessorPath),
		);
	});

	it('keeps treegrid layout wrappers presentational and loading rows outside roving focus', async () => {
		const directory: FileTreeEntry = {
			name: 'src',
			path: '/workspace/src',
			relativePath: 'src',
			type: 'directory',
			size: 0,
			modified: null,
			permissionsRwx: 'rwxr-xr-x',
		};
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response([directory]) };
		store.expandedDirs = new Set([directory.path]);
		store.loadingDirs = new Set([directory.path]);
		const { container } = render(FileTreeVirtualRows, { store, onFileSelect: vi.fn() });
		const status = await screen.findByRole('status');
		const loadingRow = status.closest<HTMLElement>('[role="row"]');

		expect(container.querySelectorAll('[role="presentation"]').length).toBeGreaterThanOrEqual(3);
		expect(loadingRow?.hasAttribute('data-file-tree-row')).toBe(false);
		expect(loadingRow?.hasAttribute('data-file-tree-row-key')).toBe(false);
	});

	it('resets the viewport when filtering intentionally changes row order', async () => {
		const { container, store } = renderRows(500);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		treegrid.scrollTop = 640;
		await fireEvent.scroll(treegrid);
		expect(treegrid.scrollTop).toBe(640);

		store.filterInput = 'file-0004';
		await waitFor(() => expect(treegrid.scrollTop).toBe(0));
	});

	it('does not sort or rebuild the logical model in response to scrolling', async () => {
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response(entries(1_000)) };
		const sortEntries = vi.spyOn(store, 'sortEntries');
		const { container } = render(FileTreeVirtualRows, { store, onFileSelect: vi.fn() });
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		await waitFor(() =>
			expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeGreaterThan(0),
		);
		const callsAfterModelBuild = sortEntries.mock.calls.length;

		treegrid.scrollTop = 6_400;
		await fireEvent.scroll(treegrid);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(sortEntries).toHaveBeenCalledTimes(callsAfterModelBuild);
	});
});
