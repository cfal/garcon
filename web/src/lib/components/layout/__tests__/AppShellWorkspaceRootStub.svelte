<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		DEFAULT_DESKTOP_LAYOUT_ORDER,
		resolveDesktopLayout,
		type DesktopLayoutEdge,
		type DesktopLayoutOrder,
	} from '$lib/layout/desktop-layout.js';

	let {
		isMobile,
		desktopLayoutOrder = [...DEFAULT_DESKTOP_LAYOUT_ORDER],
		desktopChatList,
	}: {
		isMobile: boolean;
		desktopLayoutOrder?: DesktopLayoutOrder;
		desktopChatList?: Snippet<[{ dividerEdge: DesktopLayoutEdge }]>;
	} = $props();
	const desktopLayout = $derived(resolveDesktopLayout(desktopLayoutOrder));
</script>

<div data-testid="workspace-root-stub" data-mobile={isMobile}>
	{#if !isMobile && desktopChatList}
		{@render desktopChatList({
			dividerEdge: desktopLayout.chatListEdge,
		})}
	{/if}
	Workspace root
</div>
