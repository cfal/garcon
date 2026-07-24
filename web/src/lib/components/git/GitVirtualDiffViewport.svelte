<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';
	import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
	import {
		markGitReviewFirstRow,
		markGitReviewViewportReady,
	} from '$lib/git/review/git-review-performance.js';

	interface GitVirtualDiffViewportProps {
		documentId?: string | null;
		source: GitVirtualReviewRowSource;
		fontSize: number;
		scrollToRequest: { filePath: string; token: number } | null;
		overscan?: number;
		emptyMessage?: string;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		rowSnippet: Snippet<[GitVirtualReviewRow]>;
	}

	let {
		documentId = null,
		source,
		fontSize,
		scrollToRequest,
		overscan = 18,
		emptyMessage = 'No files match the current filters.',
		onVisibleRowsChange,
		rowSnippet,
	}: GitVirtualDiffViewportProps = $props();

	let viewportRef = $state<HTMLDivElement | null>(null);
	let lastVisibleRequestKey = '';
	let lastScrollRequestKey = '';
	let servicedScrollRequestId = '';
	let servicedScrollRequestState: 'pending' | 'resolved' | 'terminal' | null = null;
	let completedScrollRequestId = '';
	let measuredDocumentId: string | null = null;
	let performanceFrame: number | null = null;
	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));

	interface VirtualRowItem {
		index: number;
		key: string | number | bigint;
		start: number;
		size: number;
		end: number;
	}

	function estimateRowHeight(index: number): number {
		return source.estimateRowHeight(index, rowLineHeight);
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: estimateRowHeight,
		measureElement: (element) => element.getBoundingClientRect().height,
		initialRect: { width: 0, height: 720 },
		overscan: 18,
		getItemKey: (index) => source.rowKey(index),
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let renderedVirtualItems = $derived.by<VirtualRowItem[]>(() => {
		if (source.rowCount === 0) return virtualItems;
		const targetIndex = scrollToRequest
			? source.fileStart(scrollToRequest.filePath)
			: undefined;
		if (
			virtualItems.length > 0 &&
			(targetIndex === undefined ||
				virtualItems.some((virtualItem) => virtualItem.index === targetIndex))
		) {
			return virtualItems;
		}
		const itemCount = Math.min(source.rowCount, Math.max(1, overscan * 2));
		const firstIndex =
			targetIndex === undefined ? 0 : Math.max(0, targetIndex - Math.floor(itemCount / 2));
		const lastIndex = Math.min(source.rowCount, firstIndex + itemCount);
		let start = 0;
		for (let index = 0; index < firstIndex; index += 1) {
			start += estimateRowHeight(index);
		}
		const fallbackItems = Array.from({ length: lastIndex - firstIndex }, (_, offset) => {
			const index = firstIndex + offset;
			const size = estimateRowHeight(index);
			const item = {
				index,
				key: source.rowKey(index),
				start,
				size,
				end: start + size,
			};
			start += size;
			return item;
		});
		if (virtualItems.length === 0) return fallbackItems;
		const fallbackIndexes = new Set(fallbackItems.map((item) => item.index));
		return [...virtualItems.filter((item) => !fallbackIndexes.has(item.index)), ...fallbackItems].sort(
			(left, right) => left.index - right.index,
		);
	});
	let totalHeight = $derived($virtualizer.getTotalSize());
	let visibleRows = $derived.by(() =>
		renderedVirtualItems
			.map((virtualItem) => source.rowAt(virtualItem.index))
			.filter((row): row is GitVirtualReviewRow => Boolean(row)),
	);

	$effect(() => {
		const nextDocumentId = documentId;
		const scrollElement = viewportRef;
		if (!scrollElement || nextDocumentId === measuredDocumentId) return;
		measuredDocumentId = nextDocumentId;
		lastVisibleRequestKey = '';
		lastScrollRequestKey = '';
		servicedScrollRequestId = '';
		servicedScrollRequestState = null;
		completedScrollRequestId = '';
		untrack(() => {
			scrollElement.scrollTop = 0;
			$virtualizer.measure();
		});
	});

	$effect(() => {
		const activeSource = source;
		const count = source.rowCount;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		const lineHeight = rowLineHeight;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: (index) => {
					return activeSource.estimateRowHeight(index, lineHeight);
				},
				measureElement: (element) => element.getBoundingClientRect().height,
				initialRect: { width: 0, height: 720 },
				overscan: rowOverscan,
				getItemKey: (index) => activeSource.rowKey(index),
			});
			$virtualizer.measure();
		});
	});

	$effect(() => {
		const key = visibleRows.map((row) => row.id).join('\0');
		if (key === lastVisibleRequestKey) return;
		lastVisibleRequestKey = key;
		const rowsForLoad = visibleRows;
		untrack(() => onVisibleRowsChange(rowsForLoad));
	});

	$effect(() => {
		const activeDocumentId = documentId;
		if (!activeDocumentId || visibleRows.length === 0) return;
		const hasPendingFile = visibleRows.some(
			(row) => row.filePath && source.fileState(row.filePath) === 'pending',
		);
		const hasRealDiffRow = visibleRows.some(
			(row) => row.kind === 'unified-row' || row.kind === 'split-row',
		);
		if (hasPendingFile || (!hasRealDiffRow && source.rowCount === 0)) return;
		const readyDocumentId = activeDocumentId;
		untrack(() => {
			if (performanceFrame !== null) cancelAnimationFrame(performanceFrame);
			performanceFrame = requestAnimationFrame(() => {
				performanceFrame = null;
				if (documentId !== readyDocumentId) return;
				if (hasRealDiffRow) markGitReviewFirstRow(readyDocumentId);
				markGitReviewViewportReady(readyDocumentId);
			});
		});
		return () => {
			if (performanceFrame !== null) {
				cancelAnimationFrame(performanceFrame);
				performanceFrame = null;
			}
		};
	});

	$effect(() => {
		if (!scrollToRequest) return;
		const requestId = `${scrollToRequest.token}\0${scrollToRequest.filePath}`;
		if (requestId === completedScrollRequestId) return;
		const targetIndex = source.fileStart(scrollToRequest.filePath);
		if (targetIndex === undefined) return;
		const targetState = source.fileState(scrollToRequest.filePath);
		if (
			targetState === 'terminal' &&
			servicedScrollRequestId === requestId &&
			servicedScrollRequestState === 'pending'
		) {
			completedScrollRequestId = requestId;
			return;
		}
		const requestKey = `${requestId}\0${targetIndex}\0${targetState}`;
		if (requestKey === lastScrollRequestKey) return;
		lastScrollRequestKey = requestKey;
		const start = Math.max(0, targetIndex - 6);
		const end = Math.min(source.rowCount, targetIndex + 36);
		const priorityRows = source.rowsInRange(start, end);
		untrack(() => {
			onVisibleRowsChange(priorityRows);
			void tick().then(() => {
				if (lastScrollRequestKey !== requestKey) return;
				const scrollElement = viewportRef;
				if (!scrollElement) return;
				$virtualizer.scrollToIndex(targetIndex, { align: 'start' });
				scrollElement.dispatchEvent(new Event('scroll'));
				servicedScrollRequestId = requestId;
				servicedScrollRequestState = targetState;
				if (targetState !== 'pending') completedScrollRequestId = requestId;
			});
		});
	});

	function measureRow(element: HTMLDivElement): { destroy: () => void } {
		$virtualizer.measureElement(element);
		return {
			destroy() {
				$virtualizer.measureElement(null);
			},
		};
	}
</script>

<div
	bind:this={viewportRef}
	class="min-h-0 flex-1 overflow-auto bg-muted/15"
	data-git-virtual-diff-root
>
	{#if source.rowCount === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			{emptyMessage}
		</div>
	{:else}
		<div class="relative w-full" style:height={`${totalHeight}px`}>
			{#each renderedVirtualItems as virtualItem (virtualItem.key)}
				{@const row = source.rowAt(virtualItem.index)}
				{#if row}
					<div
						data-index={virtualItem.index}
						data-git-virtual-row
						use:measureRow
						class="absolute left-0 top-0 w-full"
						style:transform={`translateY(${virtualItem.start}px)`}
					>
						<svelte:boundary>
							{@render rowSnippet(row)}
							{#snippet failed(error)}
								<div
									class="border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground"
								>
									Failed to render diff row: {error instanceof Error
										? error.message
										: String(error)}
								</div>
							{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
