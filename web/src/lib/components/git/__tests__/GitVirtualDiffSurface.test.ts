import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick, type ComponentProps } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { GitVirtualFileHeaderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { GitVirtualFilePlaceholderRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import { installGitVirtualDiffTestLayout } from './git-virtual-diff-test-layout.js';
import GitVirtualDiffSurface from '../GitVirtualDiffSurface.svelte';

type GitVirtualDiffSurfaceProps = ComponentProps<typeof GitVirtualDiffSurface>;

function makeHeaderRow(
	index: number,
	overrides: Partial<GitVirtualFileHeaderRow['file']> = {},
): GitVirtualFileHeaderRow {
	const path = `file-${index}.ts`;
	return {
		kind: 'file-header',
		id: `file:${index}:header`,
		filePath: path,
		estimatedHeight: 42,
		isFocused: false,
		file: {
			path,
			indexStatus: ' ',
			workTreeStatus: 'M',
			category: 'normal',
			additions: 1,
			deletions: 0,
			estimatedRows: 2,
			bodyState: 'unloaded',
			bodyFingerprint: `fingerprint:${path}`,
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
			...overrides,
		},
	};
}

function makeBodyRow(header: GitVirtualFileHeaderRow, index: number): GitVirtualFilePlaceholderRow {
	return {
		kind: 'file-placeholder',
		id: `${header.id}:body:${index}`,
		filePath: header.filePath,
		estimatedHeight: 42,
		file: header.file,
		loadState: 'loading',
	};
}

function makeFileRows(
	index: number,
	bodyRowCount = 20,
	overrides: Partial<GitVirtualFileHeaderRow['file']> = {},
): GitVirtualReviewRow[] {
	const header = makeHeaderRow(index, overrides);
	return [header, ...Array.from({ length: bodyRowCount }, (_, row) => makeBodyRow(header, row))];
}

function renderSurface(
	rows: GitVirtualReviewRow[],
	overrides: Partial<GitVirtualDiffSurfaceProps> = {},
) {
	const props = {
		layoutIdentity: 'layout',
		reviewDocumentId: 'doc',
		source: arrayGitVirtualReviewRowSource(rows),
		activeTab: 'unstaged' as const,
		fontSize: 12,
		selectedLineKeys: new Set<string>(),
		operationPending: false,
		scrollToRequest: null,
		composerState: {
			open: false,
			focusPending: false,
			filePath: '',
			side: 'after' as const,
			line: 0,
			body: '',
			severity: 'note' as const,
		},
		showInlineCommentComposer: true,
		onBodyDemand: vi.fn(),
		onSelectFile: vi.fn(),
		onToggleLineSelection: vi.fn(),
		onSelectLineRange: vi.fn(),
		onStageHunk: vi.fn(),
		onUnstageHunk: vi.fn(),
		onStageLine: vi.fn(),
		onUnstageLine: vi.fn(),
		onStageFile: vi.fn(),
		onUnstageFile: vi.fn(),
		onAddCommentForFile: vi.fn(),
		commentFeedback: null,
		commentError: null,
		commentCopyText: null,
		onOpenChat: vi.fn(),
		...overrides,
	};
	return {
		...render(GitVirtualDiffSurface, {
			props,
		}),
		props,
	};
}

function firstMountedIndex(container: HTMLElement): number {
	const first = container.querySelector<HTMLElement>('[data-git-virtual-row]');
	return first ? Number(first.dataset.index) : -1;
}

function lastViewportDemand(callback: ReturnType<typeof vi.fn>) {
	return callback.mock.calls
		.map(([demand]) => demand)
		.filter((demand) => demand.kind === 'viewport')
		.at(-1);
}

describe('GitVirtualDiffSurface', () => {
	beforeEach(() => {
		installGitVirtualDiffTestLayout({
			viewportHeight: 720,
			rowHeight: (element) =>
				element.dataset.index === '0' || element.dataset.index === '101' ? 64 : 42,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders one bounded contiguous row window for large documents', async () => {
		const rows = Array.from({ length: 10_000 }, (_, index) => makeHeaderRow(index));
		const { container } = renderSurface(rows);

		const root = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]');
		expect(root).toBeTruthy();
		expect(root?.dataset.workspaceScrollRegion).toBe('primary');
		expect(container.querySelector('[data-git-all-files-scroll-root]')).toBeNull();

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
		});

		const rowWindows = container.querySelectorAll<HTMLElement>('[data-git-virtual-row-window]');
		expect(rowWindows).toHaveLength(1);
		const rowWindow = rowWindows.item(0);
		expect(rowWindow).toBeTruthy();
		if (!rowWindow) return;

		const mountedRows = Array.from(rowWindow.children).filter((element): element is HTMLElement =>
			element.hasAttribute('data-git-virtual-row'),
		);
		expect(mountedRows).toHaveLength(rowWindow.children.length);
		expect(mountedRows.length).toBeLessThan(300);

		const indexes = mountedRows.map((element) => Number(element.dataset.index));
		const firstIndex = indexes[0];
		expect(firstIndex).toBeDefined();
		if (firstIndex === undefined) return;
		expect(indexes).toEqual(
			Array.from({ length: indexes.length }, (_, offset) => firstIndex + offset),
		);

		for (const element of mountedRows) {
			expect(element.className).toBe('');
			expect(element.style.transform).toBe('');
			expect(element.style.top).toBe('');
			expect(element.parentElement).toBe(rowWindow);
		}
		expect(rowWindow.className).toBe('absolute inset-x-0');
		expect(rowWindow.className).not.toMatch(/(?:^|\s)-?(?:translate|transform)(?:-|\s|$)/);
		expect(rowWindow.style.transform).toBe('');
	});

	it('reconciles a refreshed document against the virtualizer item snapshot', async () => {
		const initialRows = [makeHeaderRow(0), makeHeaderRow(1), makeHeaderRow(2)];
		const replacementRows = [makeHeaderRow(2)];
		const { container, props, rerender } = renderSurface(initialRows);

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]')).toHaveLength(3);
		});

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(replacementRows),
		});

		await waitFor(() => {
			expect(container.querySelectorAll('[data-git-virtual-row]')).toHaveLength(1);
		});
		expect(screen.getByText('file-2.ts')).toBeTruthy();
	});

	it('advances the real virtual range and body demand when the browser scrolls', async () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => makeHeaderRow(index));
		const onBodyDemand = vi.fn();
		const { container } = renderSurface(rows, { onBodyDemand });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;

		await waitFor(() => expect(lastViewportDemand(onBodyDemand)).toBeTruthy());
		const initialDemand = lastViewportDemand(onBodyDemand);
		onBodyDemand.mockClear();
		viewport.scrollTop = 8_400;
		await fireEvent.scroll(viewport);

		await waitFor(() => expect(firstMountedIndex(container)).toBeGreaterThan(100));
		await waitFor(() => expect(lastViewportDemand(onBodyDemand)).toBeTruthy());
		const scrolledDemand = lastViewportDemand(onBodyDemand);
		expect(scrolledDemand.filePaths).not.toEqual(initialDemand.filePaths);
		expect(scrolledDemand.filePaths.some((path: string) => path === 'file-200.ts')).toBe(true);
	});

	it('republishes retained demand without losing virtualizer geometry on activation', async () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => makeHeaderRow(index));
		const onBodyDemand = vi.fn();
		const { container, props, rerender } = renderSurface(rows, { onBodyDemand, active: true });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 4_200;
		await fireEvent.scroll(viewport);
		await waitFor(() => expect(firstMountedIndex(container)).toBeGreaterThan(40));
		const measuredRow = container.querySelector<HTMLElement>('[data-index="101"]');
		expect(measuredRow).toBeTruthy();
		expect(measuredRow?.getBoundingClientRect().height).toBe(64);
		const firstIndex = firstMountedIndex(container);
		const spacer = container.querySelector<HTMLElement>(
			'[data-git-virtual-row-window]',
		)?.parentElement;
		const spacerHeight = spacer?.style.height;
		expect(Number.parseFloat(spacerHeight ?? '')).toBeGreaterThan(rows.length * 42);
		const demand = lastViewportDemand(onBodyDemand);

		await rerender({ ...props, active: false });
		onBodyDemand.mockClear();
		await rerender({ ...props, active: true });

		await waitFor(() => expect(lastViewportDemand(onBodyDemand)).toEqual(demand));
		expect(viewport.scrollTop).toBe(4_200);
		expect(firstMountedIndex(container)).toBe(firstIndex);
		expect(spacer?.style.height).toBe(spacerHeight);
	});

	it('republishes for a new server document without resetting the stable layout', async () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => makeHeaderRow(index));
		const onBodyDemand = vi.fn();
		const { container, props, rerender } = renderSurface(rows, { onBodyDemand });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 4_200;
		await fireEvent.scroll(viewport);
		await waitFor(() => expect(firstMountedIndex(container)).toBeGreaterThan(40));
		const firstIndex = firstMountedIndex(container);
		onBodyDemand.mockClear();

		await rerender({ ...props, reviewDocumentId: 'doc-b' });

		await waitFor(() =>
			expect(lastViewportDemand(onBodyDemand)).toMatchObject({ documentId: 'doc-b' }),
		);
		expect(viewport.scrollTop).toBe(4_200);
		expect(firstMountedIndex(container)).toBe(firstIndex);
	});

	it('republishes when presentation-only source state rebuilds the same visible paths', async () => {
		const rows = Array.from({ length: 20 }, (_, index) => makeHeaderRow(index));
		const onBodyDemand = vi.fn();
		const { props, rerender } = renderSurface(rows, { onBodyDemand });
		await waitFor(() => expect(lastViewportDemand(onBodyDemand)).toBeTruthy());
		const initialDemand = lastViewportDemand(onBodyDemand);
		onBodyDemand.mockClear();

		await rerender({
			...props,
			source: arrayGitVirtualReviewRowSource(
				rows.map((row, index) => ({ ...row, isFocused: index === 0 })),
			),
		});

		await waitFor(() => expect(lastViewportDemand(onBodyDemand)).toEqual(initialDemand));
	});

	it('pins the current Workbench header only after the measured header leaves the viewport', async () => {
		const rows = [...makeFileRows(0), ...makeFileRows(1)];
		const onStageFile = vi.fn();
		const { container } = renderSurface(rows, { onStageFile });
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		await tick();

		expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull();
		viewport.scrollTop = 63;
		await fireEvent.scroll(viewport);
		expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull();

		viewport.scrollTop = 64;
		await fireEvent.scroll(viewport);
		const pinned = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-git-pinned-file-header]');
			expect(element?.dataset.filePath).toBe('file-0.ts');
			return element!;
		});
		const original = container.querySelector<HTMLElement>(
			'[data-git-virtual-row-id="file:0:header"]',
		)!;

		expect(original.getAttribute('aria-hidden')).toBe('true');
		expect(original.hasAttribute('inert')).toBe(true);
		expect(screen.getAllByRole('button', { name: 'file-0.ts' })).toHaveLength(1);
		await fireEvent.click(within(pinned).getByRole('button', { name: 'Stage file' }));
		expect(onStageFile).toHaveBeenCalledOnce();
		expect(onStageFile).toHaveBeenCalledWith('file-0.ts');

		const host = pinned.parentElement!;
		const rowWindow = container.querySelector<HTMLElement>('[data-git-virtual-row-window]')!;
		expect(host.hasAttribute('data-git-pinned-file-header-host')).toBe(true);
		expect(host.classList.contains('z-20')).toBe(true);
		expect(host.parentElement).toBe(rowWindow.parentElement);
		expect(rowWindow.contains(host)).toBe(false);
		const indexes = Array.from(rowWindow.children, (element) =>
			Number((element as HTMLElement).dataset.index),
		);
		expect(indexes).toEqual(
			Array.from({ length: indexes.length }, (_, offset) => (indexes[0] ?? 0) + offset),
		);

		viewport.scrollTop = 63;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull(),
		);
	});

	it('changes the pinned header at file boundaries without following the file tree', async () => {
		const { container, props } = renderSurface([...makeFileRows(0), ...makeFileRows(1)]);
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;

		viewport.scrollTop = 64;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-0.ts'),
		);

		viewport.scrollTop = 904;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull(),
		);
		expect(props.onSelectFile).not.toHaveBeenCalled();

		viewport.scrollTop = 946;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-pinned-file-header]')?.dataset.filePath,
			).toBe('file-1.ts'),
		);
		expect(props.onSelectFile).not.toHaveBeenCalled();
	});

	it('preserves a focused original header until focus moves to the pinned copy', async () => {
		const { container } = renderSurface(makeFileRows(0, 40));
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		const original = await waitFor(() => {
			const element = container.querySelector<HTMLElement>(
				'[data-git-virtual-row-id="file:0:header"]',
			);
			expect(element).toBeTruthy();
			return element!;
		});
		const originalAction = within(original).getByRole('button', { name: 'Stage file' });
		originalAction.focus();
		expect(document.activeElement).toBe(originalAction);

		viewport.scrollTop = 64;
		await fireEvent.scroll(viewport);
		const pinned = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-git-pinned-file-header]');
			expect(element).toBeTruthy();
			return element!;
		});

		expect(document.activeElement).toBe(originalAction);
		expect(original.hasAttribute('inert')).toBe(false);
		expect(original.getAttribute('aria-hidden')).not.toBe('true');

		const pinnedAction = within(pinned).getByRole('button', { name: 'Stage file' });
		pinnedAction.focus();
		await waitFor(() => expect(original.hasAttribute('inert')).toBe(true));
		expect(original.getAttribute('aria-hidden')).toBe('true');
		expect(document.activeElement).toBe(pinnedAction);
	});

	it('stages the current file from the virtual file header in the unstaged tab', async () => {
		const onStageFile = vi.fn();
		renderSurface([makeHeaderRow(0)], { onStageFile });

		await fireEvent.click(await screen.findByRole('button', { name: 'Stage file' }));

		expect(onStageFile).toHaveBeenCalledWith('file-0.ts');
	});

	it('unstages the current file from the pinned file header in the staged tab', async () => {
		const onUnstageFile = vi.fn();
		const { container } = renderSurface(
			makeFileRows(0, 40, { indexStatus: 'M', workTreeStatus: ' ' }),
			{
				activeTab: 'staged',
				onUnstageFile,
			},
		);
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 64;
		await fireEvent.scroll(viewport);
		const pinned = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-git-pinned-file-header]');
			expect(element).toBeTruthy();
			return element!;
		});

		await fireEvent.click(within(pinned).getByRole('button', { name: 'Unstage file' }));

		expect(onUnstageFile).toHaveBeenCalledWith('file-0.ts');
	});
});
