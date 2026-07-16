<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarSearchDock from './SidebarSearchDock.svelte';
	import SidebarSelectionBar from './SidebarSelectionBar.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import {
		getAppShell,
		getNotifications,
		getLocalSettings,
		getReadReceiptOutbox,
		getSidebarProjectCollapse,
		getSidebarSearch,
		getRemoteSettings,
	} from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';
	import { createPerListWriteQueue } from './reorder-write-queue';
	import { SidebarController, type SidebarBulkAction } from './sidebar-controller.svelte';
	import { SidebarBulkDeleteState } from './sidebar-bulk-delete-state.svelte';
	import { SidebarChatSelectionState } from '$lib/components/sidebar/sidebar-chat-selection-state.svelte.js';
	import { addTagToQuery } from '$lib/sidebar/search/sidebar-search.js';
	import { transcriptSearchFacetSignature } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import { buildSidebarDisplayChatIds, buildSidebarProjectKeys } from './sidebar-row-model';
	import type { SidebarDisplayOptions } from './sidebar-display-options';
	import type { SavedChatSearch } from '$lib/api/settings';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	interface QuickMoveWrite {
		list: ChatOrderList;
		chatId: string;
		target: ReorderQuickTarget;
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
		onShowScheduledPrompts: () => void;
		onShowSettings: () => void;
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
		onShowScheduledPrompts,
		onShowSettings,
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
	const MINUTE_MS = 60_000;

	// Sidebar UI state.
	let isBulkOperating = $state(false);
	let currentTime = $state(new Date());
	let isMarkingAllRead = $state(false);
	let transcriptSearchRetryVersion = $state(0);
	let displayOptions = $derived<SidebarDisplayOptions>({
		groupByProject: localSettings.sidebarGroupByProject,
		groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
		compactChatItems: localSettings.sidebarCompactChatItems,
		sortMode: localSettings.sidebarSortMode,
	});
	let transcriptSearchTarget = $derived(
		sidebarSearch.searchDialogOpen ? sidebarSearch.draftQuery : sidebarSearch.activeQuery,
	);
	let transcriptSearchChatSignature = $derived(transcriptSearchFacetSignature(chats));
	let transcriptSearchEnabled = $derived(
		remoteSettings.snapshot?.features?.transcriptSearch.enabled === true,
	);

	let visibleUnreadChatIds = $derived.by(() =>
		sidebarSearch.filteredChats
			.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
			.map((chat) => chat.id),
	);
	let displayedChatIds = $derived.by(() =>
		buildSidebarDisplayChatIds({
			displayedChats: sidebarSearch.filteredChats,
			groupByProject: displayOptions.groupByProject,
			groupNestedProjectPaths: displayOptions.groupNestedProjectPaths,
			collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
		}),
	);
	let displayedChatIdSet = $derived(new Set(displayedChatIds));
	let allProjectKeys = $derived.by(() =>
		buildSidebarProjectKeys({
			displayedChats: chats,
			groupNestedProjectPaths: displayOptions.groupNestedProjectPaths,
		}),
	);

	function millisecondsUntilNextMinute(nowMs = Date.now()): number {
		const elapsedInMinute = nowMs % MINUTE_MS;
		return elapsedInMinute === 0 ? MINUTE_MS : MINUTE_MS - elapsedInMinute;
	}

	// Refreshes relative timestamp labels on minute boundaries.
	$effect(() => {
		let intervalId: ReturnType<typeof setInterval> | null = null;

		const refreshCurrentTime = () => {
			currentTime = new Date();
		};

		const timeoutId = setTimeout(() => {
			refreshCurrentTime();
			intervalId = setInterval(refreshCurrentTime, MINUTE_MS);
		}, millisecondsUntilNextMinute());

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') refreshCurrentTime();
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearTimeout(timeoutId);
			if (intervalId) clearInterval(intervalId);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	$effect(() => {
		const query = transcriptSearchTarget;
		const enabled = transcriptSearchEnabled;
		transcriptSearchChatSignature;
		transcriptSearchRetryVersion;
		if (!enabled || !query.trim()) {
			sidebarSearch.clearTranscriptSearch();
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

	const quickMoveQueue = createPerListWriteQueue<ChatOrderList, QuickMoveWrite>(
		async ({ chatId, target }) => {
			await controller.quickMove(chatId, target);
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
		list: ChatOrderList,
		chatId: string,
		target: ReorderQuickTarget,
		onSuccess?: () => void,
		onFailure?: () => void,
	) {
		quickMoveQueue.enqueue({ list, chatId, target, onSuccess, onFailure });
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

	function handleToggleGroupByProject(): void {
		localSettings.toggle('sidebarGroupByProject');
	}

	function handleToggleGroupNestedProjectPaths(): void {
		if (!localSettings.sidebarGroupByProject) return;
		localSettings.toggle('sidebarGroupNestedProjectPaths');
	}

	function handleToggleCompactChatItems(): void {
		localSettings.toggle('sidebarCompactChatItems');
	}

	function handleToggleSortByRecent(): void {
		localSettings.set(
			'sidebarSortMode',
			localSettings.sidebarSortMode === 'recent' ? 'manual' : 'recent',
		);
	}

	// Search dialog actions.

	function handleSearchSelectChat(chatId: string) {
		sidebarSearch.confirmSearchDialog();
		onChatSelect(chatId);
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

<!-- svelte-ignore a11y_no_static_element_interactions -- keydown on container for Escape handling -->
<div class="h-full flex flex-col bg-card md:select-none relative" onkeydown={handleSidebarKeydown}>
	<div class="order-1 flex-shrink-0">
		<SidebarSearchDock
			{isLoading}
			visibleUnreadCount={visibleUnreadChatIds.length}
			{isMarkingAllRead}
			groupByProject={displayOptions.groupByProject}
			groupNestedProjectPaths={displayOptions.groupNestedProjectPaths}
			compactChatItems={displayOptions.compactChatItems}
			sortByRecent={displayOptions.sortMode === 'recent'}
			sidebarMenuSearches={sidebarSearch.sidebarMenuSearches}
			sidebarPillSearches={sidebarSearch.sidebarPillSearches}
			activeQuery={sidebarSearch.activeQuery}
			onOpenSearchDialog={() => sidebarSearch.openSearchDialog()}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => {
				void handleMarkAllRead();
			}}
			onToggleGroupByProject={handleToggleGroupByProject}
			onToggleGroupNestedProjectPaths={handleToggleGroupNestedProjectPaths}
			onToggleCompactChatItems={handleToggleCompactChatItems}
			onToggleSortByRecent={handleToggleSortByRecent}
			onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			onApplyPillSearch={handleApplySidebarPillSearch}
			onClearActiveQuery={handleClearActiveQuery}
			{onShowScheduledPrompts}
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
			onQuickMove={handleQuickMove}
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
						{#each bulkDelete.confirmation.chatTitles.slice(0, 5) as title}
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
	transcriptSearchError={sidebarSearch.transcriptSearchError}
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
