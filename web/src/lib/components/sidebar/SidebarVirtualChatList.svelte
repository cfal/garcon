<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
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

	let effectiveRowHeight = $derived(
		rowHeight ?? (isMobile ? MOBILE_CHAT_ROW_HEIGHT : DESKTOP_CHAT_ROW_HEIGHT)
	);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	const virtualWindow = new FixedVirtualWindow({
		get itemCount() { return rows.length; },
		get rowHeight() { return effectiveRowHeight; },
		get overscan() { return overscan; },
		get viewportRef() { return viewportRef; },
		get bottomPadding() { return bottomPadding; },
	});
	let visibleRows = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, row: rows[index] }))
			.filter((entry): entry is { index: number; row: SidebarVirtualChatRow } => Boolean(entry.row))
	);

	function scrollChatIntoView(chatId: string | null): void {
		if (!chatId) return;
		const index = rows.findIndex((row) => row.chat.id === chatId);
		virtualWindow.scrollIndexIntoView(index);
	}

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	// Tracks browser-owned viewport metrics that Svelte cannot derive.
	$effect(() => {
		return virtualWindow.observeViewport();
	});

	onMount(() => appShell.onSidebarRecenterRequested(() => {
		scrollChatIntoView(selectedChatId);
	}));
</script>

<div
	class="relative min-h-full"
	style={`height:${virtualWindow.totalHeight}px;`}
	data-sidebar-virtual-list
>
	{#each visibleRows as entry (entry.row.key)}
		<div
			class="absolute left-0 right-0 top-0 overflow-hidden bg-sidebar-chat-item-bg"
			style={`height:${effectiveRowHeight}px; transform:translateY(${virtualWindow.getOffset(entry.index)}px);`}
			data-sidebar-virtual-row={entry.row.chat.id}
			data-sidebar-virtual-list-row={entry.row.list}
		>
			<svelte:boundary>
				<SidebarChatItem
					session={entry.row.chat}
					{selectedChatId}
					{currentTime}
					{isMobile}
					isPinned={entry.row.isPinned}
					isArchived={entry.row.isArchived}
					{isMultiSelectMode}
					isMultiSelected={isMultiSelected?.(entry.row.chat.id) ?? false}
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
						data-sidebar-virtual-row-error={entry.row.chat.id}
					>
						{entry.row.chat.title || m.sidebar_chats_unnamed()}
					</div>
				{/snippet}
			</svelte:boundary>
		</div>
	{/each}
</div>
