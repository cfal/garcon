<script lang="ts">
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';

	interface SidebarContentProps {
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
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, chatTitle: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onImmediateReorder: (
			list: ChatOrderList,
			oldOrder: string[],
			newOrder: string[],
			onFailure?: () => void,
		) => void;
		onQuickMove: (chatId: string, target: ReorderQuickTarget) => Promise<void> | void;
	}

	let {
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		isMultiSelectMode,
		isMultiSelected,
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
		onTogglePinned,
		onToggleArchive,
		onImmediateReorder,
		onQuickMove,
	}: SidebarContentProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
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
		{isMultiSelectMode}
		{isMultiSelected}
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
		{onTogglePinned}
		{onToggleArchive}
		{onImmediateReorder}
		{onQuickMove}
	/>
</ScrollArea>
