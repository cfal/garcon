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
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator
	} from '$lib/components/ui/dropdown-menu';
	import ColoredTag from '../shared/ColoredTag.svelte';
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
		onEnterReorderMode,
		hasPinnedChats = false,
		onMoveToTop,
		onMoveToBottom,
	}: SidebarChatItemProps = $props();

	let isProcessing = $derived(session.isProcessing);
	let isUnread = $derived(session.isUnread && selectedChatId !== session.id);

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

	const PROVIDER_TAG_VARIANTS: Record<SessionProvider, string> = {
		claude: 'border-provider-claude-border bg-provider-claude-bg text-provider-claude-foreground',
		codex: 'border-provider-codex-border bg-provider-codex-bg text-provider-codex-foreground',
		opencode: 'border-provider-opencode-border bg-provider-opencode-bg text-provider-opencode-foreground',
	};
	let providerTagVariant = $derived(PROVIDER_TAG_VARIANTS[provider] ?? PROVIDER_TAG_VARIANTS.claude);
	let providerTagLabel = $derived(
		provider === 'codex' ? m.provider_codex()
		: provider === 'opencode' ? m.provider_opencode()
		: m.provider_claude()
	);

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

<div class="chat-item-root group relative" bind:this={itemEl}>
	<!-- Status corner badge overlays chat content without affecting layout flow. -->
		{#if isPinned || isArchived}
			<div
				class="absolute top-1 right-1 z-20 pointer-events-none w-5 h-5 rounded-full border flex items-center justify-center {cornerBadgeClass}"
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
						'w-full text-left py-[5px] pr-2 pl-[7px] mx-0 my-0 rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg border-b border-border/30 active:scale-[0.98] transition-all duration-150 relative',
					isSelected ? 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground' : '',
						isProcessing ? 'border-l-[3px] border-l-status-processing' : '',
				)}
				onclick={selectChat}
			>
			<div class="min-w-0 flex-1">
						<div class="text-[14px] font-medium truncate flex items-center gap-1.5 {isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground'}">
						{#if isUnread}
							<span class="w-1.5 h-1.5 shrink-0 rounded-full bg-indicator-unread" aria-label="Unread"></span>
						{/if}
					{chatName}
				</div>
						{#if projectPath}
							<div class="text-[11px] truncate {isSelected ? 'text-sidebar-chat-item-selected-foreground/80' : 'text-muted-foreground'}" title={projectPath}>
							{prefixEllipsis(projectPath)}
						</div>
					{/if}
						<div class="text-[13px] italic truncate {isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80'}">
							{lastMessage || '\u00A0'}
						</div>
					<div class="mt-1 flex items-center gap-1">
						<ColoredTag label={providerTagLabel} variant={providerTagVariant} />
					</div>
			</div>
		</button>
	</div>

	<!-- Desktop layout with right-click support -->
	<div class="hidden md:block">
			<Button
				variant="ghost"
				oncontextmenu={handleRightClick}
					class={cn(
						'w-full justify-start py-[5px] pr-2 pl-[7px] h-auto font-normal text-left rounded-none bg-sidebar-chat-item-bg hover:bg-sidebar-chat-item-hover-bg transition-colors duration-200 border-b border-border/30 border-l-2 border-l-transparent',
					isSelected && 'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
					isProcessing && 'border-l-[3px] border-l-status-processing',
				)}
			onclick={selectChat}
		>
			<div class="min-w-0 w-full">
						<div class="text-[14px] font-medium truncate flex items-center gap-1.5 {isSelected ? 'text-sidebar-chat-item-selected-foreground' : 'text-foreground'}">
					{#if isUnread}
						<span class="w-1.5 h-1.5 shrink-0 rounded-full bg-indicator-unread" aria-label="Unread"></span>
					{/if}
					{chatName}
				</div>
						{#if projectPath}
								<div class="text-[11px] truncate {isSelected ? 'text-sidebar-chat-item-selected-foreground/80' : 'text-muted-foreground'}" title={projectPath}>
							{prefixEllipsis(projectPath)}
						</div>
					{/if}
							<div class="text-[13px] italic truncate {isSelected ? 'text-sidebar-chat-item-selected-foreground/90' : 'text-foreground/80'}">
							{lastMessage || '\u00A0'}
						</div>
					<div class="mt-1 flex items-center gap-1">
						<ColoredTag label={providerTagLabel} variant={providerTagVariant} />
					</div>
			</div>
		</Button>
	</div>

	<!-- Dropdown anchor: at cursor on right-click, at 3-dots button otherwise -->
	<div
		class={cn(
			"absolute z-20",
			!isAtCursor && "sidebar-item-menu-anchor right-1 bottom-1 opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100",
			!isAtCursor && menuOpen && "!opacity-100"
		)}
		style={isAtCursor ? `left:${rightClickPos!.x}px;top:${rightClickPos!.y}px` : ''}
	>
		<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					class={isAtCursor
						? "block w-px h-px opacity-0 pointer-events-none"
						: "inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"}
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
