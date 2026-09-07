<script lang="ts">
	import type { FileTreeRenderRow } from '$lib/files/tree/file-tree-render-rows.js';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import type { FileTreeViewProfile } from './file-tree-view-profile.js';
	import FileTreeChildRow from './FileTreeChildRow.svelte';
	import FileTreeParentRow from './FileTreeParentRow.svelte';
	import FileTreeRow from './FileTreeRow.svelte';

	let {
		row,
		store,
		profile,
		ariaRowIndex,
		focused,
		selected,
		onActivate,
		onFocus,
		onKeydown,
	}: {
		row: FileTreeRenderRow;
		store: FileTreeStore;
		profile: FileTreeViewProfile;
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
		gridTemplate={profile.gridTemplate}
		fillerColumnKeys={profile.fillerColumnKeys}
		showIcons={store.showIcons}
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
		{profile}
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
		gridTemplate={profile.gridTemplate}
		fillerColumnKeys={profile.fillerColumnKeys}
		{ariaRowIndex}
		{focused}
		onFocus={row.status === 'error' ? onFocus : undefined}
		onKeydown={row.status === 'error' ? onKeydown : undefined}
		onRetry={row.status === 'error' ? onActivate : undefined}
	/>
{/if}
