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
	import CheckSquare from '@lucide/svelte/icons/check-square';
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
		isMultiSelectMode?: boolean;
		isMultiSelected?: boolean;
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
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		hasPinnedChats?: boolean;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
	}

	let {
		session,
		selectedChatId,
		currentTime,
		isPinned,
		isArchived,
		isReorderMode = false,
		isMultiSelectMode = false,
		isMultiSelected = false,
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
	}: SidebarChatItemProps = $props();

	let isProcessing = $derived(session.isProcessing);
	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let isSelected = $derived(selectedChatId === session.id);
	let provider = $derived(session.provider || 'claude');

	function handleItemClick(e: MouseEvent) {
		if (isMultiSelectMode) {
			onMultiSelectToggle?.(session.id, e.shiftKey);
			return;
		}
		// Ctrl/Cmd+Click enters multi-select mode with this chat.
		if ((e.metaKey || e.ctrlKey) && onEnterMultiSelect) {
			onEnterMultiSelect(session.id);
			return;
		}
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
		if (isMultiSelectMode) return;
		e.preventDefault();
		if (!itemEl) return;
		const rect = itemEl.getBoundingClientRect();
		rightClickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		menuOpen = true;
	}

	// Anchors the dropdown next to the mobile 3-dot button so it opens beside the trigger.
	function handleMobileMenuClick(e: MouseEvent) {
		e.stopPropagation();
		if (!itemEl) return;
		const target = e.currentTarget as HTMLElement;
		const itemRect = itemEl.getBoundingClientRect();
		const btnRect = target.getBoundingClientRect();
		rightClickPos = {
			x: btnRect.left - itemRect.left,
			y: btnRect.bottom - itemRect.top,
		};
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

{#snippet stateBadge()}
	{#if !isMultiSelectMode && (isPinned || isArchived)}
		<div
			class={cn(
					'pointer-events-none absolute bottom-0 right-0 z-10 flex h-5 w-5 items-center justify-center rounded-full border',
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
{/snippet}

<div class="chat-item-root group relative" bind:this={itemEl}>
	<!-- Mobile layout -->
	<div
		class={cn(
			'md:hidden flex items-stretch border-b border-border/30 bg-sidebar-chat-item-bg',
			!isMultiSelectMode && isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
			isMultiSelectMode && isMultiSelected && 'bg-primary/8',
			!isMultiSelectMode && isProcessing && 'border-l-[3px] border-l-status-processing',
		)}
	>
		<button
			class={cn(
				'flex-1 min-w-0 text-left py-[5px] pr-2 mx-0 my-0 rounded-none hover:bg-sidebar-chat-item-hover-bg active:scale-[0.98] transition-[background-color,color,transform] duration-150 relative flex items-center',
				isMultiSelectMode ? 'pl-1' : 'pl-[7px]',
			)}
			onclick={handleItemClick}
		>
			{#if isMultiSelectMode}
				<div class="flex items-center justify-center w-7 shrink-0" aria-hidden="true">
					<div
						role="checkbox"
						aria-checked={isMultiSelected}
						aria-label="Select {chatName}"
						class={cn(
							'size-4 rounded border-[1.5px] flex items-center justify-center transition-all duration-150',
							isMultiSelected
								? 'bg-primary border-primary'
								: 'border-muted-foreground/40 bg-background',
						)}
					>
						{#if isMultiSelected}
							<svg class="size-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="2.5 6 5 8.5 9.5 3.5" />
							</svg>
						{/if}
					</div>
				</div>
			{/if}
			<div class="relative flex-1 min-w-0">
				<SidebarChatSummary
					{session}
					{isSelected}
					{isPinned}
					{isArchived}
					{currentTime}
					showTimestamp={true}
					onTagClick={isMultiSelectMode ? undefined : onTagClick}
					onManageTags={isMultiSelectMode ? undefined : onManageTags}
				/>
				{@render stateBadge()}
			</div>
		</button>
		{#if !isMultiSelectMode}
			<button
				type="button"
				class="shrink-0 flex items-center justify-center px-3 text-muted-foreground hover:text-foreground active:bg-accent border-l border-border/30 transition-colors"
				onclick={handleMobileMenuClick}
				aria-label={m.sidebar_chat_more_actions()}
			>
				<EllipsisVertical class="size-5" />
			</button>
		{/if}
	</div>

	<!-- Desktop layout with right-click support and drag-to-split -->
	<div class="hidden md:block">
		<Button
			variant="ghost"
			draggable={!isMultiSelectMode}
			ondragstart={isMultiSelectMode ? undefined : handleDragStart}
			ondragend={isMultiSelectMode ? undefined : handleDragEnd}
			oncontextmenu={handleRightClick}
			class={cn(
				'w-full justify-start pr-2 h-auto font-normal text-left rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg transition-colors duration-200 border-b border-border/30',
				isMultiSelectMode ? 'py-[5px] pl-1 border-l-0' : 'py-[5px] pl-[7px] border-l-2 border-l-transparent',
				!isMultiSelectMode && isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
				!isMultiSelectMode && isProcessing && 'border-l-[3px] border-l-status-processing',
				isMultiSelectMode && isMultiSelected && 'bg-primary/8',
			)}
			onclick={handleItemClick}
		>
			{#if isMultiSelectMode}
				<div class="flex items-center justify-center w-7 shrink-0" aria-hidden="true">
					<div
						role="checkbox"
						aria-checked={isMultiSelected}
						aria-label="Select {chatName}"
						class={cn(
							'size-4 rounded border-[1.5px] flex items-center justify-center transition-all duration-150',
							isMultiSelected
								? 'bg-primary border-primary'
								: 'border-muted-foreground/40 bg-background',
						)}
					>
						{#if isMultiSelected}
							<svg class="size-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="2.5 6 5 8.5 9.5 3.5" />
							</svg>
						{/if}
					</div>
				</div>
			{/if}
			<div class="relative flex-1 min-w-0">
				<SidebarChatSummary
					{session}
					{isSelected}
					{isPinned}
					{isArchived}
					{currentTime}
					showTimestamp={true}
					onTagClick={isMultiSelectMode ? undefined : onTagClick}
					onManageTags={isMultiSelectMode ? undefined : onManageTags}
				/>
				{@render stateBadge()}
			</div>
		</Button>
	</div>

	<!-- Dropdown anchor: hidden in multi-select mode -->
	{#if !isMultiSelectMode}
	<div
		class={cn(
			"absolute z-20",
			!isAtCursor && "sidebar-item-menu-anchor right-1 top-1 hidden md:block opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100",
		)}
		style={isAtCursor ? `left:${rightClickPos!.x}px;top:${rightClickPos!.y}px` : ''}
	>
		<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					class={isAtCursor
						? "block w-px h-px opacity-0 pointer-events-none"
						: "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-background text-muted-foreground transition-colors hover:bg-background hover:text-foreground"}
					aria-label={m.sidebar_chat_more_actions()}
					tabindex={isAtCursor ? -1 : 0}
				>
				{#if !isAtCursor}
					<EllipsisVertical class="h-3.5 w-3.5" />
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
					{#if onEnterMultiSelect}
						<DropdownMenuItem onclick={() => onEnterMultiSelect?.(session.id)}>
							<CheckSquare />
							{m.sidebar_select_enter()}
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
	{/if}
</div>
