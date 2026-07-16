<script lang="ts">
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import type { FileTreeColumnKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		rowKey,
		path,
		columnGridTemplate,
		visibleColumnKeys,
		ariaRowIndex,
		focused,
		onActivate,
		onFocus,
		onKeydown,
	}: {
		rowKey: string;
		path: string;
		columnGridTemplate: string;
		visibleColumnKeys: readonly FileTreeColumnKey[];
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
	data-file-tree-row
	data-file-tree-row-key={rowKey}
	data-file-tree-parent-row
	class="file-tree-virtual-row-content grid min-w-0 cursor-default select-none items-center gap-2 overflow-hidden px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	style={`grid-template-columns: ${columnGridTemplate}`}
	onclick={onActivate}
	onfocus={onFocus}
	onkeydown={onKeydown}
>
	<div role="rowheader" class="flex min-w-0 items-center" title={path}>
		<span class="file-tree-disclosure-slot shrink-0" aria-hidden="true"></span>
		<FolderUp class="mr-2 h-4 w-4 shrink-0 text-file-icon-folder" />
		<span class="truncate">..</span>
		<span class="sr-only">{m.filetree_parent_directory()}</span>
	</div>
	{#each visibleColumnKeys.slice(1) as column (column)}
		<div role="gridcell"></div>
	{/each}
</div>
