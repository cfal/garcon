<script lang="ts">
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps {
		isLoading: boolean;
		visibleUnreadCount: number;
		isMarkingAllRead?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		visibleUnreadCount,
		isMarkingAllRead = false,
		sidebarMenuSearches = [],
		sidebarPillSearches,
		activeQuery,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onApplySidebarMenuSearch,
		onApplyPillSearch,
		onClearActiveQuery,
		onShowSettings,
	}: SidebarSearchDockProps = $props();

	let hasSearchContext = $derived(sidebarPillSearches.length > 0 || activeQuery.trim().length > 0);
</script>

<div data-slot="sidebar-search-dock">
	<SidebarControlsRow
		{isLoading}
		{visibleUnreadCount}
		{isMarkingAllRead}
		{sidebarMenuSearches}
		hasAdjacentSearchContext={hasSearchContext}
		{onOpenSearchDialog}
		onCreateChat={onCreateChat}
		{onMarkAllRead}
		{onApplySidebarMenuSearch}
		{onShowSettings}
	/>
	<SidebarSearchContext
		hasAdjacentControlsRow={true}
		{sidebarPillSearches}
		{activeQuery}
		{onOpenSearchDialog}
		onApplyPillSearch={onApplyPillSearch}
		onClearActiveQuery={onClearActiveQuery}
	/>
</div>
