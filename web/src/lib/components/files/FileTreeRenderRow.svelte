<script lang="ts">
	import type { FileTreeRenderRow } from '$lib/files/tree/file-tree-render-rows.js';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import FileTreeChildRow from './FileTreeChildRow.svelte';
	import FileTreeParentRow from './FileTreeParentRow.svelte';
	import FileTreeRow from './FileTreeRow.svelte';

	let {
		row,
		store,
		ariaRowIndex,
		focused,
		selected,
		onActivate,
		onFocus,
		onKeydown,
	}: {
		row: FileTreeRenderRow;
		store: FileTreeStore;
		ariaRowIndex: number;
		focused: boolean;
		selected: boolean;
		onActivate: () => void;
		onFocus: () => void;
		onKeydown: (event: KeyboardEvent) => void;
	} = $props();
</script>

{#if row.kind === 'parent'}
	<FileTreeParentRow
		rowKey={row.key}
		path={row.path}
		columnGridTemplate={store.columnGridTemplate}
		visibleColumnKeys={store.visibleColumnKeys}
		{ariaRowIndex}
		{focused}
		{onActivate}
		{onFocus}
		{onKeydown}
	/>
{:else if row.kind === 'entry'}
	<FileTreeRow
		{row}
		{store}
		{ariaRowIndex}
		{focused}
		{selected}
		{onActivate}
		{onFocus}
		{onKeydown}
	/>
{:else}
	<FileTreeChildRow
		kind={row.status}
		rowKey={row.key}
		level={row.level}
		directoryName={row.directoryName}
		columnGridTemplate={store.columnGridTemplate}
		visibleColumnKeys={store.visibleColumnKeys}
		{ariaRowIndex}
		{focused}
		onFocus={row.status === 'error' ? onFocus : undefined}
		onKeydown={row.status === 'error' ? onKeydown : undefined}
		onRetry={row.status === 'error' ? onActivate : undefined}
	/>
{/if}
