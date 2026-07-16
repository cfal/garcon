import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import FileTreeToolbar from '../FileTreeToolbar.svelte';

vi.mock('$lib/api/files', () => ({ getTree: vi.fn() }));

function readyStore(): FileTreeStore {
	const store = new FileTreeStore();
	store.navigation = {
		kind: 'ready',
		response: {
			fileRootPath: '/workspace',
			directory: {
				path: '/workspace/project',
				relativePath: 'project',
				parentPath: '/workspace',
				breadcrumbs: [
					{ name: 'workspace', path: '/workspace' },
					{ name: 'project', path: '/workspace/project' },
				],
			},
			entries: [],
		},
	};
	return store;
}

async function renderMeasuredToolbar(initialWidth = 270) {
	const store = readyStore();
	const { container } = render(FileTreeToolbar, { store });
	await tick();
	const measuredRoot = container.querySelector<HTMLElement>('[data-responsive-surface-actions]');
	if (!measuredRoot) throw new Error('Expected responsive action root');
	const root: HTMLElement = measuredRoot;
	let availableWidth = initialWidth;
	Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
	for (const element of container.querySelectorAll<HTMLElement>('[data-surface-action-measure]')) {
		const widths: Record<string, number> = {
			'filter-files': 80,
			'chat-project': 100,
			'refresh-files': 32,
		};
		element.getBoundingClientRect = () => ({
			width: widths[element.dataset.surfaceActionMeasure ?? ''] ?? 0,
		}) as DOMRect;
	}
	const menuMeasure = container.querySelector<HTMLElement>(
		'[data-surface-action-overflow-measure]',
	);
	if (!menuMeasure) throw new Error('Expected menu measurement control');
	menuMeasure.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;

	async function setWidth(width: number): Promise<void> {
		availableWidth = width;
		ResizeObserverHarness.emit(root, availableWidth);
		await tick();
	}

	await setWidth(initialWidth);
	return { store, setWidth };
}

describe('FileTreeToolbar', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		localStorage.clear();
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('moves Refresh from its toolbar button into the persistent menu when space runs out', async () => {
		const { setWidth } = await renderMeasuredToolbar();
		expect(screen.getByRole('button', { name: 'Refresh files' })).toBeTruthy();

		await setWidth(240);
		expect(screen.queryByRole('button', { name: 'Refresh files' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(screen.getByRole('menuitem', { name: 'Refresh files' })).toBeTruthy();
	});

	it('keeps focus on the Refresh button while it reports a busy refresh', async () => {
		const { store } = await renderMeasuredToolbar();
		const refresh = screen.getByRole('button', { name: 'Refresh files' });
		refresh.focus();

		store.isRefreshing = true;
		await tick();

		expect(refresh.hasAttribute('disabled')).toBe(false);
		expect(refresh.getAttribute('aria-disabled')).toBe('true');
		expect(refresh.getAttribute('aria-busy')).toBe('true');
		expect(document.activeElement).toBe(refresh);
	});

	it('focuses Filter files and restores toolbar focus after closing it', async () => {
		const { store } = await renderMeasuredToolbar();
		await fireEvent.click(screen.getByRole('button', { name: 'Filter files' }));
		await tick();
		const input = screen.getByPlaceholderText('Filter by name...');
		expect(document.activeElement).toBe(input);

		await fireEvent.input(input, { target: { value: 'src' } });
		await fireEvent.keyDown(input, { key: 'Escape' });
		await tick();
		expect(store.filterInput).toBe('');
		expect(screen.queryByPlaceholderText('Filter by name...')).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter files' }));
	});

	it('focuses Filter files when it is opened from the overflow menu', async () => {
		const { setWidth } = await renderMeasuredToolbar();
		await setWidth(100);
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Filter files' }));
		await tick();

		expect(document.activeElement).toBe(screen.getByPlaceholderText('Filter by name...'));
	});
});
