import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitWorktreeItem } from '$lib/api/git.js';
import GitWorktreePickerList from '../GitWorktreePickerList.svelte';
import {
	WORKTREE_ROW_HEIGHT_NARROW,
	WORKTREE_ROW_HEIGHT_WIDE,
	worktreeOptionId,
} from '../git-worktree-picker-list.js';

const LISTBOX_ID = 'worktree-list';
const NARROW_WORKTREE_QUERY = '(max-width: 639px)';

interface MediaQueryHarness {
	mediaQuery: TestMediaQueryList;
	setMatches: (matches: boolean) => void;
}

class TestMediaQueryList extends EventTarget implements MediaQueryList {
	matches: boolean;
	readonly media = NARROW_WORKTREE_QUERY;
	onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
	readonly #legacyListeners = new Set<
		(this: MediaQueryList, event: MediaQueryListEvent) => unknown
	>();

	constructor(matches: boolean) {
		super();
		this.matches = matches;
	}

	addListener(
		callback: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null,
	): void {
		if (callback) this.#legacyListeners.add(callback);
	}

	removeListener(
		callback: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null,
	): void {
		if (callback) this.#legacyListeners.delete(callback);
	}

	setMatches(matches: boolean): void {
		this.matches = matches;
		const event: MediaQueryListEvent = Object.assign(new Event('change'), {
			matches,
			media: this.media,
		});
		this.dispatchEvent(event);
		this.onchange?.call(this, event);
		for (const listener of this.#legacyListeners) listener.call(this, event);
	}
}

let originalMatchMedia: typeof window.matchMedia | undefined;
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

function installMatchMedia(initialMatches = false): MediaQueryHarness {
	const mediaQuery = new TestMediaQueryList(initialMatches);

	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: vi.fn(() => mediaQuery),
	});

	return {
		mediaQuery,
		setMatches(nextMatches: boolean) {
			mediaQuery.setMatches(nextMatches);
		},
	};
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

beforeEach(() => {
	originalMatchMedia = window.matchMedia;
	installMatchMedia(false);
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
	if (originalMatchMedia) {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			writable: true,
			value: originalMatchMedia,
		});
	} else {
		Reflect.deleteProperty(window, 'matchMedia');
	}
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
		expect(spacer?.style.height).toBe(`${5_000 * WORKTREE_ROW_HEIGHT_WIDE}px`);
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
		const rootStyle = { fontSize: '20px' } satisfies Pick<CSSStyleDeclaration, 'fontSize'>;
		vi.spyOn(window, 'getComputedStyle').mockReturnValueOnce(rootStyle as CSSStyleDeclaration);
		const worktrees = makeWorktrees(81);
		renderList(worktrees);

		const scaledRowHeight = WORKTREE_ROW_HEIGHT_WIDE * 1.25;
		expect(document.querySelector<HTMLElement>('[data-worktree-virtual-list]')?.style.height).toBe(
			`${worktrees.length * scaledRowHeight}px`,
		);
		expect(screen.getByRole('option', { name: /worktree-0/ }).style.height).toBe(
			`${scaledRowHeight}px`,
		);
	});

	it('mounts a deep window and clears a stale active descendant after manual scrolling', async () => {
		const worktrees = makeWorktrees(5_000);
		const onActiveOptionIdChange = vi.fn();
		const view = renderList(worktrees, { onActiveOptionIdChange });
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		viewport.scrollTop = 2_500 * WORKTREE_ROW_HEIGHT_WIDE;
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

		viewport.scrollTop = 2_500 * WORKTREE_ROW_HEIGHT_WIDE;
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

	it('preserves the logical scroll anchor across responsive row-height changes', async () => {
		const media = installMatchMedia(false);
		const worktrees = makeWorktrees(500);
		renderList(worktrees, {
			selectedIndex: 201,
			selectedPath: worktrees[201].path,
		});
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });
		const spacer = document.querySelector<HTMLElement>('[data-worktree-virtual-list]');

		await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(11_000));
		viewport.scrollTop = 200.5 * WORKTREE_ROW_HEIGHT_WIDE;
		await fireEvent.scroll(viewport);
		media.setMatches(true);

		await waitFor(() => {
			expect(spacer?.style.height).toBe(`${500 * WORKTREE_ROW_HEIGHT_NARROW}px`);
			expect(viewport.scrollTop).toBe(200.5 * WORKTREE_ROW_HEIGHT_NARROW);
			expect(screen.getByRole('option', { name: /worktree-201/ })).toBeTruthy();
		});
	});

	it('coalesces rapid breakpoint reversals around the original logical anchor', async () => {
		const media = installMatchMedia(false);
		const worktrees = makeWorktrees(100).map((worktree) => ({
			...worktree,
			isPathMissing: true,
		}));
		renderList(worktrees, {
			selectedIndex: -1,
			selectedPath: undefined,
		});
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });
		const spacer = document.querySelector<HTMLElement>('[data-worktree-virtual-list]');
		const originalScrollTop = 50.5 * WORKTREE_ROW_HEIGHT_WIDE;
		viewport.scrollTop = originalScrollTop;
		await fireEvent.scroll(viewport);
		await waitFor(() => {
			expect(screen.getByRole('option', { name: /worktree-50/ })).toBeTruthy();
		});

		let frameId = 0;
		const frames = new Map<number, FrameRequestCallback>();
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			frameId += 1;
			frames.set(frameId, callback);
			return frameId;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
			frames.delete(id);
		});

		media.setMatches(true);
		await waitFor(() => {
			expect(spacer?.style.height).toBe(`${100 * WORKTREE_ROW_HEIGHT_NARROW}px`);
		});
		media.setMatches(false);
		await waitFor(() => {
			expect(spacer?.style.height).toBe(`${100 * WORKTREE_ROW_HEIGHT_WIDE}px`);
		});

		for (const [id, callback] of [...frames]) {
			frames.delete(id);
			callback(performance.now());
		}

		expect(viewport.scrollTop).toBe(originalScrollTop);
		expect(screen.getByRole('option', { name: /worktree-50/ })).toBeTruthy();
	});

	it('keeps the selected row visible when the observed viewport shrinks', async () => {
		const worktrees = makeWorktrees(500);
		renderList(worktrees, {
			selectedIndex: 100,
			selectedPath: worktrees[100].path,
		});
		const viewport = screen.getByRole('listbox', { name: 'Select worktree' });

		await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(5_000));
		expect(resizeCallback).toBeTruthy();
		resizeCallback?.(
			[{ contentRect: { height: 100 } } as ResizeObserverEntry],
			{} as ResizeObserver,
		);

		await waitFor(() => {
			const option = screen.getByRole('option', { name: /worktree-100/ });
			const optionTop = 100 * WORKTREE_ROW_HEIGHT_WIDE;
			expect(viewport.scrollTop).toBeLessThanOrEqual(optionTop);
			expect(viewport.scrollTop + 100).toBeGreaterThanOrEqual(optionTop + WORKTREE_ROW_HEIGHT_WIDE);
			expect(option).toBeTruthy();
		});
	});

	it('isolates malformed rows, recovers on refresh, and cleans up browser observers', async () => {
		const worktrees = makeWorktrees(2);
		worktrees[0].lastModifiedAt = Symbol('invalid') as unknown as string;
		const media = installMatchMedia(false);
		const removeMediaListener = vi.spyOn(media.mediaQuery, 'removeEventListener');
		const onSelect = vi.fn();
		const view = renderList(worktrees, { onSelect });

		const fallback = screen.getByRole('option', { name: 'Worktree unavailable' });
		expect(fallback.style.height).toBe(`${WORKTREE_ROW_HEIGHT_WIDE}px`);
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

		const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(47);
		const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
		media.setMatches(true);
		view.unmount();
		expect(requestFrame).toHaveBeenCalled();
		expect(cancelFrame).toHaveBeenCalledWith(47);
		expect(resizeDisconnect).toHaveBeenCalledOnce();
		expect(removeMediaListener).toHaveBeenCalledWith('change', expect.any(Function));
	});
});
