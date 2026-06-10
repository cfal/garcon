<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import SidebarSortableChatRow from './SidebarSortableChatRow.svelte';
	import SidebarVirtualChatList from './SidebarVirtualChatList.svelte';
	import Search from '@lucide/svelte/icons/search';
	import { DragDropProvider, PointerSensor } from '@dnd-kit/svelte';
	import {
		arraysEqual,
		previewReorder,
		type DragEndLike,
	} from './drag-reorder';
	import {
		SidebarChatReorderState,
		type SidebarChatOrderMap,
		type SidebarChatReorderRequest,
	} from './sidebar-chat-reorder-state.svelte';
	import type { SidebarVirtualChatRow } from './sidebar-virtual-chat-list';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';

	const implicitDragSensors = [PointerSensor.configure({ preventActivation: () => false })];
	const VIRTUALIZATION_THRESHOLD = 80;

	interface SidebarChatListProps {
		viewportRef?: HTMLElement | null;
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		isReorderMode: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		onEnterReorderMode: () => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onReorderGroup: (list: ChatOrderList, oldOrder: string[], newOrder: string[]) => void;
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
		onImmediateReorder: (
			list: ChatOrderList,
			oldOrder: string[],
			newOrder: string[],
			onFailure?: () => void,
		) => void;
		onQuickMove: (chatId: string, target: ReorderQuickTarget) => Promise<void> | void;
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
		isReorderMode,
		isMultiSelectMode = false,
		isMultiSelected,
		onEnterReorderMode,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onReorderGroup,
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
		onImmediateReorder,
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
	let virtualRows = $derived.by(() => toVirtualRows(displayedPinned, displayedNormal, displayedArchived));
	let useVirtualList = $derived(!isFiltered && virtualRows.length > VIRTUALIZATION_THRESHOLD);

	let pinnedDraftOrder = $state<string[]>([]);
	let normalDraftOrder = $state<string[]>([]);
	let archivedDraftOrder = $state<string[]>([]);
	let draftSnapshotByList = $state<Partial<SidebarChatOrderMap>>({});

	let pinnedById = $derived(new Map(pinnedAll.map((chat) => [chat.id, chat])));
	let normalById = $derived(new Map(normalAll.map((chat) => [chat.id, chat])));
	let archivedById = $derived(new Map(archivedAll.map((chat) => [chat.id, chat])));
	let visibleOrders = $derived<SidebarChatOrderMap>({
		pinned: displayedPinned.map((chat) => chat.id),
		normal: displayedNormal.map((chat) => chat.id),
		archived: displayedArchived.map((chat) => chat.id),
	});

	const normalReorder = new SidebarChatReorderState({
		get visibleOrders() { return visibleOrders; },
		get isFiltered() { return isFiltered; },
	});

	$effect(() => {
		normalReorder.reconcile();
	});

	$effect(() => {
		if (isReorderMode) {
			pinnedDraftOrder = untrack(() => pinnedAll.map((chat) => chat.id));
			normalDraftOrder = untrack(() => normalAll.map((chat) => chat.id));
			archivedDraftOrder = untrack(() => archivedAll.map((chat) => chat.id));
			draftSnapshotByList = {};
		}
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

	function toVirtualRows(
		pinnedRows: ChatSessionRecord[],
		normalRows: ChatSessionRecord[],
		archivedRows: ChatSessionRecord[],
	): SidebarVirtualChatRow[] {
		const rows: SidebarVirtualChatRow[] = [];
		for (const chat of pinnedRows) {
			rows.push({
				type: 'chat',
				key: `pinned:${chat.id}`,
				chat,
				list: 'pinned',
				isPinned: true,
				isArchived: false,
			});
		}
		for (const chat of normalRows) {
			rows.push({
				type: 'chat',
				key: `normal:${chat.id}`,
				chat,
				list: 'normal',
				isPinned: false,
				isArchived: false,
			});
		}
		for (const chat of archivedRows) {
			rows.push({
				type: 'chat',
				key: `archived:${chat.id}`,
				chat,
				list: 'archived',
				isPinned: false,
				isArchived: true,
			});
		}
		return rows;
	}

	function getDraftOrder(list: ChatOrderList): string[] {
		if (list === 'pinned') return pinnedDraftOrder;
		if (list === 'archived') return archivedDraftOrder;
		return normalDraftOrder;
	}

	function setDraftOrder(list: ChatOrderList, order: string[]): void {
		if (list === 'pinned') pinnedDraftOrder = order;
		else if (list === 'archived') archivedDraftOrder = order;
		else normalDraftOrder = order;
	}

	function chatById(list: ChatOrderList, chatId: string): ChatSessionRecord | undefined {
		if (list === 'pinned') return pinnedById.get(chatId);
		if (list === 'archived') return archivedById.get(chatId);
		return normalById.get(chatId);
	}

	function moveToTop(list: ChatOrderList, chatId: string): void {
		const draft = getDraftOrder(list);
		const idx = draft.indexOf(chatId);
		if (idx <= 0) return;
		const next = [chatId, ...draft.filter((id) => id !== chatId)];
		setDraftOrder(list, next);
		onReorderGroup(list, draft, next);
	}

	function moveToBottom(list: ChatOrderList, chatId: string): void {
		const draft = getDraftOrder(list);
		const idx = draft.indexOf(chatId);
		if (idx < 0 || idx === draft.length - 1) return;
		const next = [...draft.filter((id) => id !== chatId), chatId];
		setDraftOrder(list, next);
		onReorderGroup(list, draft, next);
	}

	function handleDraftDragStart(list: ChatOrderList): void {
		draftSnapshotByList = {
			...draftSnapshotByList,
			[list]: [...getDraftOrder(list)],
		};
	}

	function handleDraftDragOver(list: ChatOrderList, event: DragEndLike): void {
		const current = getDraftOrder(list);
		const next = previewReorder(event, current);
		if (!next || arraysEqual(next, current)) return;
		setDraftOrder(list, next);
	}

	function handleDraftDragEnd(list: ChatOrderList, event: DragEndLike): void {
		const snapshot = draftSnapshotByList[list] ?? getDraftOrder(list);
		const current = getDraftOrder(list);
		const nextSnapshots = { ...draftSnapshotByList };
		delete nextSnapshots[list];
		draftSnapshotByList = nextSnapshots;

		if (event.canceled) {
			setDraftOrder(list, snapshot);
			return;
		}

		const finalOrder = arraysEqual(snapshot, current)
			? (previewReorder(event, current) ?? current)
			: current;
		if (arraysEqual(snapshot, finalOrder)) return;
		setDraftOrder(list, finalOrder);
		onReorderGroup(list, snapshot, finalOrder);
	}

	function handleNormalDragEnd(list: ChatOrderList, event: DragEndLike): void {
		persistReorderRequest(normalReorder.finish(list, event));
	}

	function persistReorderRequest(request: SidebarChatReorderRequest | null): void {
		if (!request) return;
		if (request.kind === 'window') {
			onImmediateReorder(
				request.list,
				request.oldOrder,
				request.newOrder,
				() => normalReorder.rollbackIfCurrent(request.list, request.newOrder),
			);
			return;
		}

		void Promise.resolve(onQuickMove(request.chatId, request.target))
			.catch(() => normalReorder.rollbackIfCurrent(request.list, request.visibleOrder));
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
{:else if isReorderMode}
	<div class="h-full pb-28 md:pb-4">
		{#if pinnedDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{m.sidebar_chats_reordering_pinned()}
			</div>
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => handleDraftDragStart('pinned')}
				onDragOver={(event) => handleDraftDragOver('pinned', event)}
				onDragEnd={(event) => handleDraftDragEnd('pinned', event)}
			>
				{#each pinnedDraftOrder as chatId, idx (chatId)}
					{@const chat = chatById('pinned', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group="chat-group-pinned"
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={true}
							isArchived={false}
							isReorderMode={true}
							showHandle={true}
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
							{onEnterReorderMode}
							onMoveToTop={idx > 0 ? () => moveToTop('pinned', chatId) : undefined}
							onMoveToBottom={idx < pinnedDraftOrder.length - 1 ? () => moveToBottom('pinned', chatId) : undefined}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if normalDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{m.sidebar_chats_reordering_normal()}
			</div>
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => handleDraftDragStart('normal')}
				onDragOver={(event) => handleDraftDragOver('normal', event)}
				onDragEnd={(event) => handleDraftDragEnd('normal', event)}
			>
				{#each normalDraftOrder as chatId, idx (chatId)}
					{@const chat = chatById('normal', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group="chat-group-normal"
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={false}
							isArchived={false}
							isReorderMode={true}
							showHandle={true}
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
							{onEnterReorderMode}
							onMoveToTop={idx > 0 ? () => moveToTop('normal', chatId) : undefined}
							onMoveToBottom={idx < normalDraftOrder.length - 1 ? () => moveToBottom('normal', chatId) : undefined}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if archivedDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{m.sidebar_chats_reordering_archived()}
			</div>
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => handleDraftDragStart('archived')}
				onDragOver={(event) => handleDraftDragOver('archived', event)}
				onDragEnd={(event) => handleDraftDragEnd('archived', event)}
			>
				{#each archivedDraftOrder as chatId, idx (chatId)}
					{@const chat = chatById('archived', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group="chat-group-archived"
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={false}
							isArchived={true}
							isReorderMode={true}
							showHandle={true}
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
							{onEnterReorderMode}
							onMoveToTop={idx > 0 ? () => moveToTop('archived', chatId) : undefined}
							onMoveToBottom={idx < archivedDraftOrder.length - 1 ? () => moveToBottom('archived', chatId) : undefined}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if pinnedDraftOrder.length === 0 && normalDraftOrder.length === 0 && archivedDraftOrder.length === 0}
			<div class="px-3 py-4 text-sm text-muted-foreground">
				{m.sidebar_chats_no_chats_to_reorder()}
			</div>
		{/if}
	</div>
{:else if useVirtualList}
	<SidebarVirtualChatList
		rows={virtualRows}
		{viewportRef}
		{selectedChatId}
		{currentTime}
		{isMobile}
		{isMultiSelectMode}
		{isMultiSelected}
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
		{onEnterReorderMode}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{hasPinnedChats}
	/>
{:else if isMultiSelectMode}
	<div class="h-full pb-28 md:pb-4">
		{#each displayedPinned as chat (chat.id)}
			<SidebarChatItem
				session={chat}
				{selectedChatId}
				{currentTime}
				{isMobile}
				isPinned={true}
				isArchived={false}
				{isMultiSelectMode}
				isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
				{onEnterReorderMode}
				{onEnterMultiSelect}
				{onMultiSelectToggle}
				{hasPinnedChats}
			/>
		{/each}
		{#each displayedNormal as chat (chat.id)}
			<SidebarChatItem
				session={chat}
				{selectedChatId}
				{currentTime}
				{isMobile}
				isPinned={false}
				isArchived={false}
				{isMultiSelectMode}
				isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
				{onEnterReorderMode}
				{onEnterMultiSelect}
				{onMultiSelectToggle}
				{hasPinnedChats}
			/>
		{/each}
		{#each displayedArchived as chat (chat.id)}
			<SidebarChatItem
				session={chat}
				{selectedChatId}
				{currentTime}
				{isMobile}
				isPinned={false}
				isArchived={true}
				{isMultiSelectMode}
				isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
				{onEnterReorderMode}
				{onEnterMultiSelect}
				{onMultiSelectToggle}
				{hasPinnedChats}
			/>
		{/each}
	</div>
{:else}
	<div class="h-full pb-28 md:pb-4">
		{#if normalReorder.orderFor('pinned').length > 0}
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => normalReorder.begin('pinned')}
				onDragOver={(event) => normalReorder.preview('pinned', event)}
				onDragEnd={(event) => handleNormalDragEnd('pinned', event)}
			>
				{#each normalReorder.orderFor('pinned') as chatId, idx (chatId)}
					{@const chat = chatById('pinned', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group={isFiltered ? 'pinned-filtered' : 'pinned-normal'}
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={true}
							isArchived={false}
							{isMultiSelectMode}
							isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
							{onEnterReorderMode}
							{onEnterMultiSelect}
							{onMultiSelectToggle}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if normalReorder.orderFor('normal').length > 0}
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => normalReorder.begin('normal')}
				onDragOver={(event) => normalReorder.preview('normal', event)}
				onDragEnd={(event) => handleNormalDragEnd('normal', event)}
			>
				{#each normalReorder.orderFor('normal') as chatId, idx (chatId)}
					{@const chat = chatById('normal', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group={isFiltered ? 'normal-filtered' : 'normal-normal'}
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={false}
							isArchived={false}
							{isMultiSelectMode}
							isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
							{onEnterReorderMode}
							{onEnterMultiSelect}
							{onMultiSelectToggle}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if normalReorder.orderFor('archived').length > 0}
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={() => normalReorder.begin('archived')}
				onDragOver={(event) => normalReorder.preview('archived', event)}
				onDragEnd={(event) => handleNormalDragEnd('archived', event)}
			>
				{#each normalReorder.orderFor('archived') as chatId, idx (chatId)}
					{@const chat = chatById('archived', chatId)}
					{#if chat}
						<SidebarSortableChatRow
							{chat}
							index={idx}
							group={isFiltered ? 'archived-filtered' : 'archived-normal'}
							{selectedChatId}
							{currentTime}
							{isMobile}
							isPinned={false}
							isArchived={true}
							{isMultiSelectMode}
							isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
							{onEnterReorderMode}
							{onEnterMultiSelect}
							{onMultiSelectToggle}
							{hasPinnedChats}
						/>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}
	</div>
{/if}
