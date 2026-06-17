<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import { getChatSessions, getSplitLayout } from '$lib/context';
	import { type ChatMessage, UserMessage, AssistantMessage, ErrorMessage } from '$shared/chat-types';
	import type { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import DropZoneOverlay from './DropZoneOverlay.svelte';

	interface ChatPaneProps {
		paneId: string;
		chatId: string;
		isFocused: boolean;
		draggedChatId: string | null;
		previewStore: SplitPanePreviewStore;
		onFocus: () => void;
		onClose: () => void;
		onDelete: () => void;
		onDrop: (zone: 'left' | 'right' | 'top' | 'bottom' | 'center') => void;
		focusedContent?: Snippet;
	}

	let {
		paneId,
		chatId,
		isFocused,
		draggedChatId,
		previewStore,
		onFocus,
		onClose,
		onDelete,
		onDrop,
		focusedContent,
	}: ChatPaneProps = $props();

	const sessions = getChatSessions();
	const splitLayout = getSplitLayout();

	let previewScrollContainer: HTMLDivElement | undefined = $state();

	const previewEntry = $derived(previewStore.entry(chatId));
	const previewMessages = $derived(previewEntry.messages.map((entry) => entry.message));
	const isPreviewLoading = $derived(previewEntry.isLoading);
	const chatRecord = $derived(sessions.byId[chatId] ?? null);
	const chatTitle = $derived(chatRecord?.title || 'Untitled');
	const providerLabel = $derived(chatRecord?.agentId || '');
	const isProcessing = $derived(chatRecord?.isProcessing ?? false);
	// Signals a finished, non-focused pane that has new content the user
	// hasn't acknowledged -- lets the user see at a glance which pane
	// needs attention across a 4-up split.
	const needsAttention = $derived(!isProcessing && !isFocused && (chatRecord?.isUnread ?? false));
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
		if (splitLayout.draggedPaneId) {
			splitLayout.swapPanes(splitLayout.draggedPaneId, paneId);
			splitLayout.endDrag();
		} else {
			onDrop('center');
		}
	}

	$effect(() => {
		const id = chatId;
		if (isFocused) return;

		untrack(() => {
			previewStore.restore(id);
			void previewStore.ensureLoaded(id);
		});
	});

	$effect(() => {
		previewEntry.lastSeq;
		previewScrollContainer;
		tick().then(() => {
			if (previewScrollContainer) {
				previewScrollContainer.scrollTop = previewScrollContainer.scrollHeight;
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
		'border transition-colors duration-150',
		isFocused
			? 'border-primary/50 shadow-sm shadow-primary/10'
			: 'border-border/40 hover:border-border/70',
	)}
	role="region"
	aria-label={m.chat_pane_label({ title: chatTitle })}
	data-pane-id={paneId}
>
	<!-- Pane Header: draggable for rearranging, drop target for swap/replace -->
	<div
		class={cn(
			'flex items-center gap-1.5 px-2.5 py-1 flex-shrink-0 select-none cursor-grab',
			'border-b transition-colors duration-150',
			headerDropHover
				? 'bg-accent/30 border-accent/50'
				: isFocused
					? 'bg-primary/5 border-primary/20'
					: 'bg-muted/20 border-border/30 hover:bg-muted/40',
		)}
		draggable={true}
		onclick={onFocus}
		onkeydown={(e) => {
			if (e.key === 'Enter') onFocus();
		}}
		ondragstart={handlePaneHeaderDragStart}
		ondragend={handlePaneHeaderDragEnd}
		ondragover={handleHeaderDragOver}
		ondragleave={handleHeaderDragLeave}
		ondrop={handleHeaderDrop}
		role="button"
		tabindex="0"
	>
		<MessageSquare
			class={cn(
				'w-3 h-3 flex-shrink-0 transition-colors duration-150',
				isFocused ? 'text-primary/80' : 'text-muted-foreground/60',
			)}
		/>
		<span
			class={cn(
				'text-[11px] font-medium truncate flex-1 min-w-0 transition-colors duration-150',
				isFocused ? 'text-foreground' : 'text-muted-foreground',
			)}
		>
			{chatTitle}
		</span>
		{#if providerLabel}
			<span
				class="text-[9px] text-muted-foreground/70 bg-muted/40 px-1 py-px rounded flex-shrink-0"
			>
				{providerLabel}
			</span>
		{/if}
		{#if isProcessing}
			<span class="relative flex h-1.5 w-1.5 flex-shrink-0" aria-label={m.chat_pane_processing()}>
				<span
					class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/50 opacity-75"
				></span>
				<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary"></span>
			</span>
		{:else if needsAttention}
			<span class="relative flex h-2 w-2 flex-shrink-0" aria-label={m.chat_pane_activity()}>
				<span
					class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indicator-attention/60 opacity-60"
				></span>
				<span
					class="relative inline-flex rounded-full h-2 w-2 bg-indicator-attention shadow-sm shadow-indicator-attention/40"
				></span>
			</span>
		{/if}
		<div
			class="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/pane:opacity-100 transition-opacity duration-150"
			class:opacity-100={isFocused}
		>
			<button
				class="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground/50 hover:text-destructive transition-colors flex-shrink-0"
				onclick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				aria-label={m.sidebar_delete_confirmation_delete_chat()}
			>
				<Trash2 class="w-2.5 h-2.5" />
			</button>
			<button
				class="p-0.5 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground/50 hover:text-destructive transition-colors flex-shrink-0"
				onclick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				aria-label={m.chat_pane_close()}
			>
				<X class="w-2.5 h-2.5" />
			</button>
		</div>
	</div>

	<!-- Content area: full interactive workspace for focused pane, composer target for others -->
	{#if focusedContent && isFocused}
		<div class="flex-1 min-h-0 overflow-hidden" data-pane-body>
			{@render focusedContent()}
		</div>
	{:else}
		<div
			data-pane-body
			class={cn(
				'flex-1 min-h-0 flex flex-col gap-2 p-2 text-left',
				'bg-background/40 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				'transition-colors',
			)}
			onclick={onFocus}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') onFocus();
			}}
			role="button"
			tabindex="0"
			aria-label={m.chat_pane_focus_composer({ title: chatTitle })}
		>
			<div
				bind:this={previewScrollContainer}
				class="min-h-0 flex-1 overflow-y-auto space-y-1.5 scrollbar-hide"
				role="log"
				aria-label={m.chat_pane_preview({ title: chatTitle })}
			>
				{#if isPreviewLoading && previewMessages.length === 0}
					<div class="flex items-center justify-center h-full text-muted-foreground/60 text-[11px]">
						Loading messages...
					</div>
				{:else if previewMessages.length === 0}
					<div class="flex items-center justify-center h-full text-muted-foreground/60 text-[11px]">
						No messages yet
					</div>
				{:else}
					{#each previewMessages as msg}
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
			<div class="rounded-lg border border-border/70 bg-card/95 shadow-sm overflow-hidden">
				<div class="min-h-[72px] px-3 py-2 text-sm text-muted-foreground">
					{m.chat_composer_reply_placeholder()}
				</div>
				<div class="flex items-center justify-between border-t border-border/70 px-2 py-1.5">
					<div class="flex items-center gap-1.5 text-muted-foreground/70">
						<ImagePlus class="size-3.5" />
						<span class="h-2.5 w-2.5 rounded-full border border-current"></span>
						<span class="h-2.5 w-2.5 rounded-full border border-current"></span>
					</div>
					<span
						class="inline-flex size-7 items-center justify-center rounded-full border border-primary/30 bg-primary/90 text-primary-foreground"
					>
						<SendHorizontal class="size-3.5" />
					</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Focus indicator: thin accent bar at top instead of bottom for cleaner look -->
	{#if isFocused}
		<div
			class="absolute top-0 left-2 right-2 h-0.5 bg-primary/60 rounded-b-full pointer-events-none"
		></div>
	{/if}

	<!-- Drop zone overlay for drag-and-drop -->
	{#if showDropZone}
		<DropZoneOverlay {onDrop} />
	{/if}
</div>
