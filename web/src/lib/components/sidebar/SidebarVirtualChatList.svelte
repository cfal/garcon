<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { getAppShell } from '$lib/context';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import {
		DEFAULT_CHAT_ROW_OVERSCAN,
		DESKTOP_CHAT_ROW_HEIGHT,
		MOBILE_CHAT_ROW_HEIGHT,
		type SidebarVirtualChatRow,
	} from './sidebar-virtual-chat-list';
	import type { SessionAgentId } from '$lib/types/app';

	interface SidebarVirtualChatListProps {
		rows: SidebarVirtualChatRow[];
		viewportRef: HTMLElement | null;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		rowHeight?: number;
		overscan?: number;
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
	}

	let {
		rows,
		viewportRef,
		selectedChatId,
		currentTime,
		isMobile,
		isMultiSelectMode = false,
		isMultiSelected,
		rowHeight,
		overscan = DEFAULT_CHAT_ROW_OVERSCAN,
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
		hasPinnedChats = false,
	}: SidebarVirtualChatListProps = $props();

	const appShell = getAppShell();
	const desktopBottomPadding = 16;
	const mobileBottomPadding = 112;

	let scrollTop = $state(0);
	let viewportHeight = $state(640);

	let effectiveRowHeight = $derived(
		rowHeight ?? (isMobile ? MOBILE_CHAT_ROW_HEIGHT : DESKTOP_CHAT_ROW_HEIGHT)
	);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	let totalHeight = $derived(rows.length * effectiveRowHeight + bottomPadding);
	let startIndex = $derived(
		Math.min(rows.length, Math.max(0, Math.floor(scrollTop / effectiveRowHeight) - overscan))
	);
	let endIndex = $derived.by(() => {
		const visibleEnd = Math.ceil((scrollTop + viewportHeight) / effectiveRowHeight);
		return Math.min(rows.length, visibleEnd + overscan);
	});
	let visibleRows = $derived(rows.slice(startIndex, endIndex));

	function syncScrollTop(): void {
		if (!viewportRef) return;
		scrollTop = viewportRef.scrollTop;
	}

	function syncViewportHeight(): void {
		if (!viewportRef) return;
		viewportHeight = Math.max(effectiveRowHeight, viewportRef.clientHeight || viewportHeight);
	}

	function scrollChatIntoView(chatId: string | null): void {
		if (!chatId || !viewportRef) return;
		const index = rows.findIndex((row) => row.chat.id === chatId);
		if (index < 0) return;

		const top = index * effectiveRowHeight;
		const bottom = top + effectiveRowHeight;
		const viewportBottom = viewportRef.scrollTop + viewportHeight;

		if (top >= viewportRef.scrollTop && bottom <= viewportBottom) return;

		viewportRef.scrollTop = Math.max(0, top - viewportHeight * 0.2);
		scrollTop = viewportRef.scrollTop;
	}

	$effect(() => {
		if (!viewportRef) return;
		const handleScroll = () => syncScrollTop();
		viewportRef.addEventListener('scroll', handleScroll, { passive: true });
		syncScrollTop();
		syncViewportHeight();
		return () => viewportRef?.removeEventListener('scroll', handleScroll);
	});

	// Tracks browser-owned viewport metrics that Svelte cannot derive.
	$effect(() => {
		if (!viewportRef || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				viewportHeight = Math.max(effectiveRowHeight, entry.contentRect.height);
			}
		});
		observer.observe(viewportRef);
		return () => observer.disconnect();
	});

	onMount(() => appShell.onSidebarRecenterRequested(() => {
		scrollChatIntoView(selectedChatId);
	}));
</script>

<div
	class="relative min-h-full"
	style={`height:${totalHeight}px;`}
	data-sidebar-virtual-list
>
	{#each visibleRows as row, visibleIndex (row.key)}
		{@const absoluteIndex = startIndex + visibleIndex}
		<div
			class="absolute left-0 right-0 top-0 overflow-hidden bg-sidebar-chat-item-bg"
			style={`height:${effectiveRowHeight}px; transform:translateY(${absoluteIndex * effectiveRowHeight}px);`}
			data-sidebar-virtual-row={row.chat.id}
			data-sidebar-virtual-list-row={row.list}
		>
			<svelte:boundary>
				<SidebarChatItem
					session={row.chat}
					{selectedChatId}
					{currentTime}
					{isMobile}
					isPinned={row.isPinned}
					isArchived={row.isArchived}
					{isMultiSelectMode}
					isMultiSelected={isMultiSelected?.(row.chat.id) ?? false}
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
				{#snippet failed()}
					<div
						class="flex h-full items-center border-b border-border/30 px-3 text-sm text-muted-foreground"
						data-sidebar-virtual-row-error={row.chat.id}
					>
						{row.chat.title || m.sidebar_chats_unnamed()}
					</div>
				{/snippet}
			</svelte:boundary>
		</div>
	{/each}
</div>
