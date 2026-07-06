<script lang="ts">
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import SidebarSortIndicator from './SidebarSortIndicator.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps {
		isLoading: boolean;
		visibleUnreadCount: number;
		isMarkingAllRead?: boolean;
		groupByProject?: boolean;
		groupNestedProjectPaths?: boolean;
		compactChatItems?: boolean;
		sortByRecent?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onToggleGroupByProject?: () => void;
		onToggleGroupNestedProjectPaths?: () => void;
		onToggleCompactChatItems?: () => void;
		onToggleSortByRecent?: () => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		visibleUnreadCount,
		isMarkingAllRead = false,
		groupByProject = false,
		groupNestedProjectPaths = false,
		compactChatItems = false,
		sortByRecent = false,
		sidebarMenuSearches = [],
		sidebarPillSearches,
		activeQuery,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onToggleGroupByProject,
		onToggleGroupNestedProjectPaths,
		onToggleCompactChatItems,
		onToggleSortByRecent,
		onApplySidebarMenuSearch,
		onApplyPillSearch,
		onClearActiveQuery,
		onShowSettings,
	}: SidebarSearchDockProps = $props();

	let hasSearchContext = $derived(sidebarPillSearches.length > 0 || activeQuery.trim().length > 0);
	// The controls row drops its own bottom border whenever another element
	// (sort indicator or search context) renders directly beneath it.
	let hasContentBelowControls = $derived(sortByRecent || hasSearchContext);
</script>

<div data-slot="sidebar-search-dock">
	<SidebarControlsRow
		{isLoading}
		{visibleUnreadCount}
		{isMarkingAllRead}
		{groupByProject}
		{groupNestedProjectPaths}
		{compactChatItems}
		{sortByRecent}
		{sidebarMenuSearches}
		hasAdjacentSearchContext={hasContentBelowControls}
		{onOpenSearchDialog}
		{onCreateChat}
		{onMarkAllRead}
		{onToggleGroupByProject}
		{onToggleGroupNestedProjectPaths}
		{onToggleCompactChatItems}
		{onToggleSortByRecent}
		{onApplySidebarMenuSearch}
		{onShowSettings}
	/>
	<SidebarSortIndicator active={sortByRecent} onDisable={() => onToggleSortByRecent?.()} />
	<SidebarSearchContext
		hasAdjacentControlsRow={true}
		{sidebarPillSearches}
		{activeQuery}
		{onOpenSearchDialog}
		{onApplyPillSearch}
		{onClearActiveQuery}
	/>
</div>
