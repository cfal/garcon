<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	let {
		workspaceName,
		chats,
		selectedChatId,
		currentTime,
		isMultiSelectMode,
		isMultiSelected,
		hasPinnedChats,
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
	}: {
		workspaceName: string;
		chats: ChatSessionRecord[];
		selectedChatId: string | null;
		currentTime: Date;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		hasPinnedChats?: boolean;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, title: string, provider: SessionProvider) => void;
		onStartRenameChat: (chatId: string, name: string) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chatId: string, title: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, title: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, tags: string[]) => void;
		onEnterReorderMode?: () => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
	} = $props();

	let isOpen = $state(true);
	let visibleCount = $state(5);

	const defaultLimit = 5;

	// Reset visibleCount when the group collapses so reopening starts fresh.
	$effect(() => {
		if (!isOpen) {
			visibleCount = defaultLimit;
				}
				});

	function handleHeaderClick(): void {
		isOpen = !isOpen;
			}

	function handleKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleHeaderClick();
				}
				}

	function handleShowMore(): void {
		visibleCount = Math.min(visibleCount + defaultLimit, chats.length);
			}

	let showMoreButton = $derived(chats.length > visibleCount);
	let visibleChats = $derived(chats.slice(0, visibleCount));
</script>

<div class="workspace-group">
	<button
		type="button"
		class="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-foreground hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
		onclick={handleHeaderClick}
		onkeydown={handleKeyDown}
		aria-expanded={isOpen}
		aria-label={workspaceName}
	>
				{#if isOpen}
					<ChevronDown class="w-4 h-4 shrink-0 text-muted-foreground" />
				{:else}
					<ChevronRight class="w-4 h-4 shrink-0 text-muted-foreground" />
				{/if}
				<span class="truncate">{workspaceName}</span>
				<span class="ml-auto text-xs text-muted-foreground shrink-0">{chats.length}</span>
			</button>

			{#if isOpen}
				<div class="workspace-chats">
					{#each visibleChats as chat (chat.id)}
						<SidebarChatItem
							session={chat}
							{selectedChatId}
							{currentTime}
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
					{#if showMoreButton}
						<button
							type="button"
							class="w-full flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
							onclick={handleShowMore}
						>
							{m.sidebar_workspace_show_more({ count: defaultLimit })}
						</button>
					{/if}
				</div>
			{/if}
</div>
