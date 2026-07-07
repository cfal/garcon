<script lang="ts">
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import SidebarPRSection from './SidebarPRSection.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats.js';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';

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
		displayOptions?: SidebarDisplayOptions;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
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
		onQuickMove: (
			list: ChatOrderList,
			chatId: string,
			target: ReorderQuickTarget,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
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
		onTogglePinned,
		onToggleArchive,
		onQuickMove,
	}: SidebarContentProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
</script>

<div class="flex h-full min-h-0 flex-col">
<SidebarPRSection />
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
		{onTogglePinned}
		{onToggleArchive}
		{onQuickMove}
	/>
</ScrollArea>
</div>
