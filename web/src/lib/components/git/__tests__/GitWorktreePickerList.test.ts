import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import GitWorktreePickerList from '../GitWorktreePickerList.svelte';
import {
	WORKTREE_ROW_HEIGHT,
	worktreeOptionId,
} from '../git-worktree-picker-list.js';

const LISTBOX_ID = 'worktree-list';

let resizeCallback: ResizeObserverCallback | undefined;
let resizeDisconnect: ReturnType<typeof vi.fn<() => void>>;

function makeWorktrees(count: number): GitWorktreeItem[] {
	return Array.from({ length: count }, (_, index) => {
		const name = `worktree-${index}`;
		return {
			name,
			path: `/workspace/${name}`,
			branch: name,
			isCurrent: index === 0,
			isMain: index === 0,
			isPathMissing: false,
			lastModifiedAt: '2026-07-15T10:00:00.000Z',
		};
	});
}

function renderList(worktrees: GitWorktreeItem[], overrides: Record<string, unknown> = {}) {
	return render(GitWorktreePickerList, {
		listboxId: LISTBOX_ID,
		worktrees,
		totalWorktreeCount: worktrees.length,
		selectedIndex: worktrees.length > 0 ? 0 : -1,
		selectedPath: worktrees[0]?.path,
		isLoading: false,
		hasLoadError: false,
		onActivate: vi.fn(),
		onSelect: vi.fn(),
		onActiveOptionIdChange: vi.fn(),
		...overrides,
	});
}

function virtualRows(): NodeListOf<HTMLElement> {
	return document.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]');
}

function mockRootFontSize(fontSize: string): void {
	const getComputedStyle = window.getComputedStyle.bind(window);
	const rootStyle = { fontSize } satisfies Pick<CSSStyleDeclaration, 'fontSize'>;
	vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) =>
		element === document.documentElement
			? (rootStyle as CSSStyleDeclaration)
			: getComputedStyle(element, pseudoElement),
	);
}

beforeEach(() => {
	resizeCallback = undefined;
	resizeDisconnect = vi.fn<() => void>();
	class TestResizeObserver implements ResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			resizeCallback = callback;
		}

		observe = vi.fn();
		unobserve = vi.fn();
		disconnect(): void {
			resizeDisconnect();
		}
	}
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('GitWorktreePickerList', () => {
	it('switches to bounded virtualization only above eighty worktrees', async () => {
		const worktrees = makeWorktrees(81);
		const view = renderList(worktrees.slice(0, 80));

		expect(document.querySelector('[data-worktree-virtual-list]')).toBeNull();
		expect(screen.getAllByRole('option')).toHaveLength(80);

		await view.rerender({
			worktrees,
			totalWorktreeCount: worktrees.length,
		});

		await waitFor(() => {
			expect(document.querySelector('[data-worktree-virtual-list]')).toBeTruthy();
			expect(virtualRows().length).toBeLessThan(30);
		});
	});

	it('bounds five thousand rows and exposes logical accessibility positions', async () => {
		const worktrees = makeWorktrees(5_000);
		const onActiveOptionIdChange = vi.fn();
		renderList(worktrees, { onActiveOptionIdChange });

		const spacer = document.querySelector<HTMLElement>('[data-worktree-virtual-list]');
		expect(spacer?.style.height).toBe(`${5_000 * WORKTREE_ROW_HEIGHT}px`);
		expect(virtualRows().length).toBeLessThan(30);
		expect(screen.queryByRole('option', { name: /worktree-4999/ })).toBeNull();

		const firstOption = screen.getByRole('option', { name: /worktree-0/ });
		expect(firstOption.getAttribute('aria-posinset')).toBe('1');
		expect(firstOption.getAttribute('aria-setsize')).toBe('5000');
		await waitFor(() => {
			const activeId = worktreeOptionId(LISTBOX_ID, worktrees[0].path);
			expect(onActiveOptionIdChange).toHaveBeenLastCalledWith(activeId);
			expect(document.getElementById(activeId)).toBe(firstOption);
		});
	});

	it('scales fixed row geometry with the browser root font size', () => {
		mockRootFontSize('20px');
		const worktrees = makeWorktrees(81);
		renderList(worktrees);

		const scaledRowHeight = WORKTREE_ROW_HEIGHT * 1.25;
		expect(document.querySelector<HTMLElement>('[data-worktree-virtual-list]')?.style.height).toBe(
			`${worktrees.length * scaledRowHeight}px`,
		);
		expect(screen.getByRole('option', { name: /worktree-0/ }).style.height).toBe(
			`${scaledRowHeight}px`,
		);
	});

	it('does not shrink fixed rows below their content-safe base height', () => {
		mockRootFontSize('12px');
		const worktrees = makeWorktrees(81);
		renderList(worktrees);

		expect(document.querySelector<HTMLElement>('[data-worktree-virtual-list]')?.style.height).toBe(
			`${worktrees.length * WORKTREE_ROW_HEIGHT}px`,
		);
		expect(screen.getByRole('option', { name: /worktree-0/ }).style.height).toBe(
			`${WORKTREE_ROW_HEIGHT}px`,
		);
	});

	it('mounts a deep window and clears a stale active descendant after manual scrolling', async () => {
		const worktrees = makeWorktrees(5_000);
		const onActiveOptionIdChange = vi.fn();
		const view = renderList(worktrees, { onActiveOptionIdChange });
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		viewport.scrollTop = 2_500 * WORKTREE_ROW_HEIGHT;
		await fireEvent.scroll(viewport);

		await waitFor(() => {
			const deepOption = screen.getByRole('option', { name: /worktree-2500/ });
			expect(deepOption.getAttribute('aria-posinset')).toBe('2501');
			expect(deepOption.getAttribute('aria-setsize')).toBe('5000');
			expect(screen.queryByRole('option', { name: /worktree-0/ })).toBeNull();
			expect(onActiveOptionIdChange).toHaveBeenLastCalledWith(undefined);
		});

		await view.rerender({
			selectedIndex: 2_500,
			selectedPath: worktrees[2_500].path,
		});
		await waitFor(() => {
			const activeId = worktreeOptionId(LISTBOX_ID, worktrees[2_500].path);
			expect(onActiveOptionIdChange).toHaveBeenLastCalledWith(activeId);
			expect(document.getElementById(activeId)).toBeTruthy();
		});
	});

	it('scrolls a stable selected path to its deep index after reordering', async () => {
		const worktrees = makeWorktrees(5_000);
		const selectedPath = worktrees[0].path;
		const onActiveOptionIdChange = vi.fn();
		const view = renderList(worktrees, { onActiveOptionIdChange });
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		await view.rerender({
			worktrees: [...worktrees].reverse(),
			selectedIndex: worktrees.length - 1,
			selectedPath,
		});

		await waitFor(() => {
			expect(viewport.scrollTop).toBeGreaterThan(290_000);
			const activeId = worktreeOptionId(LISTBOX_ID, selectedPath);
			expect(document.getElementById(activeId)).toBeTruthy();
			expect(onActiveOptionIdChange).toHaveBeenLastCalledWith(activeId);
		});
	});

	it('returns from a deep window to the selected row after filtering', async () => {
		const worktrees = makeWorktrees(5_000);
		const view = renderList(worktrees);
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		viewport.scrollTop = 2_500 * WORKTREE_ROW_HEIGHT;
		await fireEvent.scroll(viewport);
		await waitFor(() => {
			expect(screen.getByRole('option', { name: /worktree-2500/ })).toBeTruthy();
		});

		await view.rerender({
			worktrees: worktrees.slice(0, 100),
			totalWorktreeCount: worktrees.length,
			selectedIndex: 0,
			selectedPath: worktrees[0].path,
		});

		await waitFor(() => {
			expect(viewport.scrollTop).toBe(0);
			expect(screen.getByRole('option', { name: /worktree-0/ })).toBeTruthy();
		});
	});

	it('keeps missing rows disabled and prevents their selection callback', async () => {
		const [missing] = makeWorktrees(1);
		missing.isPathMissing = true;
		const onSelect = vi.fn();
		renderList([missing], {
			selectedIndex: -1,
			selectedPath: undefined,
			onSelect,
		});

		const option = screen.getByRole('option', { name: /worktree-0/ });
		expect((option as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.click(option);
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('updates the virtual window without reasserting an offscreen selection on resize', async () => {
		const worktrees = makeWorktrees(500);
		renderList(worktrees);
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });
		const manualScrollTop = 200 * WORKTREE_ROW_HEIGHT;

		viewport.scrollTop = manualScrollTop;
		await fireEvent.scroll(viewport);
		await waitFor(() => {
			expect(screen.getByRole('option', { name: /worktree-200/ })).toBeTruthy();
			expect(screen.queryByRole('option', { name: /worktree-0/ })).toBeNull();
		});
		expect(resizeCallback).toBeTruthy();
		resizeCallback?.(
			[{ contentRect: { height: 100 } } as ResizeObserverEntry],
			{} as ResizeObserver,
		);

		await waitFor(() => {
			expect(viewport.scrollTop).toBe(manualScrollTop);
			expect(screen.getByRole('option', { name: /worktree-200/ })).toBeTruthy();
			expect(screen.queryByRole('option', { name: /worktree-0/ })).toBeNull();
		});
	});

	it('isolates malformed rows, recovers on refresh, and cleans up the resize observer', async () => {
		const worktrees = makeWorktrees(2);
		worktrees[0].lastModifiedAt = Symbol('invalid') as unknown as string;
		const onSelect = vi.fn();
		const view = renderList(worktrees, { onSelect });

		const fallback = screen.getByRole('option', { name: 'Worktree unavailable' });
		expect(fallback.style.height).toBe(`${WORKTREE_ROW_HEIGHT}px`);
		expect(fallback.getAttribute('aria-selected')).toBe('true');
		expect(
			within(screen.getByRole('listbox')).getByRole('option', { name: /worktree-1/ }),
		).toBeTruthy();
		await fireEvent.click(fallback);
		expect(onSelect).toHaveBeenCalledWith('/workspace/worktree-0');

		await view.rerender({ worktrees: makeWorktrees(2) });
		await waitFor(() => {
			expect(screen.queryByRole('option', { name: 'Worktree unavailable' })).toBeNull();
			expect(screen.getByRole('option', { name: /worktree-0/ })).toBeTruthy();
		});

		view.unmount();
		expect(resizeDisconnect).toHaveBeenCalledOnce();
	});
});
