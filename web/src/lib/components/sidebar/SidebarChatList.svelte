<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Search from '@lucide/svelte/icons/search';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import { Button } from '$lib/components/ui/button';
	import SidebarVirtualSortableChatList from './SidebarVirtualSortableChatList.svelte';
	import {
		SidebarChatReorderState,
		type SidebarChatReorderRequest,
	} from './sidebar-chat-reorder-state.svelte.ts';
	import { buildSidebarRowModel } from './sidebar-row-model';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';
	import type { SidebarChatListProjection } from './sidebar-row-model';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarChatListProps {
		viewportRef?: HTMLElement | null;
		projection: SidebarChatListProjection;
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		onNewChat?: () => void;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		displayOptions?: SidebarDisplayOptions;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		isArchiveMutationPending?: (chatId: string) => boolean;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onQuickMove: (
			list: PersistedChatOrderGroup,
			chatId: string,
			placement: RelativeChatOrderPlacement,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
		onSortChatOrder: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		viewportRef = null,
		projection,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		onNewChat,
		isMultiSelectMode = false,
		isMultiSelected,
		displayOptions = DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		onToggleProjectCollapsed,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		isArchiveMutationPending = () => false,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onOpenInNewWindow,
		newWindowEdges,
		onQuickMove,
		onSortChatOrder,
	}: SidebarChatListProps = $props();
	let isFiltered = $derived(searchFilter.trim().length > 0);
	let displayedChats = $derived(projection.rowModelInput.displayedChats);
	let showChats = $derived(!isLoading && displayedChats.length > 0);
	let hasPinnedChats = $derived(projection.hasPinnedChats);
	let baseRowModel = $derived(projection.rowModel);

	const reorder = new SidebarChatReorderState({
		get visibleOrders() {
			return baseRowModel.visibleOrders;
		},
	});

	let virtualRowModel = $derived.by(() => {
		if (!reorder.hasOverrides) return baseRowModel;
		return buildSidebarRowModel({
			...projection.rowModelInput,
			orders: {
				pinned: reorder.orderFor('pinned'),
				normal: reorder.orderFor('normal'),
				archived: reorder.orderFor('archived'),
			},
		});
	});

	$effect(() => {
		reorder.reconcile();
	});

	function persistReorderRequest(request: SidebarChatReorderRequest): void {
		onQuickMove(
			request.list,
			request.chatId,
			request.placement,
			() => reorder.completeIfCurrent(request.list, request.sequence),
			() => reorder.rollbackIfCurrent(request.list, request.sequence, request.visibleOrder),
		);
	}
</script>

{#if isLoading}
	<div class="flex h-full items-center justify-center px-4">
		<div class="w-full max-w-xs text-center">
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3"
			>
				<div
					class="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
				></div>
			</div>
			<h3 class="mb-2 text-base font-medium text-foreground md:mb-1">
				{m.sidebar_chats_loading_chats()}
			</h3>
			<p class="text-sm text-muted-foreground">{m.sidebar_chats_fetching_chats()}</p>
		</div>
	</div>
{:else if !showChats && !isFiltered}
	<div class="px-4 py-12 text-center md:py-8">
		<div
			class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3"
		>
			<MessageSquarePlus class="h-6 w-6 text-muted-foreground" />
		</div>
		<h3 class="mb-2 text-base font-medium text-foreground md:mb-1">
			{m.sidebar_chats_no_chats()}
		</h3>
		<p class="text-sm text-muted-foreground">{m.sidebar_chats_no_chats_hint()}</p>
		{#if onNewChat}
			<Button variant="outline" size="sm" class="mt-4" onclick={onNewChat}>
				{m.sidebar_chats_new_chat()}
			</Button>
		{/if}
	</div>
{:else if !showChats}
	<div class="px-4 py-12 text-center md:py-8">
		<div
			class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3"
		>
			<Search class="h-6 w-6 text-muted-foreground" />
		</div>
		<h3 class="mb-2 text-base font-medium text-foreground md:mb-1">
			{m.sidebar_chats_no_matching_chats()}
		</h3>
		<p class="text-sm text-muted-foreground">{m.sidebar_chats_try_different_search()}</p>
	</div>
{:else}
	<SidebarVirtualSortableChatList
		rows={virtualRowModel.rows}
		{viewportRef}
		{selectedChatId}
		{currentTime}
		{isMobile}
		{isFiltered}
		{displayOptions}
		{onToggleProjectCollapsed}
		{isMultiSelectMode}
		{isMultiSelected}
		{reorder}
		onPersistReorder={persistReorderRequest}
		{onChatSelect}
		{onDeleteChat}
		{onStartRenameChat}
		{onTogglePinned}
		{onToggleArchive}
		{isArchiveMutationPending}
		{onShowDetails}
		{onForkChat}
		{onShareChat}
		{onTagClick}
		{onManageTags}
		{onOpenInNewWindow}
		{newWindowEdges}
		{onSortChatOrder}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{hasPinnedChats}
	/>
{/if}
