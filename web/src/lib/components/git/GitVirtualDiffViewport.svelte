<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import type { GitVirtualReviewRow } from '$lib/git/review/git-virtual-review-document.svelte.js';

	interface GitVirtualDiffViewportProps {
		documentId?: string | null;
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
		documentId = null,
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
	let lastScrollRequestKey = '';
	let servicedScrollRequestId = '';
	let servicedScrollRequestState: 'pending' | 'resolved' | 'terminal' | null = null;
	let completedScrollRequestId = '';
	let measuredDocumentId: string | null = null;
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
		if (!scrollToRequest) return;
		const requestId = `${scrollToRequest.token}\0${scrollToRequest.filePath}`;
		if (requestId === completedScrollRequestId) return;
		const targetIndex = fileRowIndex.get(scrollToRequest.filePath);
		if (targetIndex === undefined) return;
		let targetState: 'pending' | 'resolved' | 'terminal' = 'terminal';
		for (const row of rows) {
			if (row.filePath !== scrollToRequest.filePath) continue;
			if (row.kind === 'file-placeholder') targetState = 'pending';
			if (row.kind === 'unified-row' || row.kind === 'split-row') targetState = 'resolved';
		}
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
		const end = Math.min(rows.length, targetIndex + 36);
		const priorityRows = rows.slice(start, end);
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
