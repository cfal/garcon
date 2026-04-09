<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { Button } from '$lib/components/ui/button';
	import { getAppShell, getModelCatalog, getSplitLayout } from '$lib/context';
	import Pin from '@lucide/svelte/icons/pin';
	import Archive from '@lucide/svelte/icons/archive';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line';
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Info from '@lucide/svelte/icons/info';
	import Copy from '@lucide/svelte/icons/copy';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Tag from '@lucide/svelte/icons/tag';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator
	} from '$lib/components/ui/dropdown-menu';
	import SidebarChatSummary from './SidebarChatSummary.svelte';
	import type { SessionProvider } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatItemProps {
		session: ChatSessionRecord;
		selectedChatId: string | null;
		currentTime: Date;
		isPinned: boolean;
		isArchived: boolean;
		isReorderMode?: boolean;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, chatTitle: string, provider: SessionProvider) => void;
		onStartRenameChat: (chatId: string, currentName: string) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, chatTitle: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onEnterReorderMode?: () => void;
		hasPinnedChats?: boolean;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
	}

	let {
		session,
		selectedChatId,
		isPinned,
		isArchived,
		isReorderMode = false,
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
		onMoveToTop,
		onMoveToBottom,
	}: SidebarChatItemProps = $props();

	let isProcessing = $derived(session.isProcessing);
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let isSelected = $derived(selectedChatId === session.id);
	let provider = $derived(session.provider || 'claude');

	function selectChat() {
		onChatSelect(session.id);
	}

	function requestDelete() {
		onDeleteChat(session.id, chatName, provider);
	}

	function requestRename() {
		onStartRenameChat(session.id, chatName);
	}

	function requestDetails() {
		onShowDetails(session.id, chatName);
	}

	let menuOpen = $state(false);

	// When set, the menu anchor is at cursor position instead of the 3-dots button.
	let rightClickPos = $state<{ x: number; y: number } | null>(null);
	let isAtCursor = $derived(rightClickPos !== null);

	// Resets cursor anchor when the menu closes so the 3-dots button reappears.
	$effect(() => {
		if (!menuOpen) rightClickPos = null;
	});

	// Positions the dropdown anchor at the cursor for desktop right-click.
	function handleRightClick(e: MouseEvent) {
		e.preventDefault();
		if (!itemEl) return;
		const rect = itemEl.getBoundingClientRect();
		rightClickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		menuOpen = true;
	}

	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();

	function handleDragStart(e: DragEvent) {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', session.id);
		splitLayout.startDrag(session.id);
	}

	function handleDragEnd() {
		splitLayout.endDrag();
	}

	let itemEl: HTMLDivElement | undefined = $state();

	// Scrolls the bits-ui scroll area viewport so this item is visible.
	// Uses manual scrollTop arithmetic because scrollIntoView does not
	// reliably target the bits-ui viewport in a dual-overflow layout.
	function scrollIntoViewport(el: HTMLElement) {
		const viewport = el.closest('[data-scroll-area-viewport]');
		if (!(viewport instanceof HTMLElement)) return;

		const vRect = viewport.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const targetY = vRect.top + viewport.clientHeight * 0.2;

		if (elRect.top < vRect.top || elRect.bottom > vRect.bottom) {
			viewport.scrollTop += elRect.top - targetY;
		}
	}

	// Scroll-to-selected on explicit recenter requests (chat focus).
	onMount(() => appShell.onSidebarRecenterRequested(() => {
		if (!isSelected || !itemEl) return;
		requestAnimationFrame(() => {
			if (itemEl) scrollIntoViewport(itemEl);
		});
	}));
</script>

<div class="chat-item-root group relative" bind:this={itemEl}>
	{#if isPinned || isArchived}
		<div
			class={cn(
				'pointer-events-none absolute bottom-[5px] right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border',
				isPinned
					? 'border-sidebar-badge-pinned-border bg-sidebar-badge-pinned-bg'
					: 'border-sidebar-badge-archived-border bg-sidebar-badge-archived-bg',
			)}
			aria-hidden="true"
		>
			{#if isPinned}
				<Pin class="size-3 text-sidebar-badge-pinned-foreground" />
			{:else}
				<Archive class="size-3 text-sidebar-badge-archived-foreground" />
			{/if}
		</div>
	{/if}

	<!-- Mobile layout -->
	<div class="md:hidden">
			<button
					class={cn(
						'w-full text-left py-[5px] pr-2 pl-[7px] mx-0 my-0 rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg border-b border-border/30 active:scale-[0.98] transition-all duration-150 relative',
					isSelected ? 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground' : '',
						isProcessing ? 'border-l-[3px] border-l-status-processing' : '',
				)}
				onclick={selectChat}
			>
				<SidebarChatSummary
					{session}
					{isSelected}
					{isPinned}
					{isArchived}
					{onTagClick}
					{onManageTags}
				/>
		</button>
	</div>

	<!-- Desktop layout with right-click support and drag-to-split -->
	<div class="hidden md:block">
			<Button
				variant="ghost"
				draggable={true}
				ondragstart={handleDragStart}
				ondragend={handleDragEnd}
				oncontextmenu={handleRightClick}
					class={cn(
						'w-full justify-start py-[5px] pr-2 pl-[7px] h-auto font-normal text-left rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg transition-colors duration-200 border-b border-border/30 border-l-2 border-l-transparent',
					isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
					isProcessing && 'border-l-[3px] border-l-status-processing',
				)}
			onclick={selectChat}
		>
			<SidebarChatSummary
				{session}
				{isSelected}
				{isPinned}
				{isArchived}
				{onTagClick}
				{onManageTags}
			/>
		</Button>
	</div>

	<!-- Dropdown anchor: at cursor on right-click, at 3-dots button otherwise -->
	<div
		class={cn(
			"absolute z-20",
			!isAtCursor && "sidebar-item-menu-anchor right-1 top-1 opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100",
			!isAtCursor && menuOpen && "!opacity-100"
		)}
		style={isAtCursor ? `left:${rightClickPos!.x}px;top:${rightClickPos!.y}px` : ''}
	>
		<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					class={isAtCursor
						? "block w-px h-px opacity-0 pointer-events-none"
						: "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"}
					aria-label={m.sidebar_chat_more_actions()}
					tabindex={isAtCursor ? -1 : 0}
				>
				{#if !isAtCursor}
					<EllipsisVertical class="size-4" />
				{/if}
			</DropdownMenuTrigger>
			<DropdownMenuContent align={isAtCursor ? "start" : "end"}>
				{#if isReorderMode}
					{#if onMoveToTop}
						<DropdownMenuItem onclick={onMoveToTop}>
							<ArrowUpToLine />
							{m.sidebar_chats_move_to_top()}
						</DropdownMenuItem>
					{/if}
					{#if onMoveToBottom}
						<DropdownMenuItem onclick={onMoveToBottom}>
							<ArrowDownToLine />
							{m.sidebar_chats_move_to_bottom()}
						</DropdownMenuItem>
					{/if}
				{:else}
					<DropdownMenuItem onclick={() => onTogglePinned(session.id)}>
						<Pin />
						{isPinned ? m.sidebar_chats_unpin() : m.sidebar_chats_pin()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={() => onToggleArchive(session.id)}>
						<Archive class={cn(isArchived ? 'text-muted-foreground' : '')} />
						{isArchived ? m.sidebar_chats_unarchive() : m.sidebar_chats_archive()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={requestRename}>
						<Edit2 />
						{m.sidebar_tooltips_edit_chat_name()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={requestDetails}>
						<Info />
						{m.sidebar_chats_details()}
					</DropdownMenuItem>
					<DropdownMenuItem onclick={() => onShareChat(session.id, chatName)}>
						<Share2 />
						{m.share_button()}
					</DropdownMenuItem>
					{#if onManageTags}
						<DropdownMenuItem onclick={() => onManageTags?.(session.id, session.tags)}>
							<Tag />
							{m.sidebar_tags_manage()}
						</DropdownMenuItem>
					{/if}
					{#if modelCatalog.supportsFork(session.provider)}
						<DropdownMenuItem onclick={() => onForkChat(session.id)}>
							<Copy />
							{m.sidebar_chats_fork()}
						</DropdownMenuItem>
					{/if}
					{#if onEnterReorderMode}
						<DropdownMenuItem onclick={() => onEnterReorderMode?.()}>
							<ArrowUpDown />
							{m.sidebar_chats_reorder_chats()}
						</DropdownMenuItem>
					{/if}
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onclick={requestDelete}>
						<Trash2 />
						{m.sidebar_tooltips_delete_chat()}
					</DropdownMenuItem>
				{/if}
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</div>
