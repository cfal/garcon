<script lang="ts">
	import {
		sidebarChatInset,
		sidebarHeaderInset,
		type SidebarTreeGuide,
		type SidebarVirtualRow,
	} from '$lib/sidebar/display/sidebar-virtual-chat-list';

	let {
		row,
		guide,
		contentHeight,
		width,
	}: {
		row: SidebarVirtualRow;
		guide: SidebarTreeGuide;
		contentHeight: number;
		width: number;
	} = $props();
	// Clipping hides overflow; filtering also bounds the number of mounted rails.
	const continuationDepths = $derived.by(() => {
		const depths: number[] = [];
		for (let rail = guide.continuations; rail; rail = rail.outer) {
			if (sidebarChatInset(rail.depth) < width) depths.push(rail.depth);
		}
		return depths;
	});
	const junction = $derived(Math.round((contentHeight - 1) / 2));
	const parentRail = $derived(sidebarChatInset(guide.parentDepth));
	// Arms leave a gap before chat content or the header chevron.
	const armEnd = $derived(
		row.type === 'chat' ? sidebarChatInset(row.depth) - 4 : sidebarHeaderInset(row.depth) - 2,
	);
</script>

<div
	aria-hidden="true"
	class="pointer-events-none absolute inset-0 z-10 overflow-hidden"
	data-sidebar-tree-guides
>
	{#each continuationDepths as depth (depth)}
		<span
			class="absolute top-0 bottom-0 w-px bg-muted-foreground/40"
			style:left={`${sidebarChatInset(depth)}px`}
			data-sidebar-tree-continuation={depth}
		></span>
	{/each}
	{#if parentRail < width}
		<span
			class="absolute top-0 w-px bg-muted-foreground/40"
			style:left={`${parentRail}px`}
			style:height={guide.isLastChild ? `${junction + 1}px` : '100%'}
			data-sidebar-tree-incoming={guide.isLastChild ? 'end' : 'tee'}
		></span>
		<span
			class="absolute h-px bg-muted-foreground/40"
			style:left={`${parentRail + 1}px`}
			style:top={`${junction}px`}
			style:width={`${Math.max(0, armEnd - parentRail - 1)}px`}
			data-sidebar-tree-arm
		></span>
	{/if}
</div>
