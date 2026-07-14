<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitVirtualReviewRow } from '$lib/stores/git/git-workbench.svelte.js';

	interface GitVirtualDiffViewportProps {
		rows: GitVirtualReviewRow[];
		fileRowIndex: Map<string, number>;
		fontSize: number;
		scrollToRequest: { filePath: string; token: number } | null;
		overscan?: number;
		emptyMessage?: string;
		onVisibleRowsChange: (rows: GitVirtualReviewRow[]) => void;
		rowSnippet: Snippet<[GitVirtualReviewRow]>;
	}

	let {
		rows,
		fileRowIndex,
		fontSize,
		scrollToRequest,
		overscan = 18,
		emptyMessage = 'No files match the current filters.',
		onVisibleRowsChange,
		rowSnippet,
	}: GitVirtualDiffViewportProps = $props();

	let viewportRef = $state<HTMLDivElement | null>(null);
	let lastVisibleRequestKey = '';
	let lastScrollToken = 0;
	let rowLineHeight = $derived(Math.max(18, Math.round(fontSize * 1.5)));

	interface VirtualRowItem {
		index: number;
		key: string | number | bigint;
		start: number;
		size: number;
		end: number;
	}

	function estimateRowHeight(index: number): number {
		const row = rows[index];
		if (!row) return rowLineHeight;
		if (row.kind === 'unified-row' || row.kind === 'split-row') {
			return Math.max(row.estimatedHeight, rowLineHeight);
		}
		return row.estimatedHeight;
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: estimateRowHeight,
		measureElement: (element) => element.getBoundingClientRect().height,
		initialRect: { width: 0, height: 720 },
		overscan: 18,
		getItemKey: (index) => rows[index]?.id ?? index,
	});

	let virtualItems = $derived($virtualizer.getVirtualItems());
	let renderedVirtualItems = $derived.by<VirtualRowItem[]>(() => {
		if (virtualItems.length > 0 || rows.length === 0) return virtualItems;
		const itemCount = Math.min(rows.length, Math.max(1, overscan * 2));
		let start = 0;
		return Array.from({ length: itemCount }, (_, index) => {
			const size = estimateRowHeight(index);
			const item = {
				index,
				key: rows[index]?.id ?? index,
				start,
				size,
				end: start + size,
			};
			start += size;
			return item;
		});
	});
	let totalHeight = $derived($virtualizer.getTotalSize());
	let visibleRows = $derived.by(() =>
		renderedVirtualItems
			.map((virtualItem) => rows[virtualItem.index])
			.filter((row): row is GitVirtualReviewRow => Boolean(row)),
	);

	$effect(() => {
		const count = rows.length;
		const scrollElement = viewportRef;
		const rowOverscan = overscan;
		const lineHeight = rowLineHeight;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: (index) => {
					const row = rows[index];
					if (!row) return lineHeight;
					if (row.kind === 'unified-row' || row.kind === 'split-row') {
						return Math.max(row.estimatedHeight, lineHeight);
					}
					return row.estimatedHeight;
				},
				measureElement: (element) => element.getBoundingClientRect().height,
				initialRect: { width: 0, height: 720 },
				overscan: rowOverscan,
				getItemKey: (index) => rows[index]?.id ?? index,
			});
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
		if (!scrollToRequest || scrollToRequest.token === lastScrollToken) return;
		const targetIndex = fileRowIndex.get(scrollToRequest.filePath);
		if (targetIndex === undefined) return;
		lastScrollToken = scrollToRequest.token;
		const start = Math.max(0, targetIndex - 6);
		const end = Math.min(rows.length, targetIndex + 36);
		const priorityRows = rows.slice(start, end);
		untrack(() => {
			onVisibleRowsChange(priorityRows);
			$virtualizer.scrollToIndex(targetIndex, { align: 'start' });
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
	{#if rows.length === 0}
		<div class="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
			{emptyMessage}
		</div>
	{:else}
		<div class="relative w-full" style:height={`${totalHeight}px`}>
			{#each renderedVirtualItems as virtualItem (virtualItem.key)}
				{@const row = rows[virtualItem.index]}
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
								<div class="border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground">
									Failed to render diff row: {error instanceof Error ? error.message : String(error)}
								</div>
							{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
