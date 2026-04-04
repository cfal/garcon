<script lang="ts">
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SidebarSearchDockProps {
		dockPlacement: 'top' | 'bottom';
		isLoading: boolean;
		isReorderMode: boolean;
		visibleUnreadCount: number;
		isMarkingAllRead?: boolean;
		sidebarMenuSearches?: SavedChatSearch[];
		sidebarPillSearches: SavedChatSearch[];
		activeQuery: string;
		onOpenSearchDialog: () => void;
		onOpenSavedSearchManager?: () => void;
		onCreateChat: () => void;
		onMarkAllRead?: () => void;
		onApplySidebarMenuSearch?: (query: string) => void;
		onApplyPillSearch: (search: SavedChatSearch) => void;
		onClearActiveQuery: () => void;
		primaryLabel?: string;
		onShowSettings: () => void;
	}

	let {
		dockPlacement,
		isLoading,
		isReorderMode,
		visibleUnreadCount,
		isMarkingAllRead = false,
		sidebarMenuSearches = [],
		sidebarPillSearches,
		activeQuery,
		onOpenSearchDialog,
		onOpenSavedSearchManager,
		onCreateChat,
		onMarkAllRead,
		onApplySidebarMenuSearch,
		onApplyPillSearch,
		onClearActiveQuery,
		primaryLabel,
		onShowSettings,
	}: SidebarSearchDockProps = $props();

	let isTopDock = $derived(dockPlacement === 'top');
	let hasSearchContext = $derived(sidebarPillSearches.length > 0 || activeQuery.trim().length > 0);
</script>

<div data-slot="sidebar-search-dock">
	{#if isTopDock}
		<SidebarControlsRow
			{dockPlacement}
			{isLoading}
			{isReorderMode}
			{visibleUnreadCount}
			{isMarkingAllRead}
			{sidebarMenuSearches}
			hasAdjacentSearchContext={hasSearchContext}
			{onOpenSearchDialog}
			{onOpenSavedSearchManager}
			onCreateChat={onCreateChat}
			{onMarkAllRead}
			{onApplySidebarMenuSearch}
			{primaryLabel}
			{onShowSettings}
		/>
		<SidebarSearchContext
			{dockPlacement}
			hasAdjacentControlsRow={true}
			{sidebarPillSearches}
			{activeQuery}
			{onOpenSearchDialog}
			onApplyPillSearch={onApplyPillSearch}
			onClearActiveQuery={onClearActiveQuery}
		/>
	{:else}
		<SidebarSearchContext
			{dockPlacement}
			hasAdjacentControlsRow={true}
			{sidebarPillSearches}
			{activeQuery}
			{onOpenSearchDialog}
			onApplyPillSearch={onApplyPillSearch}
			onClearActiveQuery={onClearActiveQuery}
		/>
		<SidebarControlsRow
			{dockPlacement}
			{isLoading}
			{isReorderMode}
			{visibleUnreadCount}
			{isMarkingAllRead}
			{sidebarMenuSearches}
			hasAdjacentSearchContext={hasSearchContext}
			{onOpenSearchDialog}
			{onOpenSavedSearchManager}
			onCreateChat={onCreateChat}
			{onMarkAllRead}
			{onApplySidebarMenuSearch}
			{primaryLabel}
			{onShowSettings}
		/>
	{/if}
</div>
