<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import SavedSearchPills from './SavedSearchPills.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarSearchContextProps {
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		hasAdjacentControlsRow?: boolean;
		onOpenSearchDialog: () => void;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
	}

	let {
		sidebarPillSearches,
		activeQuery,
		hasAdjacentControlsRow = false,
		onOpenSearchDialog,
		onApplyPillSearch,
		onClearActiveQuery,
	}: SidebarSearchContextProps = $props();

	let hasActiveQuery = $derived(activeQuery.trim().length > 0);
	let activeSidebarPillSearchId = $derived.by(() => {
		const query = activeQuery.trim();
		if (!query) return null;
		const match = sidebarPillSearches.find((search) => search.query.trim() === query);
		return match?.id ?? null;
	});
	let showActiveSearchBanner = $derived(hasActiveQuery && activeSidebarPillSearchId === null);
	let containerPaddingClass = $derived.by(() => {
		if (!hasAdjacentControlsRow) return 'px-2 py-2';
		return 'px-2 pb-2';
	});

	function handleApplyPillSearch(search: SavedChatSearch): void {
		if (search.id === activeSidebarPillSearchId) {
			onClearActiveQuery();
			return;
		}
		onApplyPillSearch(search);
	}
</script>

{#snippet savedSearchPills()}
	{#if sidebarPillSearches.length > 0}
		<div data-slot="sidebar-search-pills">
			<SavedSearchPills
				searches={sidebarPillSearches}
				activeSearchId={activeSidebarPillSearchId}
				onApply={handleApplyPillSearch}
			/>
		</div>
	{/if}
{/snippet}

{#snippet activeSearchBanner()}
	{#if showActiveSearchBanner}
		<div
			data-slot="active-search-banner"
			class="relative rounded-lg border border-border bg-muted/40"
		>
			<button
				type="button"
				class="block w-full rounded-[inherit] px-2.5 py-2 pr-10 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={onOpenSearchDialog}
				aria-label={`${m.sidebar_search_dialog_title()}: ${activeQuery}`}
				title={m.sidebar_search_dialog_title()}
			>
				<div class="truncate text-xs font-medium text-foreground">{activeQuery}</div>
			</button>
			<button
				type="button"
				class="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				onclick={onClearActiveQuery}
				aria-label={m.filetree_clear_search()}
				title={m.filetree_clear_search()}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	{/if}
{/snippet}

{#if sidebarPillSearches.length > 0 || hasActiveQuery}
	<div
		data-slot="sidebar-search-context"
		class={`flex-shrink-0 border-b border-border/60 bg-card space-y-2 ${containerPaddingClass}`}
	>
		{@render savedSearchPills()}
		{@render activeSearchBanner()}
	</div>
{/if}
