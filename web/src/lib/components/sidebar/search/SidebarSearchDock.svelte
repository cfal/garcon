<script lang="ts">
	import SidebarControlsRow from '../SidebarControlsRow.svelte';
	import type { ComponentProps } from 'svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps extends Omit<
		ComponentProps<typeof SidebarControlsRow>,
		'hasAdjacentSearchContext'
	> {
		visibleUnreadCount: number;
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
	}

	let {
		sidebarPillSearches,
		activeQuery,
		onApplyPillSearch,
		onClearActiveQuery,
		...controls
	}: SidebarSearchDockProps = $props();

	let hasSearchContext = $derived(sidebarPillSearches.length > 0 || activeQuery.trim().length > 0);
</script>

<div data-slot="sidebar-search-dock">
	<SidebarControlsRow {...controls} hasAdjacentSearchContext={hasSearchContext} />
	<SidebarSearchContext
		hasAdjacentControlsRow={true}
		{sidebarPillSearches}
		{activeQuery}
		onOpenSearchDialog={controls.onOpenSearchDialog}
		{onApplyPillSearch}
		{onClearActiveQuery}
	/>
</div>
