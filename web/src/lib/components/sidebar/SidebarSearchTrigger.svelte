<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarSearchTriggerProps {
		query: string;
		onOpen: () => void;
		onClear: () => void;
	}

	let { query, onOpen, onClear }: SidebarSearchTriggerProps = $props();

	let footerControlHeightClass = 'h-9';
</script>

<div class="relative w-full">
	<button
		type="button"
		class={`w-full text-left flex ${footerControlHeightClass} items-center rounded-lg border border-sidebar-border/70 bg-muted/50 px-8 text-xs text-foreground hover:bg-background transition-colors cursor-pointer`}
		onclick={onOpen}
		onfocus={onOpen}
	>
		<span class="truncate {query ? 'text-foreground' : 'text-muted-foreground'}">
			{query || m.sidebar_projects_search_placeholder()}
		</span>
	</button>
	<Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
	{#if query}
		<button
			type="button"
			onclick={(e: MouseEvent) => { e.stopPropagation(); onClear(); }}
			class="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-accent rounded"
		>
			<X class="w-3 h-3 text-muted-foreground" />
		</button>
	{/if}
</div>
