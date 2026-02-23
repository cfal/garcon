<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarContent from './SidebarContent.svelte';
	import SidebarFooter from './SidebarFooter.svelte';
	import SidebarChatDialogs from './SidebarChatDialogs.svelte';
	import { getAppShell } from '$lib/context';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import { togglePinned, toggleArchive, reorderChats, reorderChatsQuick, getChatDetails, forkChat } from '$lib/api/chats.js';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import { createReorderWriteQueue } from './reorder-write-queue';
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

	// Sidebar controller state (inlined from useSidebarController).
	let searchFilter = $state('');
	let chatDeleteConfirmation = $state<ChatDeleteConfirmation | null>(null);
	let chatRenameConfirmation = $state<ChatRenameConfirmation | null>(null);
	let chatDetailsDialog = $state<ChatDetailsDialog | null>(null);
	let currentTime = $state(new Date());

	// Refresh timestamp every minute.
	$effect(() => {
		const timer = setInterval(() => {
			currentTime = new Date();
		}, 60_000);
		return () => clearInterval(timer);
	});

	let filteredChats = $derived.by(() => {
		const q = searchFilter.trim().toLowerCase();
		if (!q) return chats;
		return chats.filter((s) => {
			const title = (s.title || '').toLowerCase();
			const path = (s.projectPath || '').toLowerCase();
			return title.includes(q) || path.includes(q);
		});
	});

	function handleChatClick(chatId: string) {
		onChatSelect(chatId);
	}

	async function handleTogglePinned(chatId: string) {
		const chat = chats.find((s) => s.id === chatId);
		const wasPinned = chat?.isPinned === true;
		try {
			await togglePinned(chatId);
			await onQuietRefresh();
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
			await toggleArchive(chatId);
			await onQuietRefresh();
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
				const details = await getChatDetails(chatId);
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

	// Reorder mode state.
	let isReorderMode = $state(false);
	let pendingReorder = $state<{ list: ChatOrderList; oldOrder: string[]; newOrder: string[] } | null>(null);

	function enterReorderMode() {
		searchFilter = '';
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
			await reorderChatsQuick({ chatId, chatIdAbove, chatIdBelow });
			await onQuietRefresh();
		} catch (error) {
			console.error('Failed to quick reorder:', error);
		}
	}

	async function handleForkChat(sourceChatId: string) {
		const newChatId = `${Date.now()}`;
		try {
			const result = await forkChat({ sourceChatId, chatId: newChatId });
			await onQuietRefresh();
			onChatSelect(result.chatId);
		} catch (error) {
			console.error('Failed to fork chat:', error);
		}
	}

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
		{filteredChats}
		{selectedChatId}
		{isLoading}
		{currentTime}
		{searchFilter}
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
		onImmediateReorder={handleImmediateReorder}
		onQuickMove={handleQuickMove}
	/>

		<SidebarFooter
			{isLoading}
			{searchFilter}
			{isReorderMode}
			onSearchFilterChange={(v) => searchFilter = v}
			onClearSearchFilter={() => searchFilter = ''}
			onCreateChat={handlePrimaryAction}
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
