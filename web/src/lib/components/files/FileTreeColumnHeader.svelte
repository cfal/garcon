<script lang="ts">
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import * as m from '$lib/paraglide/messages.js';
	import {
		FILE_TREE_COLUMN_KEYS,
		FILE_TREE_COLUMN_MIN_WIDTHS,
		resizeFileTreeColumnBoundary,
		type FileTreeColumnKey,
		type FileTreeColumnWidths,
		type FileTreeStore,
	} from '$lib/files/tree/file-tree.svelte.js';
	import FileTreeColumnResizeHandle from './FileTreeColumnResizeHandle.svelte';

	let { store }: { store: FileTreeStore } = $props();
	let resizeStartWidths: FileTreeColumnWidths | null = null;

	const labels: Record<FileTreeColumnKey, () => string> = {
		name: m.filetree_name,
		size: m.filetree_size,
		modified: m.filetree_modified,
		permissions: m.filetree_permissions,
	};

	function headerButtonClass(column: FileTreeColumnKey): string {
		return store.sortKey === column
			? 'inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-foreground hover:text-foreground'
			: 'inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap hover:text-foreground';
	}

	function boundaryValue(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = FILE_TREE_COLUMN_KEYS.indexOf(leftColumn);
		return FILE_TREE_COLUMN_KEYS.slice(0, boundaryIndex + 1).reduce(
			(sum, key) => sum + store.columnWidths[key],
			0,
		);
	}

	function boundaryMinimum(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = FILE_TREE_COLUMN_KEYS.indexOf(leftColumn);
		return (
			FILE_TREE_COLUMN_KEYS.slice(0, boundaryIndex).reduce(
				(sum, key) => sum + store.columnWidths[key],
				0,
			) + FILE_TREE_COLUMN_MIN_WIDTHS[leftColumn]
		);
	}

	function boundaryMaximum(leftColumn: FileTreeColumnKey): number {
		const boundaryIndex = FILE_TREE_COLUMN_KEYS.indexOf(leftColumn);
		const rightColumn = FILE_TREE_COLUMN_KEYS[boundaryIndex + 1];
		return rightColumn
			? boundaryValue(leftColumn) +
					store.columnWidths[rightColumn] -
					FILE_TREE_COLUMN_MIN_WIDTHS[rightColumn]
			: boundaryValue(leftColumn);
	}

	function beginResize(): void {
		resizeStartWidths = { ...store.columnWidths };
	}

	function previewResize(leftColumn: FileTreeColumnKey, deltaPercentagePoints: number): void {
		if (!resizeStartWidths) return;
		store.previewColumnWidths(
			resizeFileTreeColumnBoundary(resizeStartWidths, leftColumn, deltaPercentagePoints),
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
			resizeFileTreeColumnBoundary(store.columnWidths, leftColumn, deltaPercentagePoints),
		);
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

{#snippet resizeHandle(leftColumn: FileTreeColumnKey, rightColumn: FileTreeColumnKey)}
	<FileTreeColumnResizeHandle
		value={boundaryValue(leftColumn)}
		minimum={boundaryMinimum(leftColumn)}
		maximum={boundaryMaximum(leftColumn)}
		valueText={`${labels[leftColumn]()} ${Math.round(store.columnWidths[leftColumn])}%`}
		label={m.filetree_resize_columns({
			leftColumn: labels[leftColumn](),
			rightColumn: labels[rightColumn](),
		})}
		onResizeStart={beginResize}
		onResizePreview={(delta) => previewResize(leftColumn, delta)}
		onResizeCommit={commitResize}
		onResizeCancel={cancelResize}
		onResizeByKeyboard={(delta) => resizeByKeyboard(leftColumn, delta)}
		onReset={() => store.resetColumnWidths()}
	/>
{/snippet}

<div class="border-b border-border bg-card px-2 pb-1 pt-1">
	<div
		data-file-tree-column-grid
		class="grid gap-2 px-2 text-xs font-medium text-muted-foreground"
		style={`grid-template-columns: ${store.columnGridTemplate}`}
	>
		{#each FILE_TREE_COLUMN_KEYS as column, columnIndex (column)}
			<div class="relative min-w-0">
				<button
					type="button"
					class={headerButtonClass(column)}
					onclick={() => store.toggleSort(column)}
					aria-label={column === 'name'
						? m.filetree_sort_by_name()
						: column === 'size'
							? m.filetree_sort_by_size()
							: column === 'modified'
								? m.filetree_sort_by_modified()
								: m.filetree_sort_by_permissions()}
				>
					<span class="min-w-0 truncate">{labels[column]()}</span>
					{@render sortIcon(column)}
				</button>
				{#if columnIndex < FILE_TREE_COLUMN_KEYS.length - 1}
					{@render resizeHandle(column, FILE_TREE_COLUMN_KEYS[columnIndex + 1])}
				{/if}
			</div>
		{/each}
	</div>
</div>
