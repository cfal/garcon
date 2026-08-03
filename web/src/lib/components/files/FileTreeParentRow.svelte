<script lang="ts">
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import type { FileTreeColumnKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		rowKey,
		path,
		gridTemplate,
		fillerColumnKeys,
		showIcons,
		ariaRowIndex,
		focused,
		onActivate,
		onFocus,
		onKeydown,
	}: {
		rowKey: string;
		path: string | null;
		gridTemplate: string;
		fillerColumnKeys: readonly FileTreeColumnKey[];
		showIcons: boolean;
		ariaRowIndex: number;
		focused: boolean;
		onActivate: () => void;
		onFocus: () => void;
		onKeydown: (event: KeyboardEvent) => void;
	} = $props();
</script>

<div
	role="row"
	tabindex={focused ? 0 : -1}
	aria-level="1"
	aria-rowindex={ariaRowIndex}
	aria-disabled={path === null}
	data-file-tree-row
	data-file-tree-row-key={rowKey}
	data-file-tree-parent-row
	class="file-tree-virtual-row-content grid min-w-0 cursor-default select-none items-center gap-2 overflow-hidden px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	class:hover:bg-accent={path !== null}
	class:text-muted-foreground={path === null}
	style={`grid-template-columns: ${gridTemplate}`}
	onclick={path === null ? undefined : onActivate}
	onfocus={onFocus}
	onkeydown={onKeydown}
>
	<div role="rowheader" class="flex min-w-0 items-center" title={path ?? undefined}>
		<span class="file-tree-disclosure-slot shrink-0" aria-hidden="true"></span>
		{#if showIcons}
			<FolderUp class="file-tree-entry-icon mr-2 shrink-0 text-file-icon-folder" />
		{/if}
		<span class="truncate">..</span>
		<span class="sr-only">{m.filetree_parent_directory()}</span>
	</div>
	{#each fillerColumnKeys as column (column)}
		<div role="gridcell"></div>
	{/each}
</div>
