<script lang="ts">
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarContentProps {
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		onNewChat?: () => void;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		displayOptions?: SidebarDisplayOptions;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
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
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		onNewChat,
		isMultiSelectMode,
		isMultiSelected,
		displayOptions = DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		collapsedProjectKeys = new Set<string>(),
		onToggleProjectCollapsed,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onOpenInNewWindow,
		newWindowEdges,
		onTogglePinned,
		onToggleArchive,
		onQuickMove,
		onSortChatOrder,
	}: SidebarContentProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);

	$effect(() => {
		const region = viewportRef;
		if (!region) return;
		return registerNativeWorkspaceScrollRegion(region, 'primary');
	});
</script>

<ScrollArea
	bind:viewportRef
	class="flex-1 overflow-y-auto overscroll-contain"
	scrollbarYClasses="w-1.5"
>
	<SidebarChatList
		{viewportRef}
		{chats}
		{filteredChats}
		{selectedChatId}
		{isLoading}
		{isMobile}
		{currentTime}
		{searchFilter}
		{onNewChat}
		{isMultiSelectMode}
		{isMultiSelected}
		{displayOptions}
		{collapsedProjectKeys}
		{onToggleProjectCollapsed}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{onChatSelect}
		{onDeleteChat}
		{onStartRenameChat}
		{onShowDetails}
		{onForkChat}
		{onShareChat}
		{onTagClick}
		{onManageTags}
		{onOpenInNewWindow}
		{newWindowEdges}
		{onTogglePinned}
		{onToggleArchive}
		{onQuickMove}
		{onSortChatOrder}
	/>
</ScrollArea>
