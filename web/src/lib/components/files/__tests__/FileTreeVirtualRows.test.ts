import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import FileTreeVirtualRows from '../FileTreeVirtualRows.svelte';
import type { FileTreeViewMode } from '../file-tree-view-profile.js';
import {
	FILE_TREE_COARSE_ROW_HEIGHT,
	FILE_TREE_HEADER_HEIGHT,
	FILE_TREE_ROW_HEIGHT,
} from '../FileTreeVirtualController.svelte.js';

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

function renderRows(count: number, viewMode: FileTreeViewMode = 'columns') {
	const store = new FileTreeStore();
	store.navigation = { kind: 'ready', response: response(entries(count)) };
	const onFileSelect = vi.fn();
	const result = render(FileTreeVirtualRows, {
		store,
		viewMode,
		onFileSelect,
	});
	const setViewMode = (nextViewMode: FileTreeViewMode) =>
		result.rerender({ store, viewMode: nextViewMode, onFileSelect });
	return { ...result, store, setViewMode };
}

function mockFinePointerViewport(
	treegrid: HTMLElement,
	clampTiming: 'eager' | 'layout' = 'eager',
): void {
	const viewportHeight = 640;
	let physicalScrollOffset = 0;
	const renderedScrollHeight = (): number => {
		const headerHeight = treegrid.querySelector('[data-file-tree-column-grid]') ? 32 : 0;
		const virtualRow = treegrid.querySelector<HTMLElement>('[data-file-tree-virtual-row]');
		const virtualHeight = Number.parseFloat(virtualRow?.parentElement?.style.height ?? '0');
		return headerHeight + virtualHeight;
	};
	const clampPhysicalOffset = (): void => {
		const maximum = Math.max(0, renderedScrollHeight() - viewportHeight);
		physicalScrollOffset = Math.min(physicalScrollOffset, maximum);
	};

	Object.defineProperties(treegrid, {
		clientHeight: { configurable: true, value: viewportHeight },
		scrollHeight: {
			configurable: true,
			get: () => {
				if (clampTiming === 'layout') clampPhysicalOffset();
				return renderedScrollHeight();
			},
		},
		scrollTop: {
			configurable: true,
			get: () => {
				if (clampTiming === 'eager') clampPhysicalOffset();
				return physicalScrollOffset;
			},
			set: (value: number) => {
				physicalScrollOffset = Math.max(0, value);
			},
		},
	});
	installFileTreeRects(treegrid);
}

function installFileTreeRects(treegrid: HTMLElement): void {
	const sizer = treegrid.querySelector<HTMLElement>('[data-file-tree-virtual-sizer]');
	if (!sizer) throw new Error('Expected file tree virtual sizer');
	Object.defineProperty(treegrid, 'getBoundingClientRect', {
		configurable: true,
		value: () => new DOMRect(0, 0, 0, treegrid.clientHeight),
	});
	Object.defineProperty(sizer, 'getBoundingClientRect', {
		configurable: true,
		value: () => {
			const headerHeight = treegrid.querySelector('[data-file-tree-column-grid]') ? 32 : 0;
			return new DOMRect(0, headerHeight - treegrid.scrollTop, 0, sizer.offsetHeight);
		},
	});
}

function scrollOnNextAnimationFrame(element: HTMLElement, offset: number): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			element.scrollTop = offset;
			element.dispatchEvent(new Event('scroll'));
			resolve();
		});
	});
}

function forceLayoutOnNextAnimationFrame(element: HTMLElement): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			void element.scrollHeight;
			resolve();
		});
	});
}

describe('FileTreeVirtualRows', () => {
	beforeEach(() => localStorage.clear());
	afterEach(cleanup);

	it('caps the multi-column table minimum width at the available panel width', () => {
		const { container } = renderRows(1);
		const table = container.querySelector<HTMLElement>('[data-file-tree-grid] > div');

		expect(table?.style.minWidth).toBe('min(520px, 100%)');
	});

	it('suppresses scroll-boundary bounce in the file viewport', () => {
		const { container } = renderRows(1);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');

		expect(treegrid?.dataset.workspaceScrollRegion).toBe('primary');
		expect(treegrid?.classList.contains('overscroll-none')).toBe(true);
		expect(treegrid?.classList.contains('overscroll-contain')).toBe(false);
		expect(treegrid?.style.getPropertyValue('overflow-anchor')).toBe('none');
	});

	it('uses compact desktop rows and a reduced coarse-pointer row height', async () => {
		const originalMatchMedia = window.matchMedia;
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: (query: string) => ({
				matches: query === '(pointer: coarse)',
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});

		try {
			const { container, setViewMode } = renderRows(1);
			const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
			await waitFor(() =>
				expect(treegrid?.style.getPropertyValue('--file-tree-row-height')).toBe(
					`${FILE_TREE_COARSE_ROW_HEIGHT}px`,
				),
			);
			expect(treegrid?.style.getPropertyValue('--file-tree-disclosure-size')).toBe(
				`${FILE_TREE_COARSE_ROW_HEIGHT}px`,
			);

			await setViewMode('details');
			await waitFor(() =>
				expect(treegrid?.style.getPropertyValue('--file-tree-row-height')).toBe('52px'),
			);
			expect(treegrid?.style.getPropertyValue('--file-tree-disclosure-size')).toBe('36px');
		} finally {
			Object.defineProperty(window, 'matchMedia', {
				configurable: true,
				value: originalMatchMedia,
			});
		}
	});

	it('uses the compact row height for fine pointers', async () => {
		const { container, setViewMode } = renderRows(1);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');

		expect(treegrid?.style.getPropertyValue('--file-tree-row-height')).toBe(
			`${FILE_TREE_ROW_HEIGHT}px`,
		);

		await setViewMode('details');
		await waitFor(() =>
			expect(treegrid?.style.getPropertyValue('--file-tree-row-height')).toBe('44px'),
		);
		expect(treegrid?.style.getPropertyValue('--file-tree-disclosure-size')).toBe('28px');
	});

	it('caps the scrollable table minimum width in column mode', () => {
		const { container } = renderRows(1);
		const table = container.querySelector<HTMLElement>('[data-file-tree-grid] > div');

		expect(table?.style.minWidth).toBe('min(520px, 100%)');
	});

	it('caps the single-column mobile table at the available panel width', () => {
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response(entries(1)) };
		store.setColumnVisible('size', false);
		store.setColumnVisible('modified', false);
		const { container } = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect: vi.fn(),
		});
		const table = container.querySelector<HTMLElement>('[data-file-tree-grid] > div');

		expect(table?.style.minWidth).toBe('min(240px, 100%)');
	});

	it('starts a details view with details geometry and semantics', async () => {
		const { container } = renderRows(1, 'details');
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		const table = container.querySelector<HTMLElement>('[data-file-tree-grid] > div');
		const header = screen.getByRole('columnheader', {
			name: 'Name and details, sorted by Name',
		});

		expect(treegrid?.style.getPropertyValue('--file-tree-row-height')).toBe('44px');
		expect(treegrid?.style.getPropertyValue('--file-tree-disclosure-size')).toBe('28px');
		expect(treegrid?.getAttribute('aria-colcount')).toBe('1');
		expect(table?.style.minWidth).toBe('min(240px, 100%)');
		expect(header.getAttribute('aria-colindex')).toBe('1');
		expect(header.getAttribute('aria-sort')).toBe('ascending');
		await waitFor(() =>
			expect(screen.getAllByRole('row')[1]?.getAttribute('aria-rowindex')).toBe('2'),
		);
	});

	it('keeps a 100,000-row directory to a bounded mounted window with absolute ARIA positions', async () => {
		const { container, setViewMode } = renderRows(100_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');

		await waitFor(() => {
			expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeGreaterThan(0);
		});
		const wrappers = [...container.querySelectorAll<HTMLElement>('[data-file-tree-virtual-row]')];
		expect(wrappers.length).toBeLessThan(80);
		expect(treegrid.getAttribute('aria-rowcount')).toBe('100002');

		const rowIndexes = [
			...container.querySelectorAll<HTMLElement>('[role="row"][aria-rowindex]'),
		].map((row) => Number(row.getAttribute('aria-rowindex')));
		expect(rowIndexes[0]).toBe(1);
		expect(rowIndexes).toEqual([...rowIndexes].sort((left, right) => left - right));

		await setViewMode('details');
		await waitFor(() =>
			expect(treegrid.style.getPropertyValue('--file-tree-row-height')).toBe('44px'),
		);
		expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeLessThan(80);
	}, 15_000);

	it('preserves the visible anchor and focused row across view geometry changes', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid);
		treegrid.scrollTop = 640;
		await fireEvent.scroll(treegrid);
		const path = '/workspace/file-000022.ts';
		const focused = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${path}"]`);
			if (!row) throw new Error('Expected anchor row');
			return row;
		});
		focused.focus();

		await setViewMode('details');

		await waitFor(() => expect(treegrid.scrollTop).toBeCloseTo(992, 0));
		const restored = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${path}"]`);
		expect(restored).toBe(focused);
		expect(document.activeElement).toBe(focused);
	});

	it('preserves the physical end when columns grow into details rows', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid);
		treegrid.scrollTop = 27_420;
		await fireEvent.scroll(treegrid);

		await setViewMode('details');

		await waitFor(() => expect(treegrid.scrollTop).toBe(43_404));
	});

	it('preserves the physical end when details rows shrink into columns', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid);
		await setViewMode('details');
		await waitFor(() =>
			expect(treegrid.style.getPropertyValue('--file-tree-row-height')).toBe('44px'),
		);
		treegrid.scrollTop = 43_404;
		await fireEvent.scroll(treegrid);

		await setViewMode('columns');

		await waitFor(() => expect(treegrid.scrollTop).toBe(27_420));
	});

	it('preserves a deep anchor instead of treating a shrinking geometry as the end', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid, 'layout');
		await setViewMode('details');
		await waitFor(() =>
			expect(treegrid.style.getPropertyValue('--file-tree-row-height')).toBe('44px'),
		);
		treegrid.scrollTop = 30_000;
		await fireEvent.scroll(treegrid);
		await waitFor(() =>
			expect(
				container.querySelector('[data-file-tree-row-key="/workspace/file-000681.ts"]'),
			).toBeTruthy(),
		);

		const frameLayout = forceLayoutOnNextAnimationFrame(treegrid);
		await setViewMode('columns');
		await frameLayout;

		await waitFor(() => expect(treegrid.scrollTop).toBeCloseTo(19_104, 0));
	});

	it('preserves a near-end anchor after the removed header temporarily clamps scrolling', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid);
		treegrid.scrollTop = 27_380;
		await fireEvent.scroll(treegrid);
		const path = '/workspace/file-000977.ts';
		await waitFor(() => {
			const row = container.querySelector<HTMLElement>(`[data-file-tree-row-key="${path}"]`);
			if (!row) throw new Error('Expected near-end anchor row');
		});

		await setViewMode('details');

		await waitFor(() => expect(treegrid.scrollTop).toBeCloseTo(43_012, 0));
	});

	it('does not overwrite user scrolling while a geometry restore is deferred', async () => {
		const { container, setViewMode } = renderRows(1_000);
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		mockFinePointerViewport(treegrid);
		treegrid.scrollTop = 640;
		await fireEvent.scroll(treegrid);

		const userScroll = scrollOnNextAnimationFrame(treegrid, 700);
		await setViewMode('details');
		await userScroll;
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(treegrid.scrollTop).toBe(700);
	});

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
		const { container } = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect: vi.fn(),
		});
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

	it('preserves the visible anchor when remembered focus is reconciled outside the grid', async () => {
		const items = entries(100);
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response(items) };
		const { container } = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect: vi.fn(),
		});
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		const first = await waitFor(() => {
			const row = container.querySelector<HTMLElement>(
				`[data-file-tree-row-key="${items[0]!.path}"]`,
			);
			if (!row) throw new Error('Expected first file row');
			return row;
		});
		if (!treegrid) throw new Error('Expected file treegrid');
		Object.defineProperties(treegrid, {
			clientHeight: { configurable: true, value: 640 },
			scrollHeight: {
				configurable: true,
				value: FILE_TREE_HEADER_HEIGHT + items.length * FILE_TREE_ROW_HEIGHT,
			},
		});
		installFileTreeRects(treegrid);
		const outside = document.createElement('button');
		document.body.append(outside);
		first.focus();
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		treegrid.scrollTop = 640;
		await fireEvent.scroll(treegrid);
		outside.focus();

		store.navigation = { kind: 'ready', response: response(items.slice(1)) };

		await waitFor(() => expect(treegrid.scrollTop).toBeCloseTo(640 - FILE_TREE_ROW_HEIGHT, 10));
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('does not overwrite user scrolling while an anchor restore is deferred', async () => {
		const items = entries(100);
		const store = new FileTreeStore();
		store.navigation = { kind: 'ready', response: response(items) };
		const { container } = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect: vi.fn(),
		});
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		await waitFor(() =>
			expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeGreaterThan(0),
		);
		treegrid.scrollTop = 640;
		await fireEvent.scroll(treegrid);
		const prepended = entries(1).map((item) => ({
			...item,
			name: '000-prepended.ts',
			path: '/workspace/000-prepended.ts',
			relativePath: '000-prepended.ts',
		}));

		const userScroll = scrollOnNextAnimationFrame(treegrid, 700);
		store.navigation = { kind: 'ready', response: response([...prepended, ...items]) };
		await userScroll;
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(treegrid.scrollTop).toBe(700);
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
		const { container } = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect: vi.fn(),
		});
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
		const onFileSelect = vi.fn();
		const rendered = render(FileTreeVirtualRows, {
			store,
			viewMode: 'columns',
			onFileSelect,
		});
		const { container } = rendered;
		const treegrid = container.querySelector<HTMLElement>('[data-file-tree-grid]');
		if (!treegrid) throw new Error('Expected file treegrid');
		await waitFor(() =>
			expect(container.querySelectorAll('[data-file-tree-virtual-row]').length).toBeGreaterThan(0),
		);
		const callsAfterModelBuild = sortEntries.mock.calls.length;

		treegrid.scrollTop = 6_400;
		await fireEvent.scroll(treegrid);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await rendered.rerender({ store, viewMode: 'details', onFileSelect });
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		expect(sortEntries).toHaveBeenCalledTimes(callsAfterModelBuild);
	});
});
