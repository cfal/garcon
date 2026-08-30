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

async function renderMeasuredToolbar(initialWidth = 200) {
	const store = readyStore();
	const { container } = render(FileTreeToolbar, { store, viewMode: 'columns' });
	await tick();
	const measuredRoot = container.querySelector<HTMLElement>('[data-responsive-surface-actions]');
	if (!measuredRoot) throw new Error('Expected responsive action root');
	const root: HTMLElement = measuredRoot;
	let availableWidth = initialWidth;
	Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
	for (const element of container.querySelectorAll<HTMLElement>('[data-surface-action-measure]')) {
		const widths: Record<string, number> = {
			'filter-files': 32,
			home: 32,
			'chat-project': 32,
			'refresh-files': 32,
		};
		element.getBoundingClientRect = () =>
			({
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

	it('uses a settings icon for its persistent view menu', async () => {
		await renderMeasuredToolbar();
		const trigger = screen.getByRole('button', { name: 'File browser actions' });

		expect(trigger.querySelector('svg')?.classList.contains('lucide-settings')).toBe(true);
	});

	it('uses distinct icon-only actions with accessible titles', async () => {
		await renderMeasuredToolbar();
		const filter = screen.getByRole('button', { name: 'Filter files' });
		const home = screen.getByRole('button', { name: 'Home' });
		const chatProject = screen.getByRole('button', { name: 'Go to chat project' });

		for (const button of [filter, home, chatProject]) {
			expect(button.textContent?.trim()).toBe('');
			expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'));
		}
		expect(home.querySelector('svg')?.classList.contains('lucide-house')).toBe(true);
		expect(chatProject.querySelector('svg')?.classList.contains('lucide-folder-code')).toBe(true);
	});

	it('opens Home and disables it at the file root', async () => {
		const { store } = await renderMeasuredToolbar();
		const goToHome = vi.spyOn(store, 'goToHome').mockResolvedValue();
		const initialResponse = store.readyResponse!;

		await fireEvent.click(screen.getByRole('button', { name: 'Home' }));
		expect(goToHome).toHaveBeenCalledOnce();

		store.navigation = {
			kind: 'loading',
			target: {
				path: '/workspace/project/src',
				label: 'src',
				breadcrumbs: [
					{ name: 'workspace', path: '/workspace' },
					{ name: 'project', path: '/workspace/project' },
					{ name: 'src', path: '/workspace/project/src' },
				],
				reason: 'directory-row',
			},
			previous: initialResponse,
		};
		await tick();
		expect(screen.getByRole('button', { name: 'Home' }).hasAttribute('disabled')).toBe(true);

		store.navigation = { kind: 'idle' };
		await tick();
		expect(screen.getByRole('button', { name: 'Home' }).hasAttribute('disabled')).toBe(true);

		store.navigation = {
			kind: 'ready',
			response: {
				...initialResponse,
				directory: {
					path: '/workspace',
					relativePath: '',
					parentPath: null,
					breadcrumbs: [{ name: 'workspace', path: '/workspace' }],
				},
			},
		};
		await tick();

		const home = screen.getByRole('button', { name: 'Home' });
		expect(home.hasAttribute('disabled')).toBe(true);
		expect(home.getAttribute('title')).toBe('Already at home');
	});

	it('moves Refresh from its toolbar button into the persistent menu when space runs out', async () => {
		const { setWidth } = await renderMeasuredToolbar();
		expect(screen.getByRole('button', { name: 'Refresh files' })).toBeTruthy();

		await setWidth(150);
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
		await setWidth(60);
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		expect(screen.getByRole('menuitem', { name: 'Home' })).toBeTruthy();
		await fireEvent.click(screen.getByRole('menuitem', { name: 'Filter files' }));
		await tick();

		expect(document.activeElement).toBe(screen.getByPlaceholderText('Filter by name...'));
	});

	it('keeps overflow actions before persistent view controls', async () => {
		const { setWidth } = await renderMeasuredToolbar();
		await setWidth(150);
		await fireEvent.click(screen.getByRole('button', { name: 'File browser actions' }));
		const refresh = screen.getByRole('menuitem', { name: 'Refresh files' });
		const details = screen.getByRole('menuitemcheckbox', {
			name: 'Always use detailed rows',
		});

		expect(
			refresh.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
