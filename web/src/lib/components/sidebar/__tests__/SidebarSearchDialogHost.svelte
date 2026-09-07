<script lang="ts">
	import SidebarSearchDialog from '../SidebarSearchDialog.svelte';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatSearchSort } from '$shared/chat-search';

	interface SidebarSearchDialogHostProps {
		filteredChats: ChatSessionRecord[];
		savedSearches?: SavedChatSearch[];
		currentTime?: Date;
		onSelectChat?: (chatId: string) => void;
		onApplySavedSearch?: (search: SavedChatSearch) => void;
		onCreateSavedSearch?: () => void;
		onOpenManager?: () => void;
		onClose?: () => void;
		sort?: ChatSearchSort;
		onSortChange?: (sort: ChatSearchSort) => void;
		hasMoreTranscriptResults?: boolean;
		transcriptSearchPageError?: string | null;
		transcriptSearchRevalidationError?: string | null;
		onLoadMoreTranscriptResults?: () => Promise<void> | void;
		reduceMotion?: boolean;
	}

	let {
		filteredChats,
		savedSearches = [],
		currentTime = new Date('2025-01-01T03:00:00.000Z'),
		onSelectChat,
		onApplySavedSearch,
		onCreateSavedSearch,
		onOpenManager,
		onClose,
		sort = $bindable('relevance'),
		onSortChange,
		hasMoreTranscriptResults = false,
		transcriptSearchPageError = null,
		transcriptSearchRevalidationError = null,
		onLoadMoreTranscriptResults,
		reduceMotion = false,
	}: SidebarSearchDialogHostProps = $props();

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

	function handleSortChange(nextSort: ChatSearchSort) {
		sort = nextSort;
		onSortChange?.(nextSort);
	}
</script>

<SidebarSearchDialog
	open={isOpen}
	{query}
	{filteredChats}
	{savedSearches}
	{currentTime}
	{highlightedIndex}
	{reduceMotion}
	{sort}
	showTranscriptPagination={Boolean(onLoadMoreTranscriptResults)}
	{hasMoreTranscriptResults}
	{transcriptSearchPageError}
	{transcriptSearchRevalidationError}
	onQueryChange={handleQueryChange}
	onSelectChat={(chatId) => onSelectChat?.(chatId)}
	onApplySavedSearch={handleApplySavedSearch}
	onCreateSavedSearch={() => onCreateSavedSearch?.()}
	onOpenManager={() => onOpenManager?.()}
	onHighlightChange={handleHighlightChange}
	onSortChange={onSortChange ? handleSortChange : undefined}
	{onLoadMoreTranscriptResults}
	onClose={() => {
		isOpen = false;
		onClose?.();
	}}
/>
