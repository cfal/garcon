import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHistoryCommitListItem } from '$lib/api/git.js';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import {
	EMPTY_GIT_HISTORY_LIST_POSITION,
	type GitHistoryListChange,
	type GitHistoryListPosition,
} from '$lib/git/history/git-history.svelte.js';
import GitCommitListScreen from '../GitCommitListScreen.svelte';
import {
	GIT_HISTORY_ESTIMATED_ROW_HEIGHT,
	retainedGitHistoryFocusRange,
} from '../GitCommitListVirtualController.svelte.js';

function commit(index: number): GitHistoryCommitListItem {
	const hash = index.toString(16).padStart(40, '0');
	return {
		hash,
		shortHash: hash.slice(0, 8),
		parents: index === 0 ? [] : [(index - 1).toString(16).padStart(40, '0')],
		author: `Author ${index}`,
		authorEmail: `author-${index}@example.com`,
		authorDate: '2026-01-01T00:00:00.000Z',
		committer: `Author ${index}`,
		committerEmail: `author-${index}@example.com`,
		committerDate: '2026-01-01T00:00:00.000Z',
		subject: `Commit ${index}`,
		refs: index === 0 ? ['HEAD -> main'] : [],
	};
}

function commits(count: number): GitHistoryCommitListItem[] {
	return Array.from({ length: count }, (_, index) => commit(index));
}

function renderList(
	items: GitHistoryCommitListItem[],
	overrides: Partial<{
		position: GitHistoryListPosition;
		collectionChange: GitHistoryListChange;
		nextOffset: number | null;
	}> = {},
) {
	const onPositionSave = vi.fn<(position: GitHistoryListPosition) => void>();
	const onLoadMore = vi.fn();
	const onOpenCommit = vi.fn();
	const onSelectComparisonCommit = vi.fn();
	const props = {
		commits: items,
		isLoading: false,
		error: null,
		nextOffset: null,
		isMobile: false,
		position: { ...EMPTY_GIT_HISTORY_LIST_POSITION },
		collectionChange: { revision: 1, kind: 'replace' as const },
		onOpenCommit,
		onLoadMore,
		onPositionSave,
		comparisonSelectionActive: false,
		comparisonSelectionSlot: 'from' as const,
		comparisonFrom: null,
		comparisonTo: null,
		onBeginComparison: vi.fn(),
		onCancelComparison: vi.fn(),
		onSelectComparisonCommit,
		onSelectComparisonSlot: vi.fn(),
		onOpenSelectedComparison: vi.fn(),
		...overrides,
	};
	const result = render(GitCommitListScreen, { props });
	return {
		...result,
		props,
		onPositionSave,
		onLoadMore,
		onOpenCommit,
		onSelectComparisonCommit,
	};
}

function viewport(container: HTMLElement): HTMLDivElement {
	const element = container.querySelector<HTMLDivElement>('[data-git-history-commit-list]');
	if (!element) throw new Error('Expected History viewport');
	return element;
}

function spacer(container: HTMLElement): HTMLElement {
	const element = container.querySelector<HTMLElement>('[data-git-history-virtual-spacer]');
	if (!element) throw new Error('Expected History virtual spacer');
	return element;
}

function mockViewportGeometry(container: HTMLElement, height = 720, width = 1_000): HTMLDivElement {
	const element = viewport(container);
	const virtualSpacer = spacer(container);
	Object.defineProperties(element, {
		clientHeight: { configurable: true, value: height },
		scrollHeight: {
			configurable: true,
			get: () => Number.parseFloat(spacer(container).style.height || '0'),
		},
	});
	Object.defineProperty(element, 'getBoundingClientRect', {
		configurable: true,
		value: () => new DOMRect(0, 0, width, height),
	});
	Object.defineProperty(virtualSpacer, 'getBoundingClientRect', {
		configurable: true,
		value: () => new DOMRect(0, -element.scrollTop, width, virtualSpacer.offsetHeight),
	});
	ResizeObserverHarness.emit(element, width, height);
	return element;
}

function virtualRows(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('[data-git-history-virtual-row]')];
}

function rowIndex(row: HTMLElement): number {
	return Number(row.dataset.index);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('GitCommitListVirtualController', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('retains only a focused row outside the visible range', () => {
		const range = { startIndex: 8, endIndex: 22 };

		expect(retainedGitHistoryFocusRange(range, undefined)).toEqual(
			Array.from({ length: 15 }, (_, index) => index + 8),
		);
		expect(retainedGitHistoryFocusRange(range, 80)).toEqual([
			...Array.from({ length: 15 }, (_, index) => index + 8),
			80,
		]);
		expect(retainedGitHistoryFocusRange(range, 12)).toEqual(
			Array.from({ length: 15 }, (_, index) => index + 8),
		);
	});

	it('keeps 20,000 commits in a bounded DOM window with stable absolute positions', async () => {
		const items = commits(20_000);
		const { container, onPositionSave } = renderList(items, { nextOffset: 20_000 });
		const list = mockViewportGeometry(container);

		await waitFor(() => expect(virtualRows(container).length).toBeGreaterThan(0));
		expect(virtualRows(container).length).toBeLessThan(50);
		expect(Number.parseFloat(spacer(container).style.height)).toBe(1_280_000);
		const first = virtualRows(container)[0];
		expect(first?.getAttribute('aria-posinset')).toBe('1');
		expect(first?.getAttribute('aria-setsize')).toBe('-1');
		expect(
			first
				?.querySelector('[data-git-history-commit-hash]')
				?.getAttribute('data-git-history-commit-hash'),
		).toBe(items[0]?.hash);

		list.scrollTop = 640_000;
		await fireEvent.scroll(list);

		await waitFor(() => expect(rowIndex(virtualRows(container)[0]!)).toBeGreaterThan(9_000));
		expect(
			container.querySelector(`[data-git-history-commit-hash="${items[0]?.hash}"]`),
		).toBeNull();
		expect(virtualRows(container).length).toBeLessThan(50);
		await waitFor(() => expect(onPositionSave).toHaveBeenCalled());
		const saved = onPositionSave.mock.lastCall?.[0];
		expect(saved?.scrollTop).toBe(640_000);
		expect(saved?.anchorHash).toBe(items[10_000]?.hash);
		expect(saved?.anchorOffset).toBe(0);

		const activatedRow = virtualRows(container).find((row) => rowIndex(row) === 10_002);
		const activatedButton = activatedRow?.querySelector<HTMLButtonElement>(
			'[data-git-history-commit-row]',
		);
		if (!activatedButton) throw new Error('Expected an activatable virtual History row');
		await fireEvent.click(activatedButton);
		expect(onPositionSave.mock.lastCall?.[0]).toMatchObject({
			anchorHash: items[10_000]?.hash,
			activeHash: items[10_002]?.hash,
		});
	});

	it('remeasures variable rows without overlap and announces a final collection size', async () => {
		const { container } = renderList(commits(3));
		mockViewportGeometry(container);
		await waitFor(() => expect(virtualRows(container)).toHaveLength(3));

		const rows = virtualRows(container);
		ResizeObserverHarness.emit(rows[0]!, 1_000, 48);
		ResizeObserverHarness.emit(rows[1]!, 1_000, 88);
		ResizeObserverHarness.emit(rows[2]!, 1_000, 64);

		await waitFor(() => expect(Number.parseFloat(spacer(container).style.height)).toBe(200));
		expect(rows.map((row) => row.style.transform)).toEqual([
			'translateY(0px)',
			'translateY(48px)',
			'translateY(136px)',
		]);
		expect(rows[2]?.getAttribute('aria-setsize')).toBe('3');
	});

	it('keeps surviving variable-height rows measured across a replacement', async () => {
		const items = commits(3);
		const rendered = renderList(items);
		mockViewportGeometry(rendered.container);
		await waitFor(() => expect(virtualRows(rendered.container)).toHaveLength(3));

		const rows = virtualRows(rendered.container);
		ResizeObserverHarness.emit(rows[0]!, 1_000, 48);
		ResizeObserverHarness.emit(rows[1]!, 1_000, 88);
		ResizeObserverHarness.emit(rows[2]!, 1_000, 64);
		await waitFor(() =>
			expect(rows.map((row) => row.style.transform)).toEqual([
				'translateY(0px)',
				'translateY(48px)',
				'translateY(136px)',
			]),
		);

		await rendered.rerender({
			...rendered.props,
			commits: [...items],
			collectionChange: { revision: 2, kind: 'replace' },
		});
		await nextFrame();

		await waitFor(() =>
			expect(virtualRows(rendered.container).map((row) => row.style.transform)).toEqual([
				'translateY(0px)',
				'translateY(48px)',
				'translateY(136px)',
			]),
		);
	});

	it('restores a deep hash and its partial-row offset', async () => {
		const items = commits(10_000);
		const anchor = items[5_000]!;
		const { container } = renderList(items, {
			position: {
				scrollTop: 320_017,
				anchorHash: anchor.hash,
				anchorOffset: -17,
				activeHash: anchor.hash,
			},
		});
		const list = mockViewportGeometry(container);

		await waitFor(() =>
			expect(
				container.querySelector('[data-git-history-virtual-row][data-index="5000"]'),
			).toBeTruthy(),
		);
		await nextFrame();
		expect(list.scrollTop).toBe(5_000 * GIT_HISTORY_ESTIMATED_ROW_HEIGHT + 17);
		expect(
			container.querySelector<HTMLElement>('[data-git-history-virtual-row][data-index="5000"]')
				?.style.transform,
		).toBe('translateY(320000px)');
	});

	it('keeps a restored anchor exact while variable row measurements settle', async () => {
		const items = commits(10_000);
		const anchor = items[5_000]!;
		const { container } = renderList(items, {
			position: {
				scrollTop: 320_017,
				anchorHash: anchor.hash,
				anchorOffset: -17,
				activeHash: anchor.hash,
			},
		});
		const list = mockViewportGeometry(container);

		await waitFor(() =>
			expect(
				container.querySelector('[data-git-history-virtual-row][data-index="5000"]'),
			).toBeTruthy(),
		);
		for (const row of virtualRows(container)) {
			ResizeObserverHarness.emit(row, 1_000, rowIndex(row) % 2 === 0 ? 48 : 88);
		}

		await waitFor(() => {
			const row = container.querySelector<HTMLElement>(
				'[data-git-history-virtual-row][data-index="5000"]',
			);
			if (!row) throw new Error('Expected restored anchor row');
			const start = Number.parseFloat(row.style.transform.replace(/[^\d.-]/g, ''));
			expect(start - list.scrollTop).toBe(-17);
		});
	});

	it('does not let deferred restoration overwrite new user scroll intent', async () => {
		const items = commits(10_000);
		const anchor = items[5_000]!;
		const { container } = renderList(items, {
			position: {
				scrollTop: 320_017,
				anchorHash: anchor.hash,
				anchorOffset: -17,
				activeHash: anchor.hash,
			},
		});
		const list = mockViewportGeometry(container);
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => {
				list.scrollTop = 1_234;
				list.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
				resolve();
			});
		});

		await nextFrame();
		await nextFrame();
		expect(list.scrollTop).toBe(1_234);
	});

	it('preserves the visible commit on append and resets a missing replacement anchor', async () => {
		const initial = commits(1_000);
		const rendered = renderList(initial);
		const list = mockViewportGeometry(rendered.container);
		await waitFor(() => expect(virtualRows(rendered.container).length).toBeGreaterThan(0));
		list.scrollTop = 100 * GIT_HISTORY_ESTIMATED_ROW_HEIGHT + 17;
		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onPositionSave).toHaveBeenCalled());
		const saved = rendered.onPositionSave.mock.lastCall?.[0];
		if (!saved) throw new Error('Expected a saved History position');

		const appended = [
			...initial,
			...commits(50).map((item, index) => ({
				...item,
				hash: (index + 1_000).toString(16).padStart(40, '0'),
				subject: `Commit ${index + 1_000}`,
			})),
		];
		await rendered.rerender({
			...rendered.props,
			commits: appended,
			position: saved,
			collectionChange: { revision: 2, kind: 'append' },
		});

		expect(list.scrollTop).toBe(6_417);
		await waitFor(() =>
			expect(
				rendered.container.querySelector(`[data-git-history-commit-hash="${initial[100]?.hash}"]`),
			).toBeTruthy(),
		);

		const replacement = appended.slice(200);
		await rendered.rerender({
			...rendered.props,
			commits: replacement,
			position: saved,
			collectionChange: { revision: 3, kind: 'replace' },
		});

		await waitFor(() => expect(list.scrollTop).toBe(0));
		expect(rendered.onPositionSave.mock.lastCall?.[0]).toEqual({
			scrollTop: 0,
			anchorHash: replacement[0]?.hash,
			anchorOffset: 0,
			activeHash: replacement[0]?.hash,
		});
	});

	it('loads at the one-viewport boundary once until new user intent', async () => {
		const rendered = renderList(commits(50), { nextOffset: 50 });
		const list = mockViewportGeometry(rendered.container, 200);
		Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_000 });
		list.scrollTop = 590;

		await fireEvent.scroll(list);
		await nextFrame();
		expect(rendered.onLoadMore).not.toHaveBeenCalled();

		list.scrollTop = 600;

		await fireEvent.scroll(list);
		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onLoadMore).toHaveBeenCalledOnce());

		await fireEvent.scroll(list);
		await nextFrame();
		expect(rendered.onLoadMore).toHaveBeenCalledOnce();

		await rendered.rerender({
			...rendered.props,
			commits: [...rendered.props.commits],
			collectionChange: { revision: 2, kind: 'replace' },
		});
		await nextFrame();
		list.scrollTop = 600;
		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onLoadMore).toHaveBeenCalledTimes(2));

		await fireEvent.scroll(list);
		await nextFrame();
		expect(rendered.onLoadMore).toHaveBeenCalledTimes(2);

		await fireEvent.wheel(list);
		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onLoadMore).toHaveBeenCalledTimes(3));
	});

	it('retries an unchanged boundary after its page request is aborted', async () => {
		const rendered = renderList(commits(50), { nextOffset: 50 });
		const list = mockViewportGeometry(rendered.container, 200);
		Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_000 });
		list.scrollTop = 600;

		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onLoadMore).toHaveBeenCalledOnce());
		await rendered.rerender({ ...rendered.props, isLoading: true });
		await rendered.rerender({ ...rendered.props, isLoading: false });
		await nextFrame();

		await fireEvent.scroll(list);
		await waitFor(() => expect(rendered.onLoadMore).toHaveBeenCalledTimes(2));
	});

	it('moves keyboard focus across unmounted rows and retains the focused endpoint', async () => {
		const items = commits(10_000);
		const { container } = renderList(items);
		const list = mockViewportGeometry(container);
		const first = await screen.findByRole('button', { name: 'Open commit Commit 0' });
		first.focus();
		await fireEvent.focusIn(first);
		await fireEvent.keyDown(first, { key: 'End' });

		const last = await screen.findByRole('button', { name: 'Open commit Commit 9999' });
		await waitFor(() => expect(document.activeElement).toBe(last));
		expect(virtualRows(container).length).toBeLessThan(50);

		list.scrollTop = 0;
		await fireEvent.scroll(list);
		await waitFor(() =>
			expect(
				container.querySelector(`[data-git-history-commit-hash="${items[9_999]?.hash}"]`),
			).toBeTruthy(),
		);
		expect(document.activeElement).toBe(last);
		expect(virtualRows(container).length).toBeLessThan(50);

		await fireEvent.keyDown(last, { key: 'Home' });
		await waitFor(() =>
			expect(document.activeElement?.getAttribute('aria-label')).toBe('Open commit Commit 0'),
		);
	});

	it('moves the tab stop on screen when focus leaves a retained offscreen row', async () => {
		const items = commits(10_000);
		const { container } = renderList(items);
		const list = mockViewportGeometry(container);
		const first = await screen.findByRole('button', { name: 'Open commit Commit 0' });
		first.focus();
		await fireEvent.focusIn(first);
		await fireEvent.keyDown(first, { key: 'End' });

		const last = await screen.findByRole('button', { name: 'Open commit Commit 9999' });
		await waitFor(() => expect(document.activeElement).toBe(last));
		list.scrollTop = 0;
		await fireEvent.scroll(list);
		await waitFor(() =>
			expect(
				container.querySelector(`[data-git-history-commit-hash="${items[9_999]?.hash}"]`),
			).toBeTruthy(),
		);

		const outside = document.createElement('button');
		container.append(outside);
		await fireEvent.focusOut(last, { relatedTarget: outside });
		outside.focus();

		await waitFor(() =>
			expect(
				container.querySelector(`[data-git-history-commit-hash="${items[9_999]?.hash}"]`),
			).toBeNull(),
		);
		await waitFor(() =>
			expect(container.querySelector('[data-git-history-commit-row][tabindex="0"]')).toBeTruthy(),
		);
	});
});
