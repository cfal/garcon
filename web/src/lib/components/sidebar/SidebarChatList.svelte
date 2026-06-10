<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Search from '@lucide/svelte/icons/search';
	import SidebarVirtualSortableChatList from './SidebarVirtualSortableChatList.svelte';
	import {
		SidebarChatReorderState,
		type SidebarChatOrderMap,
		type SidebarChatReorderRequest,
	} from './sidebar-chat-reorder-state.svelte';
	import type { SidebarVirtualChatRow } from './sidebar-virtual-chat-list';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';

	interface SidebarChatListProps {
		viewportRef?: HTMLElement | null;
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, chatTitle: string, agentId: SessionAgentId) => void;
		onStartRenameChat: (chatId: string, currentName: string) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, chatTitle: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onQuickMove: (
			list: ChatOrderList,
			chatId: string,
			target: ReorderQuickTarget,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
	}

	let {
		viewportRef = null,
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		isMultiSelectMode = false,
		isMultiSelected,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onQuickMove,
	}: SidebarChatListProps = $props();

	let showChats = $derived(!isLoading && chats.length > 0 && filteredChats.length > 0);
	let isFiltered = $derived(searchFilter.trim().length > 0);

	let allPartitioned = $derived.by(() => partitionChats(chats));
	let filteredPartitioned = $derived.by(() => partitionChats(filteredChats));

	let hasPinnedChats = $derived(allPartitioned.hasPinned);
	let pinnedAll = $derived(allPartitioned.pinned);
	let normalAll = $derived(allPartitioned.normal);
	let archivedAll = $derived(allPartitioned.archived);
	let pinnedFiltered = $derived(filteredPartitioned.pinned);
	let normalFiltered = $derived(filteredPartitioned.normal);
	let archivedFiltered = $derived(filteredPartitioned.archived);
	let displayedPinned = $derived(isFiltered ? pinnedFiltered : pinnedAll);
	let displayedNormal = $derived(isFiltered ? normalFiltered : normalAll);
	let displayedArchived = $derived(isFiltered ? archivedFiltered : archivedAll);

	let pinnedById = $derived(new Map(pinnedAll.map((chat) => [chat.id, chat])));
	let normalById = $derived(new Map(normalAll.map((chat) => [chat.id, chat])));
	let archivedById = $derived(new Map(archivedAll.map((chat) => [chat.id, chat])));
	let visibleOrders = $derived<SidebarChatOrderMap>({
		pinned: displayedPinned.map((chat) => chat.id),
		normal: displayedNormal.map((chat) => chat.id),
		archived: displayedArchived.map((chat) => chat.id),
	});

	const reorder = new SidebarChatReorderState({
		get visibleOrders() { return visibleOrders; },
	});

	let virtualRows = $derived.by(() => toVirtualRows(
		reorder.orderFor('pinned'),
		reorder.orderFor('normal'),
		reorder.orderFor('archived'),
	));

	$effect(() => {
		reorder.reconcile();
	});

	function partitionChats(source: ChatSessionRecord[]) {
		const pinned: ChatSessionRecord[] = [];
		const normal: ChatSessionRecord[] = [];
		const archived: ChatSessionRecord[] = [];
		for (const chat of source) {
			if (chat.isPinned) pinned.push(chat);
			else if (chat.isArchived) archived.push(chat);
			else normal.push(chat);
		}
		return { pinned, normal, archived, hasPinned: pinned.length > 0 };
	}

	function chatById(list: ChatOrderList, chatId: string): ChatSessionRecord | undefined {
		if (list === 'pinned') return pinnedById.get(chatId);
		if (list === 'archived') return archivedById.get(chatId);
		return normalById.get(chatId);
	}

	function addRows(
		rows: SidebarVirtualChatRow[],
		list: ChatOrderList,
		order: string[],
		isPinned: boolean,
		isArchived: boolean,
	): void {
		for (const chatId of order) {
			const chat = chatById(list, chatId);
			if (!chat) continue;
			rows.push({
				type: 'chat',
				key: `${list}:${chat.id}`,
				chat,
				list,
				isPinned,
				isArchived,
			});
		}
	}

	function toVirtualRows(
		pinnedOrder: string[],
		normalOrder: string[],
		archivedOrder: string[],
	): SidebarVirtualChatRow[] {
		const rows: SidebarVirtualChatRow[] = [];
		addRows(rows, 'pinned', pinnedOrder, true, false);
		addRows(rows, 'normal', normalOrder, false, false);
		addRows(rows, 'archived', archivedOrder, false, true);
		return rows;
	}

	function persistReorderRequest(request: SidebarChatReorderRequest | null): void {
		if (!request) return;
		onQuickMove(
			request.list,
			request.chatId,
			request.target,
			() => reorder.completeIfCurrent(request.list, request.sequence),
			() => reorder.rollbackIfCurrent(request.list, request.sequence, request.visibleOrder),
		);
	}
</script>

{#if isLoading}
	<div class="flex h-full items-center justify-center px-4">
		<div class="w-full max-w-xs text-center">
			<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
				<div class="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"></div>
			</div>
			<h3 class="mb-2 text-base font-medium text-foreground md:mb-1">{m.sidebar_chats_loading_chats()}</h3>
			<p class="text-sm text-muted-foreground">{m.sidebar_chats_fetching_chats()}</p>
		</div>
	</div>
{:else if !showChats}
	<div class="px-4 py-12 text-center md:py-8">
		<div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
			<Search class="h-6 w-6 text-muted-foreground" />
		</div>
		<h3 class="mb-2 text-base font-medium text-foreground md:mb-1">{m.sidebar_chats_no_matching_chats()}</h3>
		<p class="text-sm text-muted-foreground">{m.sidebar_chats_try_different_search()}</p>
	</div>
{:else}
	<SidebarVirtualSortableChatList
		rows={virtualRows}
		{viewportRef}
		{selectedChatId}
		{currentTime}
		{isMobile}
		{isFiltered}
		{isMultiSelectMode}
		{isMultiSelected}
		{reorder}
		onPersistReorder={persistReorderRequest}
		{onChatSelect}
		{onDeleteChat}
		{onStartRenameChat}
		{onTogglePinned}
		{onToggleArchive}
		{onShowDetails}
		{onForkChat}
		{onShareChat}
		{onTagClick}
		{onManageTags}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{hasPinnedChats}
	/>
{/if}
