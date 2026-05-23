<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarSearchDock from './SidebarSearchDock.svelte';
	import SidebarSelectionBar from './SidebarSelectionBar.svelte';
	import SidebarChatDialogs from './SidebarChatDialogs.svelte';
	import SidebarTagDialog from './SidebarTagDialog.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import { getAppShell, getReadReceiptOutbox } from '$lib/context';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { reorderChats } from '$lib/api/chats.js';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import { createReorderWriteQueue } from './reorder-write-queue';
	import { SidebarController } from './sidebar-controller.svelte';
	import { SidebarSearchState } from './sidebar-search-state.svelte';
	import { ChatSelectionStore } from '$lib/stores/chat-selection.svelte';
	import { addTagToQuery } from './sidebar-search';
	import {
		getSavedSearches,
		createSavedSearch,
		updateSavedSearch as updateSavedSearchApi,
		deleteSavedSearch as deleteSavedSearchApi,
		reorderSavedSearches as reorderSavedSearchesApi,
		type SavedChatSearch,
	} from '$lib/api/settings';
	import type { SavedSearchEditorState } from './SavedSearchEditorDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	interface ChatDeleteConfirmation {
		chatId: string;
		chatTitle: string;
		agentId: SessionAgentId;
	}

	interface ChatRenameConfirmation {
		chatId: string;
		currentName: string;
	}

interface ChatDetailsDialog {
	chatId: string;
		chatTitle: string;
		firstMessage: string | null;
		createdAt: string | null;
		lastActivityAt: string | null;
		nativePath: string | null;
		isLoading: boolean;
	error: string | null;
}

type SavedSearchDialogOrigin = 'manager' | 'search-dialog';

	interface SidebarProps {
		chats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		onChatSelect: (chatId: string) => void;
		onNewChat: () => void;
		onChatDelete?: (chatId: string) => void;
		/** Applies the optimistic local removal (store + navigation) a
		 *  ChatSessionDeletedWsMessage would trigger, without waiting for
		 *  the server. Used by bulk delete so the list updates instantly. */
		onLocallyDeleteChat?: (chatId: string) => void;
		onQuietRefresh: () => Promise<void> | void;
		onChatRenamed?: (chatId: string, newTitle: string) => void;
		onShowSettings: () => void;
	}

	let {
		chats,
		selectedChatId,
		isLoading,
		onChatSelect,
		onNewChat,
		onChatDelete,
		onLocallyDeleteChat,
		onQuietRefresh,
		onChatRenamed,
		onShowSettings,
	}: SidebarProps = $props();
	const appShell = getAppShell();
	const readReceiptOutbox = getReadReceiptOutbox();
	const controller = new SidebarController({
		get onQuietRefresh() { return onQuietRefresh; },
	});

	const searchState = new SidebarSearchState({
		get chats() { return chats; },
		get selectedChatId() { return selectedChatId; },
	});

	const selection = new ChatSelectionStore();
	const MINUTE_MS = 60_000;

	// Sidebar UI state.
	let bulkDeleteConfirmation = $state<{ chatIds: string[]; chatTitles: string[] } | null>(null);
	let isBulkOperating = $state(false);
	let chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	let chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	let chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	let tagDialog = $state<{ chatId: string; chatTitle: string; tags: string[] } | null>(null);
	let shareChatDialog = $state<{ chatId: string; chatTitle: string } | null>(null);
	let currentTime = $state(new Date());
	let isMarkingAllRead = $state(false);

	// Saved search management state.
	let editorState = $state<SavedSearchEditorState | null>(null);
	let savedSearchManagerOrigin = $state<'search-dialog' | null>(null);
	let savedSearchEditorOrigin = $state<SavedSearchDialogOrigin | null>(null);
	let savedSearchDeleteConfirmation = $state<{ id: string } | null>(null);
	let savedSearchDeleteButtonRef = $state<HTMLButtonElement | null>(null);

	let visibleUnreadChatIds = $derived.by(() =>
		searchState.filteredChats
			.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
			.map((chat) => chat.id)
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

	function handleChatClick(chatId: string) {
		onChatSelect(chatId);
	}

	async function handleTogglePinned(chatId: string) {
		const chat = chats.find((s) => s.id === chatId);
		const wasPinned = chat?.isPinned === true;
		try {
			await controller.togglePinned(chatId);
			if (!wasPinned && selectedChatId === chatId) {
				appShell.requestSidebarRecenterToSelected();
			}
		} catch (error) {
			console.error('Failed to toggle pinned:', error);
		}
	}

	async function handleToggleArchive(chatId: string) {
		const chat = chats.find((s) => s.id === chatId);
		const wasArchived = chat?.isArchived === true;
		const isSelectedChat = selectedChatId === chatId;
		const isArchivingSelectedChat = !wasArchived && isSelectedChat;
		const chatIndex = chats.findIndex((s) => s.id === chatId);
		const neighborId = isArchivingSelectedChat && chatIndex >= 0
			? (chats[chatIndex + 1]?.id ?? chats[chatIndex - 1]?.id ?? null)
			: null;
		try {
			await controller.toggleArchive(chatId);
			if (isArchivingSelectedChat) {
				if (neighborId) {
					onChatSelect(neighborId);
				} else {
					onNewChat();
				}
				return;
			}
			if (wasArchived && isSelectedChat) {
				appShell.requestSidebarRecenterToSelected();
			}
		} catch (error) {
			console.error('Failed to toggle archive:', error);
		}
	}

	function showDeleteConfirmation(chatId: string, chatTitle: string, agentId: SessionAgentId) {
		chatDeleteConfirmation = { chatId, chatTitle, agentId };
	}

	async function confirmDeleteChat() {
		if (!chatDeleteConfirmation) return;
		const { chatId } = chatDeleteConfirmation;
		chatDeleteConfirmation = null;
		await onChatDelete?.(chatId);
	}

	function startRenameChat(chatId: string, currentName: string) {
		chatRenameConfirmation = { chatId, currentName };
	}

	async function confirmRenameChat(newName: string) {
		if (!chatRenameConfirmation) return;
		const { chatId } = chatRenameConfirmation;
		chatRenameConfirmation = null;
		await onChatRenamed?.(chatId, newName.trim());
		if (chatId === selectedChatId) {
			appShell.requestComposerFocus();
		}
	}

	function closeChatDetails() {
		chatDetailsDialog = null;
	}

	function showChatDetails(chatId: string, chatTitle: string) {
		chatDetailsDialog = {
			chatId,
			chatTitle,
			firstMessage: null,
			createdAt: null,
			lastActivityAt: null,
			nativePath: null,
			isLoading: true,
			error: null,
		};

		void (async () => {
			try {
				const details = await controller.loadDetails(chatId);
				if (!chatDetailsDialog || chatDetailsDialog.chatId !== chatId) return;
				chatDetailsDialog = {
					...chatDetailsDialog,
					firstMessage: details.firstMessage,
					createdAt: details.createdAt,
					lastActivityAt: details.lastActivityAt,
					nativePath: details.nativePath,
					isLoading: false,
					error: null,
				};
			} catch (error) {
				if (!chatDetailsDialog || chatDetailsDialog.chatId !== chatId) return;
				const message = error instanceof Error ? error.message : String(error);
				chatDetailsDialog = {
					...chatDetailsDialog,
					isLoading: false,
					error: message || m.sidebar_details_error_loading(),
				};
			}
		})();
	}

	function showTagDialog(chatId: string, currentTags: string[]) {
		const chat = chats.find((s) => s.id === chatId);
		tagDialog = {
			chatId,
			chatTitle: chat?.title || m.sidebar_chats_unnamed(),
			tags: currentTags,
		};
	}

	function handleTagClick(tag: string) {
		searchState.activeQuery = addTagToQuery(searchState.activeQuery, tag);
	}

	async function handleSaveTags(chatId: string, tags: string[]) {
		await controller.updateTags(chatId, tags);
		tagDialog = null;
	}

	// Reorder mode state.
	let isReorderMode = $state(false);
	let pendingReorder = $state<{ list: ChatOrderList; oldOrder: string[]; newOrder: string[] } | null>(null);

	function enterReorderMode() {
		searchState.activeQuery = '';
		pendingReorder = null;
		isReorderMode = true;
	}

	async function exitReorderMode() {
		const pending = pendingReorder;
		isReorderMode = false;
		pendingReorder = null;
		if (pending) {
			try {
				await reorderChats(pending);
				await onQuietRefresh();
			} catch (error) {
				console.error('Failed to save chat order:', error);
			}
		}
	}

	function handlePrimaryAction() {
		if (isReorderMode) {
			void exitReorderMode();
			return;
		}
		if (selection.isActive) selection.exit();
		onNewChat();
	}

	function handleReorderGroup(list: ChatOrderList, oldOrder: string[], newOrder: string[]) {
		pendingReorder = { list, oldOrder, newOrder };
	}

	const immediateReorderQueue = createReorderWriteQueue<ChatOrderList>(
		async ({ list, oldOrder, newOrder }) => {
			await reorderChats({ list, oldOrder, newOrder });
		},
		(error, task) => {
			console.error(`Failed to persist ${task.list} chat order:`, error);
		},
	);

	function handleImmediateReorder(list: ChatOrderList, oldOrder: string[], newOrder: string[]) {
		immediateReorderQueue.enqueue({ list, oldOrder, newOrder });
	}

	async function handleQuickMove(chatId: string, chatIdAbove?: string, chatIdBelow?: string) {
		try {
			await controller.quickMove(chatId, chatIdAbove, chatIdBelow);
		} catch (error) {
			console.error('Failed to quick reorder:', error);
		}
	}

	// Multi-select mode handlers.

	function enterMultiSelect(chatId: string) {
		if (isReorderMode) return;
		selection.enter(chatId);
	}

	function handleMultiSelectToggle(chatId: string, shiftKey: boolean) {
		if (shiftKey) {
			const allVisibleIds = searchState.filteredChats.map((c) => c.id);
			selection.selectRange(allVisibleIds, chatId);
		} else {
			selection.toggle(chatId);
		}
	}

	function handleSelectAll() {
		selection.selectAll(searchState.filteredChats.map((c) => c.id));
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
		const visibleIds = new Set(chats.map((c) => c.id));
		selection.pruneToVisible(visibleIds);
	});

	// Authoritative list of selected chats that still exist in the current
	// chat list. All display counts and actions derive from this.
	let selectedChats = $derived.by(() => {
		if (!selection.isActive) return [];
		return chats.filter((c) => selection.isSelected(c.id));
	});

	let bulkShowPin = $derived(selectedChats.some((c) => !c.isPinned));
	let bulkShowUnpin = $derived(selectedChats.some((c) => c.isPinned));
	let bulkShowArchive = $derived(selectedChats.some((c) => !c.isArchived));
	let bulkShowUnarchive = $derived(selectedChats.some((c) => c.isArchived));

	async function handleBulkPin() {
		const ids = selectedChats.filter((c) => !c.isPinned).map((c) => c.id);
		if (ids.length === 0) return;
		isBulkOperating = true;
		try {
			await controller.bulkTogglePin(ids);
		} catch (error) {
			console.error('Failed to bulk pin:', error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	async function handleBulkUnpin() {
		const ids = selectedChats.filter((c) => c.isPinned).map((c) => c.id);
		if (ids.length === 0) return;
		isBulkOperating = true;
		try {
			await controller.bulkTogglePin(ids);
		} catch (error) {
			console.error('Failed to bulk unpin:', error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	async function handleBulkArchive() {
		const ids = selectedChats.filter((c) => !c.isArchived).map((c) => c.id);
		if (ids.length === 0) return;
		const isSelectedChatInBulk = selectedChatId && ids.includes(selectedChatId);
		isBulkOperating = true;
		try {
			await controller.bulkToggleArchive(ids);
			if (isSelectedChatInBulk) {
				const remaining = chats.find((c) => !ids.includes(c.id) && !c.isArchived);
				if (remaining) onChatSelect(remaining.id);
				else onNewChat();
			}
		} catch (error) {
			console.error('Failed to bulk archive:', error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	async function handleBulkUnarchive() {
		const ids = selectedChats.filter((c) => c.isArchived).map((c) => c.id);
		if (ids.length === 0) return;
		isBulkOperating = true;
		try {
			await controller.bulkToggleArchive(ids);
		} catch (error) {
			console.error('Failed to bulk unarchive:', error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	function handleBulkDeleteRequest() {
		const ids = selectedChats.map((c) => c.id);
		const titles = selectedChats.map((c) => c.title || m.sidebar_chats_unnamed());
		bulkDeleteConfirmation = { chatIds: ids, chatTitles: titles };
	}

	async function confirmBulkDelete() {
		if (!bulkDeleteConfirmation) return;
		const ids = bulkDeleteConfirmation.chatIds;
		bulkDeleteConfirmation = null;
		const isSelectedChatInBulk = selectedChatId && ids.includes(selectedChatId);
		// Resolve the surviving neighbor before the optimistic removal runs.
		const remainingSelection = isSelectedChatInBulk
			? chats.find((c) => !ids.includes(c.id))?.id ?? null
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
			console.error('Failed to bulk delete:', error);
		} finally {
			isBulkOperating = false;
			selection.exit();
		}
	}

	// Exits multi-select on Escape key.
	function handleSidebarKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && selection.isActive) {
			e.stopPropagation();
			selection.exit();
		}
	}

	// Exits multi-select when entering reorder mode.
	function enterReorderModeClean() {
		if (selection.isActive) selection.exit();
		enterReorderMode();
	}

	async function handleForkChat(sourceChatId: string) {
		try {
			const resultChatId = await controller.forkChat(sourceChatId);
			onChatSelect(resultChatId);
		} catch (error) {
			console.error('Failed to fork chat:', error);
		}
	}

	async function handleMarkAllRead() {
		if (isMarkingAllRead || visibleUnreadChatIds.length === 0) return;
		isMarkingAllRead = true;
		try {
			await readReceiptOutbox.markChatsReadNow(visibleUnreadChatIds);
		} catch (error) {
			console.error('Failed to mark chats read:', error);
		} finally {
			isMarkingAllRead = false;
		}
	}

	// Search dialog actions.

	function handleSearchSelectChat(chatId: string) {
		searchState.confirmSearchDialog();
		onChatSelect(chatId);
	}

	function handleApplySavedSearch(search: SavedChatSearch) {
		searchState.updateDraftQuery(search.query);
	}

	function handleApplySidebarMenuSearch(query: string) {
		searchState.applyQuery(query);
	}

	function handleApplySidebarPillSearch(search: SavedChatSearch) {
		searchState.applyQuery(search.query);
	}

	function handleClearActiveQuery() {
		searchState.applyQuery('');
	}

	function openSavedSearchManagerFromSearchDialog() {
		searchState.suspendSearchDialog();
		savedSearchManagerOrigin = 'search-dialog';
		searchState.manageSavedSearchesOpen = true;
	}

	function closeSavedSearchManager() {
		searchState.manageSavedSearchesOpen = false;
		if (savedSearchManagerOrigin === 'search-dialog') {
			searchState.resumeSearchDialog();
		}
		savedSearchManagerOrigin = null;
	}

	function openEditorForCreate() {
		searchState.manageSavedSearchesOpen = false;
		savedSearchEditorOrigin = 'manager';
		editorState = {
			mode: 'create',
			title: '',
			query: searchState.draftQuery,
			showAsSidebarPill: false,
			showInSidebarMenu: false,
			showInSearchDialog: true,
		};
	}

	function openEditorForCreateFromSearchDialog() {
		searchState.suspendSearchDialog();
		savedSearchEditorOrigin = 'search-dialog';
		editorState = {
			mode: 'create',
			title: '',
			query: searchState.draftQuery,
			showAsSidebarPill: false,
			showInSidebarMenu: false,
			showInSearchDialog: true,
		};
	}

	function openEditorForEdit(search: SavedChatSearch) {
		searchState.manageSavedSearchesOpen = false;
		savedSearchEditorOrigin = 'manager';
		editorState = {
			mode: 'edit',
			searchId: search.id,
			title: search.title || '',
			query: search.query,
			showAsSidebarPill: search.showAsSidebarPill,
			showInSidebarMenu: search.showInSidebarMenu,
			showInSearchDialog: search.showInSearchDialog,
		};
	}

	function restoreSavedSearchEditorOrigin() {
		const origin = savedSearchEditorOrigin;
		savedSearchEditorOrigin = null;
		if (origin === 'manager') {
			searchState.manageSavedSearchesOpen = true;
			return;
		}
		if (origin === 'search-dialog') {
			searchState.resumeSearchDialog();
		}
	}

	async function handleSaveSearchEditor(
		data: {
			title: string | null;
			query: string;
			showAsSidebarPill: boolean;
			showInSidebarMenu: boolean;
			showInSearchDialog: boolean;
		},
		searchId?: string
	) {
		if (searchId) {
			const res = await updateSavedSearchApi(searchId, data);
			searchState.setSavedSearches(
				searchState.savedSearches.map((s) => s.id === searchId ? res.savedSearch : s)
			);
		} else {
			const res = await createSavedSearch(data);
			searchState.setSavedSearches([...searchState.savedSearches, res.savedSearch]);
		}
		editorState = null;
		restoreSavedSearchEditorOrigin();
	}

	function requestDeleteSavedSearch(id: string) {
		savedSearchDeleteConfirmation = { id };
	}

	async function confirmDeleteSavedSearch() {
		if (!savedSearchDeleteConfirmation) return;
		const { id } = savedSearchDeleteConfirmation;
		savedSearchDeleteConfirmation = null;
		try {
			await deleteSavedSearchApi(id);
			searchState.setSavedSearches(searchState.savedSearches.filter((s) => s.id !== id));
		} catch (error) {
			console.error('Failed to delete saved search:', error);
		}
	}

	async function handleReorderSavedSearches(oldOrder: string[], newOrder: string[]) {
		// Optimistically reorder locally.
		const byId = new Map(searchState.savedSearches.map((s) => [s.id, s]));
		searchState.setSavedSearches(newOrder.map((id) => byId.get(id)!).filter(Boolean));
		try {
			await reorderSavedSearchesApi(oldOrder, newOrder);
		} catch (error) {
			console.error('Failed to reorder saved searches:', error);
			// Rollback on failure.
			searchState.setSavedSearches(oldOrder.map((id) => byId.get(id)!).filter(Boolean));
		}
	}

	// Lifecycle.

	onMount(async () => {
		try {
			const res = await getSavedSearches();
			searchState.setSavedSearches(res.savedSearches);
		} catch (err) {
			console.error('Failed to load saved searches:', err);
		}
	});

	onMount(() => appShell.onRenameSelectedChatRequested(() => {
		if (!selectedChatId) return;
		const selected = chats.find((chat) => chat.id === selectedChatId);
		if (!selected) return;
		startRenameChat(selected.id, selected.title || m.sidebar_chats_new_chat());
	}));

	onMount(() => appShell.onDeleteSelectedChatRequested(() => {
		if (!selectedChatId) return;
		const selected = chats.find((chat) => chat.id === selectedChatId);
		if (!selected) return;
		showDeleteConfirmation(selected.id, selected.title || m.sidebar_chats_new_chat(), selected.agentId);
	}));

	onMount(() => appShell.onSidebarSearchRequested(() => {
		searchState.toggleSearchDialog();
	}));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -- keydown on container for Escape handling -->
<div class="h-full flex flex-col bg-card md:select-none relative" onkeydown={handleSidebarKeydown}>
	<div class="order-1 flex-shrink-0">
		<SidebarSearchDock
			{isLoading}
			{isReorderMode}
			visibleUnreadCount={visibleUnreadChatIds.length}
			{isMarkingAllRead}
			sidebarMenuSearches={searchState.sidebarMenuSearches}
			sidebarPillSearches={searchState.sidebarPillSearches}
			activeQuery={searchState.activeQuery}
			onOpenSearchDialog={() => searchState.openSearchDialog()}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => { void handleMarkAllRead(); }}
			onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			onApplyPillSearch={handleApplySidebarPillSearch}
			onClearActiveQuery={handleClearActiveQuery}
			primaryLabel={isReorderMode ? m.sidebar_actions_done_reordering() : undefined}
			{onShowSettings}
		/>
	</div>

	<div class="order-2 flex min-h-0 flex-1">
		<SidebarContent
			{chats}
			filteredChats={searchState.filteredChats}
			{selectedChatId}
			{isLoading}
			{currentTime}
			searchFilter={searchState.activeQuery}
			{isReorderMode}
			isMultiSelectMode={selection.isActive}
			isMultiSelected={(id) => selection.isSelected(id)}
			onEnterReorderMode={enterReorderModeClean}
			onEnterMultiSelect={enterMultiSelect}
			onMultiSelectToggle={handleMultiSelectToggle}
			onReorderGroup={handleReorderGroup}
			onChatSelect={handleChatClick}
			onDeleteChat={showDeleteConfirmation}
			onStartRenameChat={startRenameChat}
			onTogglePinned={(id) => { void handleTogglePinned(id); }}
			onToggleArchive={(id) => { void handleToggleArchive(id); }}
			onShowDetails={showChatDetails}
			onForkChat={(id) => { void handleForkChat(id); }}
			onShareChat={(id, title) => { shareChatDialog = { chatId: id, chatTitle: title }; }}
			onTagClick={handleTagClick}
			onManageTags={showTagDialog}
			onImmediateReorder={handleImmediateReorder}
			onQuickMove={handleQuickMove}
		/>
	</div>

	{#if selection.isActive}
		<SidebarSelectionBar
			count={selectedChats.length}
			totalVisible={searchState.filteredChats.length}
			showPin={bulkShowPin}
			showUnpin={bulkShowUnpin}
			showArchive={bulkShowArchive}
			showUnarchive={bulkShowUnarchive}
			isOperating={isBulkOperating}
			onSelectAll={handleSelectAll}
			onDeselectAll={handleDeselectAll}
			onPin={() => { void handleBulkPin(); }}
			onUnpin={() => { void handleBulkUnpin(); }}
			onArchive={() => { void handleBulkArchive(); }}
			onUnarchive={() => { void handleBulkUnarchive(); }}
			onDelete={handleBulkDeleteRequest}
			onDone={exitMultiSelect}
		/>
	{/if}
</div>

<SidebarChatDialogs
	{chatDeleteConfirmation}
	onCancelDelete={() => chatDeleteConfirmation = null}
	onConfirmDelete={confirmDeleteChat}
	{chatRenameConfirmation}
	onCancelRename={() => chatRenameConfirmation = null}
	onConfirmRename={confirmRenameChat}
	{chatDetailsDialog}
	onCloseDetails={closeChatDetails}
/>

<!-- Bulk delete confirmation dialog -->
<Dialog.Root open={bulkDeleteConfirmation !== null} onOpenChange={(open) => { if (!open) bulkDeleteConfirmation = null; }}>
	<Dialog.Content>
		<Dialog.Header class="min-w-0">
			<Dialog.Title>{m.sidebar_select_delete_confirm_title({ count: bulkDeleteConfirmation?.chatIds.length ?? 0 })}</Dialog.Title>
			<Dialog.Description class="min-w-0 max-w-full">
				<span class="block text-sm text-muted-foreground mb-2">{m.sidebar_select_delete_confirm_description()}</span>
				{#if bulkDeleteConfirmation}
					<ul class="list-disc pl-4 space-y-0.5 text-sm text-foreground max-h-32 overflow-y-auto">
						{#each bulkDeleteConfirmation.chatTitles.slice(0, 5) as title}
							<li class="truncate">{title}</li>
						{/each}
						{#if bulkDeleteConfirmation.chatTitles.length > 5}
							<li class="text-muted-foreground italic">{m.sidebar_select_delete_confirm_and_more({ count: bulkDeleteConfirmation.chatTitles.length - 5 })}</li>
						{/if}
					</ul>
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => bulkDeleteConfirmation = null}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="destructive" onclick={() => { void confirmBulkDelete(); }}>{m.sidebar_actions_delete()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<SidebarTagDialog
	{tagDialog}
	allKnownTags={searchState.allKnownTags}
	onClose={() => tagDialog = null}
	onSave={handleSaveTags}
/>

	<SidebarSearchDialog
		open={searchState.searchDialogOpen}
		query={searchState.draftQuery}
		filteredChats={searchState.dialogFilteredChats}
		savedSearches={searchState.searchDialogSavedSearches}
		{currentTime}
		highlightedIndex={searchState.highlightedResultIndex}
		onQueryChange={(q) => searchState.updateDraftQuery(q)}
		onSelectChat={handleSearchSelectChat}
		onApplySavedSearch={handleApplySavedSearch}
		onOpenManager={openSavedSearchManagerFromSearchDialog}
		onCreateSavedSearch={openEditorForCreateFromSearchDialog}
		onHighlightChange={(i) => { searchState.highlightedResultIndex = i; }}
		onClose={() => searchState.closeSearchDialog()}
/>

<SavedSearchManagerDialog
	open={searchState.manageSavedSearchesOpen}
	searches={searchState.savedSearches}
	onClose={closeSavedSearchManager}
	onAdd={openEditorForCreate}
	onEdit={openEditorForEdit}
	onDelete={requestDeleteSavedSearch}
	onReorder={handleReorderSavedSearches}
/>

<SavedSearchEditorDialog
	{editorState}
	onClose={() => {
		editorState = null;
		restoreSavedSearchEditorOrigin();
	}}
	onSave={handleSaveSearchEditor}
/>

<ShareChatDialog
	chatId={shareChatDialog?.chatId ?? null}
	chatTitle={shareChatDialog?.chatTitle ?? ''}
	onClose={() => { shareChatDialog = null; }}
/>

<Dialog.Root open={savedSearchDeleteConfirmation !== null} onOpenChange={(open) => { if (!open) savedSearchDeleteConfirmation = null; }}>
	<Dialog.Content onOpenAutoFocus={(e) => { e.preventDefault(); savedSearchDeleteButtonRef?.focus(); }}>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_saved_searches_confirm_delete()}</Dialog.Title>
			<Dialog.Description>{m.sidebar_saved_searches_confirm_delete_description()}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => savedSearchDeleteConfirmation = null}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="destructive" onclick={() => { void confirmDeleteSavedSearch(); }} bind:ref={savedSearchDeleteButtonRef}>{m.sidebar_actions_delete()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
