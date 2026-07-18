<script lang="ts">
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import * as m from '$lib/paraglide/messages.js';
	import {
		FILE_TREE_COLUMN_MIN_WIDTHS,
		resizeVisibleFileTreeColumnBoundary,
		type FileTreeColumnKey,
		type FileTreeColumnWidths,
		type FileTreeStore,
	} from '$lib/files/tree/file-tree.svelte.js';
	import FileTreeColumnResizeHandle from './FileTreeColumnResizeHandle.svelte';

	let { store, ariaRowIndex }: { store: FileTreeStore; ariaRowIndex: number } = $props();
	let resizeStartWidths: FileTreeColumnWidths | null = null;
	const visibleColumns = $derived(store.visibleColumnKeys);
	const visibleWeight = $derived(
		visibleColumns.reduce((sum, column) => sum + store.columnWidths[column], 0),
	);

	const labels: Record<FileTreeColumnKey, () => string> = {
		name: m.filetree_name,
		size: m.filetree_size,
		modified: m.filetree_modified,
		permissions: m.filetree_permissions,
	};

	function boundaryValue(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = visibleColumns.indexOf(leftColumn);
		const weight = visibleColumns
			.slice(0, boundaryIndex + 1)
			.reduce((sum, key) => sum + store.columnWidths[key], 0);
		return (weight / visibleWeight) * 100;
	}

	function boundaryMinimum(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = visibleColumns.indexOf(leftColumn);
		const priorWeight = visibleColumns
			.slice(0, boundaryIndex)
			.reduce((sum, key) => sum + store.columnWidths[key], 0);
		return ((priorWeight + FILE_TREE_COLUMN_MIN_WIDTHS[leftColumn]) / visibleWeight) * 100;
	}

	function boundaryMaximum(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = visibleColumns.indexOf(leftColumn);
		const rightColumn = visibleColumns[boundaryIndex + 1];
		if (!rightColumn) return boundaryValue(leftColumn);
		return (
			boundaryValue(leftColumn) +
			((store.columnWidths[rightColumn] - FILE_TREE_COLUMN_MIN_WIDTHS[rightColumn]) /
				visibleWeight) *
				100
		);
	}

	function beginResize(): void {
		resizeStartWidths = { ...store.columnWidths };
	}

	function previewResize(leftColumn: FileTreeColumnKey, deltaPercentagePoints: number): void {
		if (!resizeStartWidths) return;
		store.previewColumnWidths(
			resizeVisibleFileTreeColumnBoundary(
				resizeStartWidths,
				visibleColumns,
				leftColumn,
				deltaPercentagePoints,
			),
		);
	}

	function commitResize(): void {
		if (!resizeStartWidths) return;
		store.commitColumnWidths();
		resizeStartWidths = null;
	}

	function cancelResize(): void {
		if (!resizeStartWidths) return;
		store.previewColumnWidths(resizeStartWidths);
		resizeStartWidths = null;
	}

	function resizeByKeyboard(leftColumn: FileTreeColumnKey, deltaPercentagePoints: number): void {
		store.setColumnWidths(
			resizeVisibleFileTreeColumnBoundary(
				store.columnWidths,
				visibleColumns,
				leftColumn,
				deltaPercentagePoints,
			),
		);
	}

	function sortLabel(column: FileTreeColumnKey): string {
		switch (column) {
			case 'size':
				return m.filetree_sort_by_size();
			case 'modified':
				return m.filetree_sort_by_modified();
			case 'permissions':
				return m.filetree_sort_by_permissions();
			case 'name':
			default:
				return m.filetree_sort_by_name();
		}
	}
</script>

{#snippet sortIcon(column: FileTreeColumnKey)}
	{#if store.sortKey === column}
		{#if store.sortDirection === 'asc'}
			<ChevronUp class="h-3 w-3 shrink-0" />
		{:else}
			<ChevronDown class="h-3 w-3 shrink-0" />
		{/if}
	{:else}
		<ArrowUpDown class="h-3 w-3 shrink-0 opacity-50" />
	{/if}
{/snippet}

<div
	role="row"
	aria-rowindex={ariaRowIndex}
	data-file-tree-column-grid
	class="sticky top-0 z-20 grid h-8 min-h-8 gap-2 border-b border-border bg-card px-2 text-xs font-medium text-muted-foreground"
	style={`grid-template-columns: ${store.columnGridTemplate}`}
>
	{#each visibleColumns as column, columnIndex (column)}
		<div
			role="columnheader"
			aria-colindex={columnIndex + 1}
			aria-sort={store.sortKey === column
				? store.sortDirection === 'asc'
					? 'ascending'
					: 'descending'
				: undefined}
			class="relative flex min-w-0 items-center"
		>
			<button
				type="button"
				class={`inline-flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${store.sortKey === column ? 'text-foreground' : ''}`}
				onclick={() => store.toggleSort(column)}
				aria-label={sortLabel(column)}
			>
				<span class="truncate">{labels[column]()}</span>
				{@render sortIcon(column)}
			</button>
			{#if columnIndex < visibleColumns.length - 1}
				{@const rightColumn = visibleColumns[columnIndex + 1]}
				<FileTreeColumnResizeHandle
					value={boundaryValue(column)}
					minimum={boundaryMinimum(column)}
					maximum={boundaryMaximum(column)}
					valueText={`${labels[column]()} ${Math.round((store.columnWidths[column] / visibleWeight) * 100)}%`}
					label={m.filetree_resize_columns({
						leftColumn: labels[column](),
						rightColumn: labels[rightColumn](),
					})}
					onResizeStart={beginResize}
					onResizePreview={(delta) => previewResize(column, delta)}
					onResizeCommit={commitResize}
					onResizeCancel={cancelResize}
					onResizeByKeyboard={(delta) => resizeByKeyboard(column, delta)}
					onReset={() => store.resetColumnWidths()}
				/>
			{/if}
		</div>
	{/each}
</div>
