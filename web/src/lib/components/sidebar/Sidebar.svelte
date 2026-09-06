<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarSearchDock from './SidebarSearchDock.svelte';
	import SidebarSelectionBar from './SidebarSelectionBar.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';
	import { searchResultNavigation } from '$lib/chat/actions/search-result-navigation.svelte.js';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import {
		getAppShell,
		getMinuteClock,
		getNotifications,
		getLocalSettings,
		getReadReceiptOutbox,
		getSidebarProjectCollapse,
		getSidebarSearch,
		getRemoteSettings,
	} from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';
	import { createPerListWriteQueue } from './reorder-write-queue';
	import { SidebarController, type SidebarBulkAction } from './sidebar-controller.svelte';
	import { SidebarBulkDeleteState } from './sidebar-bulk-delete-state.svelte';
	import { SidebarChatSelectionState } from '$lib/components/sidebar/sidebar-chat-selection-state.svelte.js';
	import { addTagToQuery } from '$lib/sidebar/search/sidebar-search.js';
	import {
		EMPTY_TRANSCRIPT_SEARCH_INVALIDATION,
		transcriptSearchInvalidationProjection,
	} from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { buildSidebarDisplayChatIds, buildSidebarProjectKeys } from './sidebar-row-model';
	import { SIDEBAR_SECTION_COLLAPSE_KEYS } from './sidebar-virtual-chat-list';
	import {
		sidebarGroupingUsesProjects,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';
	import type {
		SidebarChatGrouping,
		SidebarChatItemLayout,
		SidebarSortMode,
	} from '$lib/stores/local-settings.svelte';
	import type { ChatSearchSort } from '$shared/chat-search';
	import type { SavedChatSearch } from '$lib/api/settings';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';

	interface QuickMoveWrite {
		list: PersistedChatOrderGroup;
		chatId: string;
		placement: RelativeChatOrderPlacement;
		onSuccess?: () => void;
		onFailure?: () => void;
	}

	interface SidebarProps {
		chats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		onChatSelect: (chatId: string) => void;
		onNewChat: () => void;
		/** Applies the optimistic local removal (store + navigation) a
		 *  ChatSessionDeletedWsMessage would trigger, without waiting for
		 *  the server. Used by bulk delete so the list updates instantly. */
		onLocallyDeleteChat?: (chatId: string) => void;
		onQuietRefresh: () => Promise<void> | void;
		onRequestDeleteChat: (chat: ChatSessionRecord) => void;
		onRequestRenameChat: (chat: ChatSessionRecord) => void;
		onTogglePinned: (chatId: string) => Promise<void> | void;
		onToggleArchive: (chatId: string) => Promise<void> | void;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => Promise<void> | void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onManageTags: (chat: ChatSessionRecord) => void;
		onOpenChatInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		chatListAutohideAvailable?: boolean;
		onChatListAutohideChange?: (enabled: boolean) => void;
		onShowScheduledPrompts: () => void;
		onShowPreambles: () => void;
		onShowSettings: () => void;
		newWindowEdges: WorkspaceSplitAdmissions;
	}

	let {
		chats,
		selectedChatId,
		isLoading,
		isMobile = false,
		onChatSelect,
		onNewChat,
		onLocallyDeleteChat,
		onQuietRefresh,
		onRequestDeleteChat,
		onRequestRenameChat,
		onTogglePinned,
		onToggleArchive,
		onShowDetails,
		onForkChat,
		onShareChat,
		onManageTags,
		onOpenChatInNewWindow,
		chatListAutohideAvailable = false,
		onChatListAutohideChange,
		onShowScheduledPrompts,
		onShowPreambles,
		onShowSettings,
		newWindowEdges,
	}: SidebarProps = $props();
	const appShell = getAppShell();
	const notifications = getNotifications();
	const localSettings = getLocalSettings();
	const readReceiptOutbox = getReadReceiptOutbox();
	const projectCollapse = getSidebarProjectCollapse();
	const sidebarSearch = getSidebarSearch();
	const remoteSettings = getRemoteSettings();
	const controller = new SidebarController({
		get onQuietRefresh() {
			return onQuietRefresh;
		},
	});

	const selection = new SidebarChatSelectionState();
	const bulkDelete = new SidebarBulkDeleteState();
	const minuteClock = getMinuteClock();

	// Sidebar UI state.
	let isBulkOperating = $state(false);
	let currentTime = $derived(minuteClock.currentTime);
	let isMarkingAllRead = $state(false);
	let transcriptSearchRetryVersion = $state(0);
	let displayOptions = $derived<SidebarDisplayOptions>({
		grouping: localSettings.sidebarGrouping,
		inactivityDuration: localSettings.sidebarInactivityDuration,
		groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
		chatItemLayout: localSettings.sidebarChatItemLayout,
		sortMode: localSettings.sidebarSortMode,
	});
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

	let visibleUnreadChatIds = $derived.by(() =>
		sidebarSearch.filteredChats
			.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
			.map((chat) => chat.id),
	);
	let displayedChatIds = $derived.by(() =>
		buildSidebarDisplayChatIds({
			displayedChats: sidebarSearch.filteredChats,
			grouping: displayOptions.grouping,
			currentTime,
			inactivityDuration: displayOptions.inactivityDuration,
			sortMode: displayOptions.sortMode,
			groupNestedProjectPaths: displayOptions.groupNestedProjectPaths,
			collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
		}),
	);
	let displayedChatIdSet = $derived(new Set(displayedChatIds));
	let allProjectKeys = $derived.by(() => {
		const projectKeys = buildSidebarProjectKeys({
			displayedChats: chats,
			groupNestedProjectPaths: displayOptions.groupNestedProjectPaths,
		});
		// Activity sections collapse through the same store; their keys stay in
		// the pruning allowlist regardless of mode so section collapse
		// preferences survive grouping-mode switches, like project keys do.
		projectKeys.push(...SIDEBAR_SECTION_COLLAPSE_KEYS);
		return projectKeys;
	});

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

	function handleChatClick(chatId: string) {
		onChatSelect(chatId);
	}

	function reportActionFailure(logMessage: string, userMessage: string, error: unknown): void {
		console.error(logMessage, error);
		notifications.error(userMessage);
	}

	function handleTagClick(tag: string) {
		sidebarSearch.applyQuery(addTagToQuery(sidebarSearch.activeQuery, tag));
	}

	function handlePrimaryAction() {
		if (selection.isActive) selection.exit();
		onNewChat();
	}

	const quickMoveQueue = createPerListWriteQueue<PersistedChatOrderGroup, QuickMoveWrite>(
		async ({ chatId, placement }) => {
			await controller.reorderChat(chatId, placement);
		},
		(error, task) => {
			reportActionFailure(
				`Failed to quick reorder ${task.list} chat order:`,
				m.notifications_reorder_chats_failed(),
				error,
			);
		},
	);

	function handleQuickMove(
		list: PersistedChatOrderGroup,
		chatId: string,
		placement: RelativeChatOrderPlacement,
		onSuccess?: () => void,
		onFailure?: () => void,
	) {
		quickMoveQueue.enqueue({ list, chatId, placement, onSuccess, onFailure });
	}

	async function handleSortChatOrder(sortKey: ChatOrderSortKey): Promise<void> {
		try {
			const response = await controller.sortChatOrder(sortKey);
			if (!response.changed) return;
			notifications.info(m.notifications_reorder_chats_applied());
			appShell.requestSidebarRecenterToSelected();
		} catch (error) {
			reportActionFailure(
				'Failed to sort manual chat order:',
				m.notifications_reorder_chats_failed(),
				error,
			);
		}
	}

	// Multi-select mode handlers.

	function enterMultiSelect(chatId: string) {
		selection.enter(chatId);
	}

	function handleMultiSelectToggle(chatId: string, shiftKey: boolean) {
		if (shiftKey) {
			selection.selectRange(displayedChatIds, chatId);
		} else {
			selection.toggle(chatId);
		}
	}

	function handleSelectAll() {
		selection.selectAll(displayedChatIds);
	}

	function handleDeselectAll() {
		selection.deselectAll();
	}

	function exitMultiSelect() {
		selection.exit();
	}

	// Prunes stale selections when the chat list changes (server refresh,
	// external delete, filter change).
	$effect(() => {
		if (!selection.isActive) return;
		selection.pruneToVisible(displayedChatIdSet);
	});

	// Authoritative list of selected chats that still exist in the current
	// chat list. All display counts and actions derive from this.
	let selectedChats = $derived.by(() => {
		if (!selection.isActive) return [];
		return chats.filter((c) => displayedChatIdSet.has(c.id) && selection.isSelected(c.id));
	});

	$effect(() => {
		if (isLoading) return;
		untrack(() => projectCollapse.pruneToProjectKeys(allProjectKeys));
	});

	let bulkShowPin = $derived(selectedChats.some((c) => !c.isPinned));
	let bulkShowUnpin = $derived(selectedChats.some((c) => c.isPinned));
	let bulkShowArchive = $derived(selectedChats.some((c) => !c.isArchived));
	let bulkShowUnarchive = $derived(selectedChats.some((c) => c.isArchived));

	async function handleBulkOperation(
		action: SidebarBulkAction,
		logMessage: string,
		userMessage: string,
	) {
		isBulkOperating = true;
		try {
			const result = await controller.runBulkOperation(action, {
				selectedChats,
				allChats: chats,
				selectedChatId,
			});
			if (result.nextSelectedChatId) {
				onChatSelect(result.nextSelectedChatId);
			} else if (result.shouldCreateNewChat) {
				onNewChat();
			}
		} catch (error) {
			reportActionFailure(logMessage, userMessage, error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	function handleBulkDeleteRequest() {
		bulkDelete.request(selectedChats, m.sidebar_chats_unnamed());
	}

	async function confirmBulkDelete() {
		if (!bulkDelete.confirmation) return;
		const ids = bulkDelete.confirmation.chatIds;
		bulkDelete.clear();
		const isSelectedChatInBulk = selectedChatId && ids.includes(selectedChatId);
		// Resolve the surviving neighbor before the optimistic removal runs.
		const remainingSelection = isSelectedChatInBulk
			? (chats.find((c) => !ids.includes(c.id))?.id ?? null)
			: null;
		isBulkOperating = true;
		try {
			// Drop from the store immediately so the list updates without
			// waiting for every DELETE response to come back.
			if (onLocallyDeleteChat) {
				for (const id of ids) onLocallyDeleteChat(id);
			}
			if (isSelectedChatInBulk) {
				if (remainingSelection) onChatSelect(remainingSelection);
				else onNewChat();
			}
			await controller.bulkDelete(ids);
		} catch (error) {
			reportActionFailure('Failed to bulk delete:', m.notifications_bulk_delete_failed(), error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	// Exits multi-select on Escape key.
	function handleSidebarKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && selection.isActive) {
			e.preventDefault();
			e.stopPropagation();
			selection.exit();
		}
	}

	async function handleMarkAllRead() {
		if (isMarkingAllRead || visibleUnreadChatIds.length === 0) return;
		isMarkingAllRead = true;
		try {
			await readReceiptOutbox.markChatsReadNow(visibleUnreadChatIds);
		} catch (error) {
			reportActionFailure(
				'Failed to mark chats read:',
				m.notifications_mark_all_read_failed(),
				error,
			);
		} finally {
			isMarkingAllRead = false;
		}
	}

	function handleSetChatGrouping(grouping: SidebarChatGrouping): void {
		localSettings.set('sidebarGrouping', grouping);
	}

	function handleToggleGroupNestedProjectPaths(): void {
		if (!sidebarGroupingUsesProjects(localSettings.sidebarGrouping)) return;
		localSettings.toggle('sidebarGroupNestedProjectPaths');
	}

	function handleSetChatItemLayout(layout: SidebarChatItemLayout): void {
		localSettings.set('sidebarChatItemLayout', layout);
	}

	function handleSetSortMode(sortMode: SidebarSortMode): void {
		localSettings.set('sidebarSortMode', sortMode);
	}

	function handleSetSearchResultSort(sort: ChatSearchSort): void {
		if (sort === localSettings.sidebarSearchResultSort) return;
		localSettings.set('sidebarSearchResultSort', sort);
		sidebarSearch.resetTranscriptSearchForSortChange();
	}

	function handleToggleChatListAutohide(): void {
		if (!chatListAutohideAvailable) return;
		const enabled = !localSettings.chatListAutohide;
		localSettings.set('chatListAutohide', enabled);
		onChatListAutohideChange?.(enabled);
	}

	function handleSetDockOnRight(enabled: boolean): void {
		localSettings.set('chatListDock', enabled ? 'right' : 'left');
	}

	// Search dialog actions.

	function handleSearchSelectChat(chatId: string) {
		sidebarSearch.confirmSearchDialog();
		void sidebarSearch.openTranscriptResult(chatId, (id, seq) => {
			if (seq !== null) searchResultNavigation.set(id, seq);
			onChatSelect(id);
		});
	}

	function handleApplySavedSearch(search: SavedChatSearch) {
		sidebarSearch.updateDraftQuery(search.query);
	}

	function handleApplySidebarMenuSearch(query: string) {
		sidebarSearch.applyQuery(query);
	}

	function handleApplySidebarPillSearch(search: SavedChatSearch) {
		sidebarSearch.applyQuery(search.query);
	}

	function handleClearActiveQuery() {
		sidebarSearch.applyQuery('');
	}

	// Lifecycle.

	onMount(() =>
		appShell.onSidebarSearchRequested(() => {
			sidebarSearch.toggleSearchDialog();
		}),
	);
</script>

<!-- The container delegates bubbled Escape handling for the sidebar subtree. Follow-up: CLEANUP_ROUND_TWO.md#a11y-suppression-register. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	data-slot="sidebar"
	class={[
		'h-full flex flex-col bg-card md:select-none relative',
		localSettings.reduceMotion && 'sidebar-reduce-motion',
	]}
	onkeydown={handleSidebarKeydown}
>
	<div class="order-1 flex-shrink-0">
		<SidebarSearchDock
			{isLoading}
			visibleUnreadCount={visibleUnreadChatIds.length}
			chatGrouping={displayOptions.grouping}
			groupNestedProjectPaths={displayOptions.groupNestedProjectPaths}
			chatItemLayout={displayOptions.chatItemLayout}
			sortMode={displayOptions.sortMode}
			chatListAutohide={localSettings.chatListAutohide}
			{chatListAutohideAvailable}
			dockOnRight={localSettings.chatListDock === 'right'}
			sidebarMenuSearches={sidebarSearch.sidebarMenuSearches}
			sidebarPillSearches={sidebarSearch.sidebarPillSearches}
			activeQuery={sidebarSearch.activeQuery}
			onOpenSearchDialog={() => sidebarSearch.openSearchDialog()}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => {
				void handleMarkAllRead();
			}}
			onSetChatGrouping={handleSetChatGrouping}
			onToggleGroupNestedProjectPaths={handleToggleGroupNestedProjectPaths}
			onSetChatItemLayout={handleSetChatItemLayout}
			onSetSortMode={handleSetSortMode}
			onToggleChatListAutohide={handleToggleChatListAutohide}
			onSetDockOnRight={handleSetDockOnRight}
			onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			onApplyPillSearch={handleApplySidebarPillSearch}
			onClearActiveQuery={handleClearActiveQuery}
			{onShowScheduledPrompts}
			{onShowPreambles}
			{onShowSettings}
		/>
	</div>

	<div class="order-2 flex min-h-0 flex-1">
		<SidebarContent
			{chats}
			filteredChats={sidebarSearch.filteredChats}
			{selectedChatId}
			{isLoading}
			{isMobile}
			{currentTime}
			searchFilter={sidebarSearch.activeQuery}
			{onNewChat}
			isMultiSelectMode={selection.isActive}
			isMultiSelected={(id) => selection.isSelected(id)}
			{displayOptions}
			collapsedProjectKeys={projectCollapse.collapsedProjectKeys}
			onToggleProjectCollapsed={(projectKey) => projectCollapse.toggle(projectKey)}
			onEnterMultiSelect={enterMultiSelect}
			onMultiSelectToggle={handleMultiSelectToggle}
			onChatSelect={handleChatClick}
			onDeleteChat={onRequestDeleteChat}
			onStartRenameChat={onRequestRenameChat}
			onTogglePinned={(id) => {
				void onTogglePinned(id);
			}}
			onToggleArchive={(id) => {
				void onToggleArchive(id);
			}}
			{onShowDetails}
			onForkChat={(id) => {
				void onForkChat(id);
			}}
			{onShareChat}
			onTagClick={handleTagClick}
			{onManageTags}
			onOpenInNewWindow={onOpenChatInNewWindow}
			{newWindowEdges}
			onQuickMove={handleQuickMove}
			onSortChatOrder={handleSortChatOrder}
		/>
	</div>

	{#if selection.isActive}
		<SidebarSelectionBar
			count={selectedChats.length}
			totalVisible={displayedChatIds.length}
			showPin={bulkShowPin}
			showUnpin={bulkShowUnpin}
			showArchive={bulkShowArchive}
			showUnarchive={bulkShowUnarchive}
			isOperating={isBulkOperating}
			onSelectAll={handleSelectAll}
			onDeselectAll={handleDeselectAll}
			onPin={() => {
				void handleBulkOperation('pin', 'Failed to bulk pin:', m.notifications_bulk_pin_failed());
			}}
			onUnpin={() => {
				void handleBulkOperation(
					'unpin',
					'Failed to bulk unpin:',
					m.notifications_bulk_unpin_failed(),
				);
			}}
			onArchive={() => {
				void handleBulkOperation(
					'archive',
					'Failed to bulk archive:',
					m.notifications_bulk_archive_failed(),
				);
			}}
			onUnarchive={() => {
				void handleBulkOperation(
					'unarchive',
					'Failed to bulk unarchive:',
					m.notifications_bulk_unarchive_failed(),
				);
			}}
			onDelete={handleBulkDeleteRequest}
			onDone={exitMultiSelect}
		/>
	{/if}
</div>

<!-- Bulk delete confirmation dialog -->
<Dialog.Root
	open={bulkDelete.confirmation !== null}
	onOpenChange={(open) => {
		if (!open) bulkDelete.clear();
	}}
>
	<Dialog.Content>
		<Dialog.Header class="min-w-0">
			<Dialog.Title
				>{m.sidebar_select_delete_confirm_title({
					count: bulkDelete.confirmation?.chatIds.length ?? 0,
				})}</Dialog.Title
			>
			<Dialog.Description class="min-w-0 max-w-full">
				<span class="block text-sm text-muted-foreground mb-2"
					>{m.sidebar_select_delete_confirm_description()}</span
				>
				{#if bulkDelete.confirmation}
					<ul class="list-disc pl-4 space-y-0.5 text-sm text-foreground max-h-32 overflow-y-auto">
						{#each bulkDelete.confirmation.chatTitles.slice(0, 5) as title, index (index)}
							<li class="truncate">{title}</li>
						{/each}
						{#if bulkDelete.confirmation.chatTitles.length > 5}
							<li class="text-muted-foreground italic">
								{m.sidebar_select_delete_confirm_and_more({
									count: bulkDelete.confirmation.chatTitles.length - 5,
								})}
							</li>
						{/if}
					</ul>
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => bulkDelete.clear()}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				variant="destructive"
				onclick={() => {
					void confirmBulkDelete();
				}}>{m.sidebar_actions_delete()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

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
	onQueryChange={(q) => sidebarSearch.updateDraftQuery(q)}
	onSelectChat={handleSearchSelectChat}
	onApplySavedSearch={handleApplySavedSearch}
	onOpenManager={() => sidebarSearch.openManagerFromSearchDialog()}
	onCreateSavedSearch={() => sidebarSearch.openEditorForCreateFromSearchDialog()}
	onHighlightChange={(i) => {
		sidebarSearch.highlightedResultIndex = i;
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
	onClose={() => {
		sidebarSearch.closeEditor();
	}}
	onSave={(data, searchId) => sidebarSearch.saveEditor(data, searchId)}
/>

<Dialog.Root
	open={sidebarSearch.deleteConfirmation !== null}
	onOpenChange={(open) => {
		if (!open) sidebarSearch.clearDeleteConfirmation();
	}}
>
	<Dialog.Content
		onOpenAutoFocus={(e) => {
			e.preventDefault();
			sidebarSearch.deleteButtonRef?.focus();
		}}
	>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_saved_searches_confirm_delete()}</Dialog.Title>
			<Dialog.Description
				>{m.sidebar_saved_searches_confirm_delete_description()}</Dialog.Description
			>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => sidebarSearch.clearDeleteConfirmation()}
				>{m.sidebar_actions_cancel()}</Button
			>
			<Button
				variant="destructive"
				onclick={() => {
					void sidebarSearch.confirmDelete();
				}}
				bind:ref={sidebarSearch.deleteButtonRef}>{m.sidebar_actions_delete()}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
