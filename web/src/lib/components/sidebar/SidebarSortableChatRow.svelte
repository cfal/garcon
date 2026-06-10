<script lang="ts">
	import { createSortable } from '@dnd-kit/svelte/sortable';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarSortableChatRowProps {
		chat: ChatSessionRecord;
		index: number;
		group: string;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isPinned: boolean;
		isArchived: boolean;
		isReorderMode?: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: boolean;
		showHandle?: boolean;
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
		onEnterReorderMode?: () => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		hasPinnedChats?: boolean;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
	}

	let {
		chat,
		index,
		group,
		selectedChatId,
		currentTime,
		isMobile,
		isPinned,
		isArchived,
		isReorderMode = false,
		isMultiSelectMode = false,
		isMultiSelected = false,
		showHandle = false,
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
		onEnterReorderMode,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onMoveToTop,
		onMoveToBottom,
		hasPinnedChats = false,
	}: SidebarSortableChatRowProps = $props();

	const sortable = createSortable({
		get id() { return chat.id; },
		get index() { return index; },
		get group() { return group; },
	});
</script>

<div class="relative flex items-stretch" {@attach sortable.attach}>
	{#if showHandle}
		<button
			type="button"
			class="flex w-8 shrink-0 cursor-grab items-center justify-center text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing"
			aria-label="Drag to reorder"
			{@attach sortable.attachHandle}
		>
			<GripVertical class="h-4 w-4" />
		</button>
	{/if}
	<div class="min-w-0 flex-1">
		<SidebarChatItem
			session={chat}
			{selectedChatId}
			{currentTime}
			{isMobile}
			{isPinned}
			{isArchived}
			{isReorderMode}
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
			{onMoveToTop}
			{onMoveToBottom}
			{hasPinnedChats}
		/>
	</div>
</div>
