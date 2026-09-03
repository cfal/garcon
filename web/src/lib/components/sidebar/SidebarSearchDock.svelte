<script lang="ts">
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import type {
		SidebarChatGrouping,
		SidebarChatItemLayout,
		SidebarSortMode,
	} from '$lib/stores/local-settings.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps {
		isLoading: boolean;
		visibleUnreadCount: number;
		isMarkingAllRead?: boolean;
		chatGrouping?: SidebarChatGrouping;
		groupNestedProjectPaths?: boolean;
		chatItemLayout?: SidebarChatItemLayout;
		sortMode?: SidebarSortMode;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		dockOnRight?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onOpenSearchDialog: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onSetChatGrouping?: (grouping: SidebarChatGrouping) => void;
		onToggleGroupNestedProjectPaths?: () => void;
		onSetChatItemLayout?: (layout: SidebarChatItemLayout) => void;
		onSetSortMode?: (mode: SidebarSortMode) => void;
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
		chatGrouping = 'project',
		groupNestedProjectPaths = false,
		chatItemLayout = 'default',
		sortMode = 'manual',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		dockOnRight = false,
		sidebarMenuSearches = [],
		sidebarPillSearches,
		activeQuery,
		onOpenSearchDialog,
		onCreateChat,
		onMarkAllRead,
		onSetChatGrouping,
		onToggleGroupNestedProjectPaths,
		onSetChatItemLayout,
		onSetSortMode,
		onToggleChatListAutohide,
		onSetDockOnRight,
		onApplySidebarMenuSearch,
		onApplyPillSearch,
		onClearActiveQuery,
		onShowScheduledPrompts,
		onShowSettings,
	}: SidebarSearchDockProps = $props();

	let hasSearchContext = $derived(sidebarPillSearches.length > 0 || activeQuery.trim().length > 0);
	// The controls row drops its own bottom border whenever the search context
	// renders directly beneath it.
	let hasContentBelowControls = $derived(hasSearchContext);
</script>

<div data-slot="sidebar-search-dock">
	<SidebarControlsRow
		{isLoading}
		{visibleUnreadCount}
		{isMarkingAllRead}
		{chatGrouping}
		{groupNestedProjectPaths}
		{chatItemLayout}
		{sortMode}
		{chatListAutohide}
		{chatListAutohideAvailable}
		{dockOnRight}
		{sidebarMenuSearches}
		hasAdjacentSearchContext={hasContentBelowControls}
		{onOpenSearchDialog}
		{onCreateChat}
		{onMarkAllRead}
		{onSetChatGrouping}
		{onToggleGroupNestedProjectPaths}
		{onSetChatItemLayout}
		{onSetSortMode}
		{onToggleChatListAutohide}
		{onSetDockOnRight}
		{onApplySidebarMenuSearch}
		{onShowScheduledPrompts}
		{onShowSettings}
	/>
	<SidebarSearchContext
		hasAdjacentControlsRow={true}
		{sidebarPillSearches}
		{activeQuery}
		{onOpenSearchDialog}
		{onApplyPillSearch}
		{onClearActiveQuery}
	/>
</div>
