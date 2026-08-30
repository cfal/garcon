<script lang="ts">
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import SidebarSortIndicator from './SidebarSortIndicator.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps {
		isLoading: boolean;
		visibleUnreadCount: number;
		isMarkingAllRead?: boolean;
		groupByProject?: boolean;
		groupNestedProjectPaths?: boolean;
		chatItemLayout?: SidebarChatItemLayout;
		sortByRecent?: boolean;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		dockOnRight?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onToggleGroupByProject?: () => void;
		onToggleGroupNestedProjectPaths?: () => void;
		onSetChatItemLayout?: (layout: SidebarChatItemLayout) => void;
		onToggleSortByRecent?: () => void;
		onToggleChatListAutohide?: () => void;
		onSetDockOnRight?: (enabled: boolean) => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
		onShowScheduledPrompts: () => void;
		onShowSettings: () => void;
	}

	let {
		isLoading,
		visibleUnreadCount,
		isMarkingAllRead = false,
		groupByProject = false,
		groupNestedProjectPaths = false,
		chatItemLayout = 'default',
		sortByRecent = false,
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		dockOnRight = false,
		sidebarMenuSearches = [],
		sidebarPillSearches,
		activeQuery,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onToggleGroupByProject,
		onToggleGroupNestedProjectPaths,
		onSetChatItemLayout,
		onToggleSortByRecent,
		onToggleChatListAutohide,
		onSetDockOnRight,
		onApplySidebarMenuSearch,
		onApplyPillSearch,
		onClearActiveQuery,
		onShowScheduledPrompts,
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
		{chatItemLayout}
		{sortByRecent}
		{chatListAutohide}
		{chatListAutohideAvailable}
		{dockOnRight}
		{sidebarMenuSearches}
		hasAdjacentSearchContext={hasContentBelowControls}
		{onOpenSearchDialog}
		{onCreateChat}
		{onMarkAllRead}
		{onToggleGroupByProject}
		{onToggleGroupNestedProjectPaths}
		{onSetChatItemLayout}
		{onToggleSortByRecent}
		{onToggleChatListAutohide}
		{onSetDockOnRight}
		{onApplySidebarMenuSearch}
		{onShowScheduledPrompts}
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
