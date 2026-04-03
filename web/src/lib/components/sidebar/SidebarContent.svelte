<script lang="ts">
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import SidebarChatList from './SidebarChatList.svelte';
	import SidebarFolders from './SidebarFolders.svelte';
	import type { FolderEntry } from './sidebar-filter-state.svelte';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList } from '$lib/api/chats.js';

	interface SidebarContentProps {
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		currentTime: Date;
		searchFilter: string;
		isReorderMode: boolean;
		folders: FolderEntry[];
		selectedFolderId: string;
		canCreateFolder?: boolean;
		createFolderHint?: string;
		onSelectFolder: (id: string) => void;
		onCreateFolder?: () => void;
		onDeleteFolder?: (id: string) => void;
		onEditFolder?: (folder: FolderEntry) => void;
		folderCounts?: Map<string, number>;
		onEnterReorderMode: () => void;
		onReorderGroup: (list: ChatOrderList, oldOrder: string[], newOrder: string[]) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, chatTitle: string, provider: SessionProvider) => void;
		onStartRenameChat: (chatId: string, currentName: string) => void;
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, chatTitle: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onImmediateReorder: (list: ChatOrderList, oldOrder: string[], newOrder: string[]) => void;
		onQuickMove: (chatId: string, chatIdAbove?: string, chatIdBelow?: string) => void;
	}

	let {
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		currentTime,
		searchFilter,
		isReorderMode,
		folders,
		selectedFolderId,
		canCreateFolder,
		createFolderHint,
		onSelectFolder,
		onCreateFolder,
		onDeleteFolder,
		onEditFolder,
		folderCounts,
		onEnterReorderMode,
		onReorderGroup,
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
</script>

<SidebarFolders
	{folders}
	{selectedFolderId}
	{canCreateFolder}
	{createFolderHint}
	{onSelectFolder}
	{onCreateFolder}
	{onDeleteFolder}
	{onEditFolder}
	{folderCounts}
/>

<ScrollArea
	class="flex-1 overflow-y-auto overscroll-contain"
	scrollbarYClasses="w-1.5"
>
	<SidebarChatList
		{chats}
		{filteredChats}
		{selectedChatId}
		{isLoading}
		{currentTime}
		{searchFilter}
		{isReorderMode}
		{onEnterReorderMode}
		{onReorderGroup}
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
