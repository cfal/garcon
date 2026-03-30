<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarFooter from './SidebarFooter.svelte';
	import SidebarChatDialogs from './SidebarChatDialogs.svelte';
	import SidebarTagDialog from './SidebarTagDialog.svelte';
	import SidebarSaveFolderDialog from './SidebarSaveFolderDialog.svelte';
	import { getAppShell, getReadReceiptOutbox } from '$lib/context';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { reorderChats } from '$lib/api/chats.js';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import { createReorderWriteQueue } from './reorder-write-queue';
	import { SidebarController } from './sidebar-controller.svelte';
	import { SidebarFilterState, type FolderEntry } from './sidebar-filter-state.svelte';
	import { addTagToQuery, matchesChatFilter } from './sidebar-search';
	import { getFolders, createFolder, updateFolder as updateFolderApi, deleteFolder as deleteFolderApi, type ChatFolder, type ChatFolderFilter } from '$lib/api/settings';
	import type { FolderDialogState } from './SidebarSaveFolderDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

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

	// FolderDialogState is imported from SidebarSaveFolderDialog

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

	const filterState = new SidebarFilterState({
		get chats() { return chats; },
	});

	// Sidebar UI state.
	let chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	let chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	let chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	let tagDialog = $state<{ chatId: string; chatTitle: string; tags: string[] } | null>(null);
	let saveFolderDialog = $state<FolderDialogState | null>(null);
	let folderDeleteConfirmation = $state<{ id: string; name: string } | null>(null);
	let currentTime = $state(new Date());
	let isMarkingAllRead = $state(false);
	let visibleUnreadChatIds = $derived.by(() =>
		filterState.filteredChats
			.filter((chat) => chat.isUnread && Boolean(chat.lastActivityAt))
			.map((chat) => chat.id)
	);
	let createFolderHint = $derived(
		filterState.canSaveCurrentFilter
			? m.sidebar_folders_save_current_filter()
			: m.sidebar_folders_save_disabled_hint()
	);
	let folderCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const folder of filterState.folders) {
			if (!folder.filter) continue;
			const count = chats.filter(chat => matchesChatFilter(chat, folder.filter!)).length;
			counts.set(folder.id, count);
		}
		return counts;
	});

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
		filterState.searchQuery = addTagToQuery(filterState.searchQuery, tag);
	}

	async function handleSaveTags(chatId: string, tags: string[]) {
		await controller.updateTags(chatId, tags);
		tagDialog = null;
	}

	// Reorder mode state.
	let isReorderMode = $state(false);
	let pendingReorder = $state<{ list: ChatOrderList; oldOrder: string[]; newOrder: string[] } | null>(null);

	function enterReorderMode() {
		filterState.searchQuery = '';
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

	// Stores local draft order on each drag; persisted on exit.
	function handleReorderGroup(list: ChatOrderList, oldOrder: string[], newOrder: string[]) {
		pendingReorder = { list, oldOrder, newOrder };
	}

	// Fire-and-forget persist for normal-mode inline drags.
	// Serializes writes and coalesces by list so rapid drag bursts
	// do not race against each other after heavy list churn.
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

	// Quick reorder for context menu actions.
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

	function handleSelectFolder(id: string) {
		filterState.selectFolder(id);
	}

	function cloneFilter(filter: ChatFolderFilter): ChatFolderFilter {
		return {
			textTokens: [...filter.textTokens],
			tags: [...filter.tags],
			providers: [...filter.providers],
			models: [...filter.models],
			...(filter.status ? { status: filter.status } : {}),
		};
	}

	function suggestFolderName(filter: ChatFolderFilter): string {
		const trimmedSearch = filterState.searchQuery.trim();
		if (trimmedSearch) return trimmedSearch;
		if (filterState.selectedFolderId !== 'all') return filterState.selectedFolder.name;
		if (filter.tags.length === 1) return `tag:${filter.tags[0]}`;
		if (filter.providers.length === 1) return `provider:${filter.providers[0]}`;
		if (filter.models.length === 1) return `model:${filter.models[0]}`;
		if (filter.textTokens.length > 0) return filter.textTokens.join(' ');
		return m.sidebar_folders_new_folder();
	}

	function mergeUserFolders(existing: ChatFolder[], incoming: ChatFolder[]): ChatFolder[] {
		const incomingIds = new Set(incoming.map((folder) => folder.id));
		return [...incoming, ...existing.filter((folder) => !incomingIds.has(folder.id))];
	}

	function handleCreateFolder() {
		if (!filterState.canSaveCurrentFilter) return;
		const filter = cloneFilter(filterState.currentFilter);
		saveFolderDialog = {
			mode: 'create',
			filter,
			suggestedName: suggestFolderName(filter),
		};
	}

	function handleEditFolder(folder: FolderEntry) {
		if (!folder.filter) return;
		saveFolderDialog = {
			mode: 'edit',
			folderId: folder.id,
			filter: cloneFilter(folder.filter as ChatFolderFilter),
			suggestedName: folder.name,
		};
	}

	async function handleSaveFolder(name: string, filter: ChatFolderFilter, folderId?: string) {
		if (folderId) {
			const res = await updateFolderApi(folderId, { name, filter });
			filterState.setUserFolders(
				filterState.userFolders.map(f => f.id === folderId ? res.folder : f)
			);
		} else {
			const res = await createFolder(name, filter);
			filterState.setUserFolders(mergeUserFolders(filterState.userFolders, [res.folder]));
			filterState.searchQuery = '';
			filterState.selectFolder(res.folder.id);
		}
		saveFolderDialog = null;
	}

	function showFolderDeleteConfirmation(id: string) {
		const folder = filterState.folders.find(f => f.id === id);
		if (!folder) return;
		folderDeleteConfirmation = { id, name: folder.name };
	}

	async function confirmDeleteFolder() {
		if (!folderDeleteConfirmation) return;
		const { id } = folderDeleteConfirmation;
		folderDeleteConfirmation = null;
		await handleDeleteFolder(id);
	}

	async function handleDeleteFolder(id: string) {
		try {
			await deleteFolderApi(id);
			filterState.setUserFolders(filterState.userFolders.filter((f) => f.id !== id));
			if (filterState.selectedFolderId === id) {
				filterState.selectFolder('all');
			}
		} catch (err) {
			console.error('Failed to delete folder:', err);
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

	onMount(async () => {
		try {
			const res = await getFolders();
			filterState.setUserFolders(mergeUserFolders(filterState.userFolders, res.folders));
		} catch (err) {
			console.error('Failed to load folders:', err);
		}
	});

	onMount(() => appShell.onRenameSelectedChatRequested(() => {
		if (!selectedChatId) return;
		const selected = chats.find((chat) => chat.id === selectedChatId);
		if (!selected) return;
		startRenameChat(selected.id, selected.title || m.sidebar_chats_new_chat());
	}));
</script>

<div class="h-full flex flex-col bg-card md:select-none">
	<SidebarContent
		{chats}
		filteredChats={filterState.filteredChats}
		{selectedChatId}
		{isLoading}
		{currentTime}
		searchFilter={filterState.searchQuery}
		{isReorderMode}
		folders={filterState.folders}
		selectedFolderId={filterState.selectedFolderId}
		canCreateFolder={filterState.canSaveCurrentFilter}
		{createFolderHint}
		onSelectFolder={handleSelectFolder}
		onCreateFolder={() => handleCreateFolder()}
		onDeleteFolder={showFolderDeleteConfirmation}
		onEditFolder={handleEditFolder}
		{folderCounts}
		onEnterReorderMode={enterReorderMode}
		onReorderGroup={handleReorderGroup}
		onChatSelect={handleChatClick}
		onDeleteChat={showDeleteConfirmation}
		onStartRenameChat={startRenameChat}
		onTogglePinned={(id) => { void handleTogglePinned(id); }}
		onToggleArchive={(id) => { void handleToggleArchive(id); }}
		onShowDetails={showChatDetails}
		onForkChat={(id) => { void handleForkChat(id); }}
		onTagClick={handleTagClick}
		onManageTags={showTagDialog}
		onImmediateReorder={handleImmediateReorder}
		onQuickMove={handleQuickMove}
	/>

		<SidebarFooter
			{isLoading}
			searchFilter={filterState.searchQuery}
			{isReorderMode}
			visibleUnreadCount={visibleUnreadChatIds.length}
			{isMarkingAllRead}
			onSearchFilterChange={(v) => filterState.searchQuery = v}
			onClearSearchFilter={() => filterState.searchQuery = ''}
			onCreateChat={handlePrimaryAction}
			onMarkAllRead={() => { void handleMarkAllRead(); }}
			primaryLabel={isReorderMode ? m.sidebar_actions_done_reordering() : undefined}
			{onShowSettings}
		/>
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
	allKnownTags={filterState.allKnownTags}
	onClose={() => tagDialog = null}
	onSave={handleSaveTags}
/>

<SidebarSaveFolderDialog
	{saveFolderDialog}
	onClose={() => saveFolderDialog = null}
	onSave={handleSaveFolder}
/>

<Dialog.Root open={folderDeleteConfirmation !== null} onOpenChange={(open) => { if (!open) folderDeleteConfirmation = null; }}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.sidebar_folders_confirm_delete({ name: folderDeleteConfirmation?.name ?? '' })}</Dialog.Title>
			<Dialog.Description>{m.sidebar_folders_confirm_delete_description()}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => folderDeleteConfirmation = null}>{m.sidebar_actions_cancel()}</Button>
			<Button variant="destructive" onclick={() => { void confirmDeleteFolder(); }}>{m.sidebar_actions_delete()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
