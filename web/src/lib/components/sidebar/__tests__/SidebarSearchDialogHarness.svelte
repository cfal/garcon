<script lang="ts">
	import SidebarSearchDialog from '../SidebarSearchDialog.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarSearchDialogHarnessProps {
		filteredChats: ChatSessionRecord[];
		savedSearches?: SavedChatSearch[];
		onSelectChat?: (chatId: string) => void;
		onApplySavedSearch?: (search: SavedChatSearch) => void;
		onCreateSavedSearch?: () => void;
		onOpenManager?: () => void;
		onClose?: () => void;
	}

	let {
		filteredChats,
		savedSearches = [],
		onSelectChat,
		onApplySavedSearch,
		onCreateSavedSearch,
		onOpenManager,
		onClose,
	}: SidebarSearchDialogHarnessProps = $props();

	let query = $state('');
	let highlightedIndex = $state(0);
	let isOpen = $state(true);

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
	open={isOpen}
	{query}
	{filteredChats}
	{savedSearches}
	{highlightedIndex}
	onQueryChange={handleQueryChange}
	onSelectChat={(chatId) => onSelectChat?.(chatId)}
	onApplySavedSearch={handleApplySavedSearch}
	onCreateSavedSearch={() => onCreateSavedSearch?.()}
	onOpenManager={() => onOpenManager?.()}
	onHighlightChange={handleHighlightChange}
	onClose={() => {
		isOpen = false;
		onClose?.();
	}}
/>
