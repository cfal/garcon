<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchContextProps {
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		hasControlsRowAbove?: boolean;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
	}

	let {
		sidebarPillSearches,
		activeQuery,
		hasControlsRowAbove = false,
		onApplyPillSearch,
		onClearActiveQuery,
	}: SidebarSearchContextProps = $props();

	let hasActiveQuery = $derived(activeQuery.trim().length > 0);
	let containerPaddingClass = $derived(hasControlsRowAbove ? 'px-3 pb-2' : 'px-3 py-2');
</script>

{#if sidebarPillSearches.length > 0 || hasActiveQuery}
		<div class={`flex-shrink-0 border-b border-border/60 bg-card space-y-2 ${containerPaddingClass}`}>
			{#if sidebarPillSearches.length > 0}
				<div data-slot="sidebar-search-pills">
					<SavedSearchPills searches={sidebarPillSearches} onApply={onApplyPillSearch} />
				</div>
		{/if}

		{#if hasActiveQuery}
			<div data-slot="active-search-banner" class="relative rounded-lg border border-border bg-muted/40 px-3 py-2 pr-10">
				<div class="truncate text-xs font-medium text-foreground">{activeQuery}</div>
				<button
					type="button"
					class="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
					onclick={onClearActiveQuery}
					aria-label="Clear search"
					title="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</div>
		{/if}
	</div>
{/if}
