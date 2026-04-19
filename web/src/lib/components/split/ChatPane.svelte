<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import { getChatSessions, getWs, getSplitLayout } from '$lib/context';
	import { LocalChatSnapshotCache } from '$lib/chat/chat-snapshot-cache';
	import { parseChatMessages, type ChatMessage, UserMessage, AssistantMessage, ErrorMessage } from '$shared/chat-types';
	import { ChatLogQueryRequest } from '$shared/ws-requests';
	import X from '@lucide/svelte/icons/x';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import DropZoneOverlay from './DropZoneOverlay.svelte';

	interface ChatPaneProps {
		paneId: string;
		chatId: string;
		isFocused: boolean;
		draggedChatId: string | null;
		onFocus: () => void;
		onClose: () => void;
		onDelete: () => void;
		onDrop: (zone: 'left' | 'right' | 'top' | 'bottom' | 'center') => void;
		focusedContent?: Snippet;
	}

	let { paneId, chatId, isFocused, draggedChatId, onFocus, onClose, onDelete, onDrop, focusedContent }: ChatPaneProps = $props();

	const sessions = getChatSessions();
	const ws = getWs();
	const splitLayout = getSplitLayout();
	const snapshotCache = new LocalChatSnapshotCache();

	let messages = $state<ChatMessage[]>([]);
	let isLoading = $state(true);
	let scrollContainer: HTMLDivElement | undefined = $state();

	const chatRecord = $derived(sessions.byId[chatId] ?? null);
	const chatTitle = $derived(chatRecord?.title || 'Untitled');
	const providerLabel = $derived(chatRecord?.provider || '');
	const isProcessing = $derived(chatRecord?.isProcessing ?? false);
	// Signals a finished, non-focused pane that has new content the user
	// hasn't acknowledged -- lets the user see at a glance which pane
	// needs attention across a 4-up split.
	const needsAttention = $derived(
		!isProcessing && !isFocused && (chatRecord?.isUnread ?? false),
	);
	const showDropZone = $derived(draggedChatId !== null && draggedChatId !== chatId);
	let headerDropHover = $state(false);

	// Pane header is draggable for rearranging splits.
	function handlePaneHeaderDragStart(e: DragEvent) {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', chatId);
		splitLayout.startPaneDrag(paneId, chatId);
	}

	function handlePaneHeaderDragEnd() {
		splitLayout.endDrag();
	}

	function handleHeaderDragOver(e: DragEvent) {
		if (!showDropZone) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		headerDropHover = true;
	}

	function handleHeaderDragLeave() {
		headerDropHover = false;
	}

	function handleHeaderDrop(e: DragEvent) {
		if (!showDropZone) return;
		e.preventDefault();
		e.stopPropagation();
		headerDropHover = false;
		// Pane-to-pane drag: swap the two panes.
		if (splitLayout.draggedPaneId) {
			splitLayout.swapPanes(splitLayout.draggedPaneId, paneId);
			splitLayout.endDrag();
		} else {
			onDrop('center');
		}
	}

	// Loads messages when chatId changes (on mount and after swap/replace).
	$effect(() => {
		const id = chatId;
		messages = [];
		isLoading = true;

		const cached = snapshotCache.restore(id);
		if (cached) {
			messages = cached.messages;
			isLoading = false;
		}

		if (ws.isConnected) {
			fetchMessagesForChat(id);
		}
	});

	async function fetchMessagesForChat(targetChatId: string) {
		try {
			const data = await ws.sendRequest<{
				messages?: ChatMessage[];
				hasMore?: boolean;
				total?: number;
			}>(new ChatLogQueryRequest(null, targetChatId, 50, 0), 10_000);

			// Guard against stale responses after rapid chatId changes.
			if (targetChatId !== chatId) return;

			const parsed = parseChatMessages(data.messages);
			if (parsed.length > 0) {
				messages = parsed;
			}
		} catch {
			// Uses cached messages if fetch fails.
		} finally {
			if (targetChatId === chatId) {
				isLoading = false;
			}
		}
	}

	// Scrolls to bottom after DOM updates whenever messages change or the
	// scroll container mounts (e.g. when pane transitions from focused to
	// unfocused and the read-only message list appears).
	$effect(() => {
		messages;
		scrollContainer;
		tick().then(() => {
			if (scrollContainer) {
				scrollContainer.scrollTop = scrollContainer.scrollHeight;
			}
		});
	});

	function getMessageText(msg: ChatMessage): string | null {
		if (msg instanceof UserMessage) return msg.content;
		if (msg instanceof AssistantMessage) return msg.content;
		if (msg instanceof ErrorMessage) return msg.content;
		return null;
	}

	function getMessageRole(msg: ChatMessage): 'user' | 'assistant' | 'system' | null {
		if (msg instanceof UserMessage) return 'user';
		if (msg instanceof AssistantMessage) return 'assistant';
		if (msg instanceof ErrorMessage) return 'system';
		return null;
	}
</script>

<div
	class={cn(
		'h-full w-full flex flex-col relative overflow-hidden rounded-lg group/pane',
		'border transition-all duration-200',
		isFocused
			? 'border-primary/40 shadow-sm shadow-primary/10'
			: 'border-border/40 hover:border-border/70',
	)}
	role="region"
	aria-label="Chat pane: {chatTitle}"
>
	<!-- Pane Header: draggable for rearranging, drop target for swap/replace -->
	<div
		class={cn(
			'flex items-center gap-1.5 px-2.5 py-1 flex-shrink-0 select-none cursor-grab',
			'border-b transition-all duration-150',
			headerDropHover
				? 'bg-accent/30 border-accent/50'
				: isFocused
					? 'bg-primary/5 border-primary/15'
					: 'bg-muted/20 border-border/30 hover:bg-muted/40',
		)}
		draggable={true}
		onclick={onFocus}
		onkeydown={(e) => { if (e.key === 'Enter') onFocus(); }}
		ondragstart={handlePaneHeaderDragStart}
		ondragend={handlePaneHeaderDragEnd}
		ondragover={handleHeaderDragOver}
		ondragleave={handleHeaderDragLeave}
		ondrop={handleHeaderDrop}
		role="button"
		tabindex="0"
	>
		<MessageSquare class={cn(
			'w-3 h-3 flex-shrink-0 transition-colors duration-150',
			isFocused ? 'text-primary/70' : 'text-muted-foreground/60',
		)} />
		<span class={cn(
			'text-[11px] font-medium truncate flex-1 min-w-0 transition-colors duration-150',
			isFocused ? 'text-foreground' : 'text-muted-foreground',
		)}>
			{chatTitle}
		</span>
		{#if providerLabel}
			<span class="text-[9px] text-muted-foreground/70 bg-muted/40 px-1 py-px rounded flex-shrink-0">
				{providerLabel}
			</span>
		{/if}
		{#if isProcessing}
			<span class="relative flex h-1.5 w-1.5 flex-shrink-0" aria-label="Chat is processing">
				<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/50 opacity-75"></span>
				<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary"></span>
			</span>
		{:else if needsAttention}
			<span class="relative flex h-2 w-2 flex-shrink-0" aria-label="Chat finished, new activity">
				<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indicator-attention/60 opacity-60"></span>
				<span class="relative inline-flex rounded-full h-2 w-2 bg-indicator-attention shadow-sm shadow-indicator-attention/40"></span>
			</span>
		{/if}
		<div class="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/pane:opacity-100 transition-opacity duration-150"
			 class:opacity-100={isFocused}
		>
			<button
				class="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground/50 hover:text-destructive transition-colors flex-shrink-0"
				onclick={(e) => { e.stopPropagation(); onDelete(); }}
				aria-label="Delete chat"
			>
				<Trash2 class="w-2.5 h-2.5" />
			</button>
			<button
				class="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground/50 hover:text-destructive transition-colors flex-shrink-0"
				onclick={(e) => { e.stopPropagation(); onClose(); }}
				aria-label="Close pane"
			>
				<X class="w-2.5 h-2.5" />
			</button>
		</div>
	</div>

	<!-- Content area: full interactive workspace for focused pane, read-only for others -->
	{#if focusedContent && isFocused}
		<div class="flex-1 min-h-0 overflow-hidden">
			{@render focusedContent()}
		</div>
	{:else}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -- click delegates focus to this pane -->
		<div
			bind:this={scrollContainer}
			class={cn(
				'flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5 scrollbar-hide',
				!isFocused && 'opacity-75',
			)}
			onclick={onFocus}
			role="log"
		>
			{#if isLoading}
				<div class="flex items-center justify-center h-full">
					<div class="flex items-center gap-2 text-muted-foreground text-xs">
						<div class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
						<span class="text-[11px]">Loading...</span>
					</div>
				</div>
			{:else if messages.length === 0}
				<div class="flex items-center justify-center h-full text-muted-foreground/60 text-[11px]">
					No messages yet
				</div>
			{:else}
				{#each messages as msg, i}
					{@const text = getMessageText(msg)}
					{@const role = getMessageRole(msg)}
					{#if text && role}
						<div
							class={cn(
								'text-[11px] leading-relaxed rounded-md px-2.5 py-1.5 max-w-full',
								role === 'user'
									? 'bg-primary/8 text-foreground ml-6'
									: role === 'assistant'
										? 'bg-muted/40 text-foreground mr-3'
										: 'bg-destructive/10 text-destructive',
							)}
						>
							<div class="whitespace-pre-wrap break-words line-clamp-[20]">{text}</div>
						</div>
					{/if}
				{/each}
			{/if}
		</div>
	{/if}

	<!-- Focus indicator: thin accent bar at top instead of bottom for cleaner look -->
	{#if isFocused}
		<div class="absolute top-0 left-2 right-2 h-0.5 bg-primary/50 rounded-b-full"></div>
	{/if}

	<!-- Drop zone overlay for drag-and-drop -->
	{#if showDropZone}
		<DropZoneOverlay {onDrop} />
	{/if}
</div>
