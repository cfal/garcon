<script lang="ts">
	import SidebarSearchDialog from '../SidebarSearchDialog.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarSearchDialogHarnessProps {
		filteredChats: ChatSessionRecord[];
		savedSearches?: SavedChatSearch[];
		onSelectChat?: (chatId: string) => void;
		onApplySavedSearch?: (search: SavedChatSearch) => void;
		onOpenManager?: () => void;
		onClose?: () => void;
	}

	let {
		filteredChats,
		savedSearches = [],
		onSelectChat,
		onApplySavedSearch,
		onOpenManager,
		onClose,
	}: SidebarSearchDialogHarnessProps = $props();

	let query = $state('');
	let highlightedIndex = $state(0);

	function handleQueryChange(nextQuery: string) {
		query = nextQuery;
		highlightedIndex = 0;
	}

	function handleApplySavedSearch(search: SavedChatSearch) {
		query = search.query;
		highlightedIndex = 0;
		onApplySavedSearch?.(search);
	}

	function handleHighlightChange(index: number) {
		highlightedIndex = index;
	}
</script>

<SidebarSearchDialog
	open={true}
	{query}
	{filteredChats}
	{savedSearches}
	{highlightedIndex}
	onQueryChange={handleQueryChange}
	onSelectChat={(chatId) => onSelectChat?.(chatId)}
	onApplySavedSearch={handleApplySavedSearch}
	onOpenManager={() => onOpenManager?.()}
	onHighlightChange={handleHighlightChange}
	onClose={() => onClose?.()}
/>
