<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { Button } from '$lib/components/ui/button';
	import { getAppShell, getModelCatalog } from '$lib/context';
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
	import Tag from '@lucide/svelte/icons/tag';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator
	} from '$lib/components/ui/dropdown-menu';
	import ColoredTag from '../shared/ColoredTag.svelte';
	import ProviderBadge from '../shared/ProviderBadge.svelte';
	import { getChatVisualStatus } from '$lib/chat/chat-visual-status';
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
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onEnterReorderMode?: () => void;
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
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		onShowDetails,
		onForkChat,
		onManageTags,
		onEnterReorderMode,
		hasPinnedChats = false,
		onMoveToTop,
		onMoveToBottom,
	}: SidebarChatItemProps = $props();

	let isUnread = $derived(session.isUnread && selectedChatId !== session.id);

	let visibleTags = $derived(session.tags.slice(0, 2));
	let overflowCount = $derived(Math.max(0, session.tags.length - 2));

	// Truncates a long path from the left, keeping the rightmost segments.
	function prefixEllipsis(pathStr: string, maxLen = 40): string {
		if (!pathStr || pathStr.length <= maxLen) return pathStr;
		const segments = pathStr.split('/');
		let result = segments[segments.length - 1];
		for (let i = segments.length - 2; i >= 0; i--) {
			const candidate = segments[i] + '/' + result;
			if (candidate.length + 4 > maxLen) break;
			result = candidate;
		}
		return '\u2026/' + result;
	}

	let chatName = $derived(session.title || m.sidebar_chats_new_chat());
	let lastMessage = $derived(session.lastMessage || '');
	let isSelected = $derived(selectedChatId === session.id);
	let projectPath = $derived(session.projectPath || '');
	let provider = $derived(session.provider || 'claude');
	let visualStatus = $derived(getChatVisualStatus(session));
	let activityLabel = $derived(formatRelativeActivity(session.lastActivityAt ?? session.createdAt, currentTime));

	let cornerBadgeClass = $derived(
		isPinned
			? 'border-sidebar-badge-pinned-border bg-sidebar-badge-pinned-bg'
			: 'border-sidebar-badge-archived-border bg-sidebar-badge-archived-bg'
	);
	let cornerBadgeIconClass = $derived(
		isPinned ? 'text-sidebar-badge-pinned-foreground' : 'text-sidebar-badge-archived-foreground'
	);

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

	function formatRelativeActivity(timestamp: string | null, now: Date): string {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		const diffMs = now.getTime() - date.getTime();
		if (!Number.isFinite(diffMs) || diffMs < 0) return '';
		const minutes = Math.floor(diffMs / 60_000);
		if (minutes < 1) return m.filetree_just_now();
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d`;
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
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

{#snippet chatItemContent()}
	<div class="min-w-0 w-full">
		<div class="flex items-start gap-2">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5 truncate text-[14px] font-medium {isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground'}">
					{#if isUnread}
						<span class="size-1.5 shrink-0 rounded-full bg-indicator-unread" aria-label={m.sidebar_chat_unread()}></span>
					{/if}
					<span class="truncate">{chatName}</span>
				</div>
				{#if projectPath}
					<div
						class="mt-0.5 truncate text-[11px] {isSelected ? 'text-sidebar-chat-item-selected-foreground/80' : 'text-muted-foreground'}"
						title={projectPath}
					>
						{prefixEllipsis(projectPath)}
					</div>
				{/if}
			</div>
			<div class="ml-2 flex shrink-0 flex-col items-end gap-1 text-right">
				{#if activityLabel}
					<span class="text-[10px] font-medium uppercase tracking-[0.14em] {isSelected ? 'text-sidebar-chat-item-selected-foreground/70' : 'text-muted-foreground'}">
						{activityLabel}
					</span>
				{/if}
				{#if visualStatus.label}
					<span class={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none', visualStatus.chipClass)}>
						<span class={cn('size-1.5 rounded-full', visualStatus.dotClass)}></span>
						{visualStatus.label}
					</span>
				{/if}
			</div>
		</div>

		<div class="mt-1.5 truncate text-[12px] leading-4 {isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-muted-foreground'}">
			{lastMessage || m.chat_messages_no_messages()}
		</div>

		<div class="mt-2 flex items-center gap-1.5 flex-wrap">
			<ProviderBadge provider={provider} />
			{#each visibleTags as tag (tag)}
				<ColoredTag label={tag} variant="border-border bg-muted text-muted-foreground" />
			{/each}
			{#if overflowCount > 0}
				<span class="text-[10px] font-medium text-muted-foreground">+{overflowCount}</span>
			{/if}
		</div>
	</div>
{/snippet}

<div class="chat-item-root group relative" bind:this={itemEl}>
	<!-- Status corner badge stays away from the top-right menu trigger. -->
		{#if isPinned || isArchived}
			<div
				class={cn("absolute right-1 bottom-[5px] z-10 pointer-events-none w-5 h-5 rounded-full border flex items-center justify-center", cornerBadgeClass)}
				aria-hidden="true"
			>
				{#if isPinned}
					<Pin class="size-3 {cornerBadgeIconClass}" />
				{:else}
					<Archive class="size-3 {cornerBadgeIconClass}" />
				{/if}
			</div>
		{/if}

	<!-- Mobile layout -->
	<div class="md:hidden">
			<button
					class={cn(
						'w-full text-left py-[7px] pr-2 pl-[7px] mx-0 my-0 rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg border-b border-border/30 border-l-2 active:scale-[0.98] transition-all duration-150 relative',
						isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
						visualStatus.accentClass,
				)}
				onclick={selectChat}
			>
				{@render chatItemContent()}
		</button>
	</div>

	<!-- Desktop layout with right-click support -->
	<div class="hidden md:block">
			<Button
				variant="ghost"
				oncontextmenu={handleRightClick}
					class={cn(
						'w-full justify-start py-[7px] pr-2 pl-[7px] h-auto font-normal text-left rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg transition-colors duration-200 border-b border-border/30 border-l-2',
					isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
					visualStatus.accentClass,
				)}
			onclick={selectChat}
		>
				{@render chatItemContent()}
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
