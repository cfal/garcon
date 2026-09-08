<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { searchResultNavigation } from '$lib/chat/actions/search-result-navigation.svelte.js';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		getAppShell,
		getLocalSettings,
		getMinuteClock,
		getRemoteSettings,
		getSidebarSearch,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		EMPTY_TRANSCRIPT_SEARCH_INVALIDATION,
		transcriptSearchInvalidationProjection,
	} from '$lib/sidebar/search/transcript-search-invalidation.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SavedChatSearch } from '$lib/api/settings';
	import type { ChatSearchSort } from '$shared/chat-search';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';

	interface SidebarSearchDialogsProps {
		chats: ChatSessionRecord[];
		onSelectChat: (chatId: string) => void;
	}

	let { chats, onSelectChat }: SidebarSearchDialogsProps = $props();
	const appShell = getAppShell();
	const localSettings = getLocalSettings();
	const minuteClock = getMinuteClock();
	const remoteSettings = getRemoteSettings();
	const sidebarSearch = getSidebarSearch();
	let transcriptSearchRetryVersion = $state(0);
	let currentTime = $derived(minuteClock.currentTime);
	let transcriptSearchTarget = $derived(
		sidebarSearch.searchDialogOpen ? sidebarSearch.draftQuery : sidebarSearch.activeQuery,
	);
	let transcriptSearchEnabled = $derived(
		remoteSettings.snapshot?.features?.transcriptSearch.enabled === true,
	);
	let transcriptSearchInvalidation = $derived.by(() => {
		if (!transcriptSearchEnabled) return EMPTY_TRANSCRIPT_SEARCH_INVALIDATION;
		return transcriptSearchInvalidationProjection(
			chats,
			transcriptSearchTarget,
			localSettings.sidebarSearchResultSort,
		);
	});
	let transcriptSearchHasTerms = $derived(transcriptSearchInvalidation.hasTranscriptTerms);
	let transcriptSearchCandidateSet = $derived(transcriptSearchInvalidation.candidateSignature);
	let transcriptSearchContentRevision = $derived(transcriptSearchInvalidation.contentSignature);
	let transcriptSearchTimeOrder = $derived(transcriptSearchInvalidation.timeOrderSignature);

	$effect(() => {
		const query = transcriptSearchTarget;
		const enabled = transcriptSearchEnabled;
		const candidateSignature = transcriptSearchCandidateSet;
		localSettings.sidebarSearchResultSort;
		transcriptSearchRetryVersion;
		untrack(() => sidebarSearch.updateTranscriptSearchCandidateSignature(candidateSignature));
		if (!enabled || !transcriptSearchHasTerms) {
			untrack(() => sidebarSearch.clearTranscriptSearch());
			return;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			void sidebarSearch.refreshTranscriptSearch(query, { signal: controller.signal });
		}, 150);

		return () => {
			clearTimeout(timeoutId);
			controller.abort();
		};
	});

	$effect(() => {
		const query = transcriptSearchTarget;
		transcriptSearchContentRevision;
		transcriptSearchTimeOrder;
		if (query !== untrack(() => sidebarSearch.transcriptSearchQuery)) return;
		untrack(() => sidebarSearch.scheduleTranscriptSearchRevalidation());
	});

	function handleSearchSelectChat(chatId: string): void {
		sidebarSearch.confirmSearchDialog();
		void sidebarSearch.openTranscriptResult(chatId, (id, seq) => {
			if (seq !== null) searchResultNavigation.set(id, seq);
			onSelectChat(id);
		});
	}

	function handleApplySavedSearch(search: SavedChatSearch): void {
		sidebarSearch.updateDraftQuery(search.query);
	}

	function handleSetSearchResultSort(sort: ChatSearchSort): void {
		if (sort === localSettings.sidebarSearchResultSort) return;
		localSettings.set('sidebarSearchResultSort', sort);
		sidebarSearch.resetTranscriptSearchForSortChange();
	}

	onMount(() =>
		appShell.onSidebarSearchRequested(() => {
			sidebarSearch.toggleSearchDialog();
		}),
	);
</script>

<SidebarSearchDialog
	open={sidebarSearch.searchDialogOpen}
	query={sidebarSearch.draftQuery}
	filteredChats={sidebarSearch.dialogDisplayChats}
	savedSearches={sidebarSearch.searchDialogSavedSearches}
	transcriptMatchesByChatId={sidebarSearch.transcriptSearchResultsByChatId}
	{transcriptSearchEnabled}
	transcriptSearchLoading={sidebarSearch.transcriptSearchLoading}
	transcriptSearchIndexing={sidebarSearch.transcriptSearchIndexing}
	transcriptSearchIndex={sidebarSearch.transcriptSearchIndex}
	transcriptSearchStatus={sidebarSearch.transcriptSearchStatus}
	transcriptSearchError={sidebarSearch.transcriptSearchError}
	sort={localSettings.sidebarSearchResultSort}
	showTranscriptPagination={sidebarSearch.transcriptSearchPage !== null}
	hasMoreTranscriptResults={sidebarSearch.transcriptSearchPage?.hasMore === true &&
		!sidebarSearch.transcriptSearchLimitReached}
	loadingMoreTranscriptResults={sidebarSearch.transcriptSearchLoadingMore}
	transcriptSearchPageError={sidebarSearch.transcriptSearchPageError}
	transcriptSearchRevalidating={sidebarSearch.transcriptSearchRevalidating}
	transcriptSearchRevalidationError={sidebarSearch.transcriptSearchRevalidationError}
	transcriptSearchLimitReached={sidebarSearch.transcriptSearchLimitReached}
	transcriptSearchAnnouncement={sidebarSearch.transcriptSearchAnnouncement}
	transcriptSearchAnnouncementVersion={sidebarSearch.transcriptSearchAnnouncementVersion}
	resultsResetVersion={sidebarSearch.transcriptSearchResultsResetVersion}
	revalidationVersion={sidebarSearch.transcriptSearchRevalidationVersion}
	{currentTime}
	highlightedIndex={sidebarSearch.highlightedResultIndex}
	onQueryChange={(query) => sidebarSearch.updateDraftQuery(query)}
	onSelectChat={handleSearchSelectChat}
	onApplySavedSearch={handleApplySavedSearch}
	onOpenManager={() => sidebarSearch.openManagerFromSearchDialog()}
	onCreateSavedSearch={() => sidebarSearch.openEditorForCreateFromSearchDialog()}
	onHighlightChange={(index) => {
		sidebarSearch.highlightedResultIndex = index;
	}}
	onRetryTranscriptSearch={() => {
		transcriptSearchRetryVersion += 1;
	}}
	onSortChange={handleSetSearchResultSort}
	onLoadMoreTranscriptResults={() => sidebarSearch.loadMoreTranscriptResults()}
	onRetryTranscriptSearchRevalidation={() => sidebarSearch.retryTranscriptSearchRevalidation()}
	reduceMotion={localSettings.reduceMotion}
	onClose={() => sidebarSearch.closeSearchDialog()}
/>

<SavedSearchManagerDialog
	open={sidebarSearch.managerOpen}
	searches={sidebarSearch.savedSearches}
	onClose={() => sidebarSearch.closeManager()}
	onAdd={() => sidebarSearch.openEditorForCreate()}
	onEdit={(search) => sidebarSearch.openEditorForEdit(search)}
	onDelete={(id) => sidebarSearch.requestDelete(id)}
	onReorder={(oldOrder, newOrder) => {
		void sidebarSearch.reorder(oldOrder, newOrder);
	}}
/>

<SavedSearchEditorDialog
	editorState={sidebarSearch.editorState}
	onClose={() => sidebarSearch.closeEditor()}
	onSave={(data, searchId) => sidebarSearch.saveEditor(data, searchId)}
/>

<Dialog.Root
	open={sidebarSearch.deleteConfirmation !== null}
	onOpenChange={(open) => {
		if (!open) sidebarSearch.clearDeleteConfirmation();
	}}
>
	<Dialog.Content
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			sidebarSearch.deleteButtonRef?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_saved_searches_confirm_delete()}</Dialog.Title>
			<Dialog.Description>
				{m.sidebar_saved_searches_confirm_delete_description()}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => sidebarSearch.clearDeleteConfirmation()}>
				{m.sidebar_actions_cancel()}
			</Button>
			<Button
				variant="destructive"
				onclick={() => {
					void sidebarSearch.confirmDelete();
				}}
				bind:ref={sidebarSearch.deleteButtonRef}
			>
				{m.sidebar_actions_delete()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
