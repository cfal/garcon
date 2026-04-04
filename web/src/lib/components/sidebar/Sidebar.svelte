<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarControlsRow from './SidebarControlsRow.svelte';
	import SidebarSearchContext from './SidebarSearchContext.svelte';
	import SidebarChatDialogs from './SidebarChatDialogs.svelte';
	import SidebarTagDialog from './SidebarTagDialog.svelte';
	import SidebarSearchDialog from './SidebarSearchDialog.svelte';
	import SavedSearchManagerDialog from './SavedSearchManagerDialog.svelte';
	import SavedSearchEditorDialog from './SavedSearchEditorDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import { getAppShell, getReadReceiptOutbox } from '$lib/context';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { reorderChats } from '$lib/api/chats.js';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import { createReorderWriteQueue } from './reorder-write-queue';
	import { SidebarController } from './sidebar-controller.svelte';
	import { SidebarSearchState } from './sidebar-search-state.svelte';
	import { addTagToQuery } from './sidebar-search';
	import {
		APP_SETTINGS_UPDATED_EVENT,
		getSavedSearches,
		createSavedSearch,
		updateSavedSearch as updateSavedSearchApi,
		deleteSavedSearch as deleteSavedSearchApi,
		reorderSavedSearches as reorderSavedSearchesApi,
		getSettings,
		normalizeSidebarSearchBarPosition,
		type AppSettingsUpdatedDetail,
		type SavedChatSearch,
	} from '$lib/api/settings';
	import type { SavedSearchEditorState } from './SavedSearchEditorDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarSearchBarPosition } from '$lib/types/session.js';

	interface ChatDeleteConfirmation {
		chatId: string;
		chatTitle: string;
		provider: SessionProvider;
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

	interface SidebarProps {
		chats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		onChatSelect: (chatId: string) => void;
		onNewChat: () => void;
		onChatDelete?: (chatId: string) => void;
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

	// Sidebar UI state.
	let chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	let chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	let chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	let tagDialog = $state<{ chatId: string; chatTitle: string; tags: string[] } | null>(null);
	let shareChatDialog = $state<{ chatId: string; chatTitle: string } | null>(null);
	let currentTime = $state(new Date());
	let isMarkingAllRead = $state(false);
	let searchBarPosition = $state<SidebarSearchBarPosition>('bottom');

	// Saved search management state.
	let editorState = $state<SavedSearchEditorState | null>(null);
	let savedSearchDeleteConfirmation = $state<{ id: string } | null>(null);
	let savedSearchDeleteButtonRef = $state<HTMLButtonElement | null>(null);

		let visibleUnreadChatIds = $derived.by(() =>
			searchState.filteredChats
				.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
				.map((chat) => chat.id)
		);
		let showSidebarSearchContext = $derived(
			searchState.sidebarPillSearches.length > 0 || searchState.hasActiveQuery
		);

	// Refresh timestamp every minute.
	$effect(() => {
		const timer = setInterval(() => {
			currentTime = new Date();
		}, 60_000);
		return () => clearInterval(timer);
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

	function showDeleteConfirmation(chatId: string, chatTitle: string, provider: SessionProvider) {
		chatDeleteConfirmation = { chatId, chatTitle, provider };
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

	function openSavedSearchManager() {
		searchState.suspendSearchDialog();
		searchState.manageSavedSearchesOpen = true;
	}

	function closeSavedSearchManager() {
		searchState.manageSavedSearchesOpen = false;
	}

	function openEditorForCreate() {
		searchState.manageSavedSearchesOpen = false;
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
		searchState.manageSavedSearchesOpen = true;
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
			const settings = await getSettings();
			searchBarPosition = normalizeSidebarSearchBarPosition(settings.ui?.searchBarPosition);
		} catch (err) {
			console.error('Failed to load sidebar settings:', err);
		}
	});

	onMount(() => {
		function handleAppSettingsUpdated(event: Event) {
			const detail = (event as CustomEvent<AppSettingsUpdatedDetail>).detail;
			const ui = detail?.patch?.ui;
			if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return;
			if (!Object.prototype.hasOwnProperty.call(ui, 'searchBarPosition')) return;
			searchBarPosition = normalizeSidebarSearchBarPosition(
				(ui as Record<string, unknown>).searchBarPosition,
			);
		}

		window.addEventListener(APP_SETTINGS_UPDATED_EVENT, handleAppSettingsUpdated as EventListener);
		return () => {
			window.removeEventListener(APP_SETTINGS_UPDATED_EVENT, handleAppSettingsUpdated as EventListener);
		};
	});

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

	onMount(() => appShell.onSidebarSearchRequested(() => {
			searchState.toggleSearchDialog();
	}));
</script>

<div class="h-full flex flex-col bg-card md:select-none">
	{#if searchBarPosition === 'top'}
			<SidebarControlsRow
				dockPlacement="top"
				{isLoading}
				{isReorderMode}
				visibleUnreadCount={visibleUnreadChatIds.length}
				{isMarkingAllRead}
				sidebarMenuSearches={searchState.sidebarMenuSearches}
				hasSearchContextBelow={showSidebarSearchContext}
				onOpenSearchDialog={() => searchState.openSearchDialog()}
				onOpenSavedSearchManager={openSavedSearchManager}
				onCreateChat={handlePrimaryAction}
				onMarkAllRead={() => { void handleMarkAllRead(); }}
				onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			primaryLabel={isReorderMode ? m.sidebar_actions_done_reordering() : undefined}
			{onShowSettings}
		/>
	{/if}

	<SidebarSearchContext
		sidebarPillSearches={searchState.sidebarPillSearches}
		activeQuery={searchState.activeQuery}
		hasControlsRowAbove={searchBarPosition === 'top'}
		onApplyPillSearch={handleApplySidebarPillSearch}
		onClearActiveQuery={handleClearActiveQuery}
	/>

	<SidebarContent
		{chats}
		filteredChats={searchState.filteredChats}
		{selectedChatId}
		{isLoading}
		{currentTime}
		searchFilter={searchState.activeQuery}
		{isReorderMode}
		onEnterReorderMode={enterReorderMode}
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

	{#if searchBarPosition === 'bottom'}
		<SidebarControlsRow
			dockPlacement="bottom"
			{isLoading}
			{isReorderMode}
			visibleUnreadCount={visibleUnreadChatIds.length}
			{isMarkingAllRead}
			sidebarMenuSearches={searchState.sidebarMenuSearches}
			onOpenSearchDialog={() => searchState.openSearchDialog()}
			onOpenSavedSearchManager={openSavedSearchManager}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => { void handleMarkAllRead(); }}
			onApplySidebarMenuSearch={handleApplySidebarMenuSearch}
			primaryLabel={isReorderMode ? m.sidebar_actions_done_reordering() : undefined}
			{onShowSettings}
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
		highlightedIndex={searchState.highlightedResultIndex}
		onQueryChange={(q) => searchState.updateDraftQuery(q)}
		onSelectChat={handleSearchSelectChat}
		onApplySavedSearch={handleApplySavedSearch}
		onOpenManager={openSavedSearchManager}
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
	onClose={() => { editorState = null; searchState.manageSavedSearchesOpen = true; }}
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
