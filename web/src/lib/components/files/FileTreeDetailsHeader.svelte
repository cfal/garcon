<script lang="ts">
	import type { SortDirection, SortKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import { fileTreeFieldLabel } from './file-tree-entry-presentation.js';

	let {
		sortKey,
		sortDirection,
		ariaRowIndex,
	}: {
		sortKey: SortKey;
		sortDirection: SortDirection;
		ariaRowIndex: number;
	} = $props();
</script>

<div role="row" aria-rowindex={ariaRowIndex} class="sr-only">
	<div
		role="columnheader"
		aria-colindex="1"
		aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
	>
		{m.filetree_name_and_details_sorted({ field: fileTreeFieldLabel(sortKey) })}
	</div>
</div>
