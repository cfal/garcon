<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import { getChatSessions, getLocalSettings, getSplitLayout } from '$lib/context';
	import type { SplitPanePreviewStore } from '$lib/chat/split-pane-preview-store.svelte';
	import type { ChatDisplayRow } from '$lib/chat/state.svelte';
	import type { ConversationMessageChatContext } from '$lib/chat/conversation-message-context';
	import {
		CHAT_FEED_CONTENT_BASE_CLASS,
		CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS,
		CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
	} from '$lib/chat/chat-max-width';
	import ConversationTranscript from '$lib/components/chat/ConversationTranscript.svelte';
	import { Scrollbar } from '$lib/components/ui/scroll-area';
	import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';
	import SplitPaneComposerBar from './SplitPaneComposerBar.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';

	interface ChatPaneProps {
		paneId: string;
		chatId: string;
		isFocused: boolean;
		previewStore: SplitPanePreviewStore;
		textScale?: number;
		onFocus: () => void;
		onClose: () => void;
		onMaximize: () => void;
		focusedContent?: Snippet;
	}

	let {
		paneId,
		chatId,
		isFocused,
		previewStore,
		textScale = 1,
		onFocus,
		onClose,
		onMaximize,
		focusedContent,
	}: ChatPaneProps = $props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const splitLayout = getSplitLayout();

	let previewScrollContainer: HTMLDivElement | null = $state(null);

	const previewEntry = $derived(previewStore.entry(chatId));
	const previewRows = $derived.by((): ChatDisplayRow[] =>
		previewEntry.messages.map((entry) => ({
			kind: 'message',
			id: `${previewEntry.generationId}:${entry.seq}`,
			message: entry.message,
		})),
	);
	const isPreviewLoading = $derived(previewEntry.isLoading);
	const chatRecord = $derived(sessions.byId[chatId] ?? null);
	const chatTitle = $derived(chatRecord?.title || 'Untitled');
	const providerLabel = $derived(chatRecord?.agentId || '');
	const previewAgentId = $derived(providerLabel || 'unknown');
	const previewChatContext = $derived.by(
		(): ConversationMessageChatContext => ({
			chatId,
			projectPath: chatRecord?.projectPath ?? null,
		}),
	);
	const previewContentClass = $derived(
		cn(CHAT_FEED_CONTENT_BASE_CLASS, CHAT_MAX_WIDTH_FEED_CONTENT_CLASS[localSettings.chatMaxWidth]),
	);
	const previewViewportClass = $derived(
		cn(
			'h-full overflow-y-auto overflow-x-hidden relative outline-none pt-3 sm:pt-4 pb-3 sm:pb-4',
			CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS[localSettings.chatMaxWidth],
		),
	);
	const isProcessing = $derived(chatRecord?.isProcessing ?? false);
	// Signals a finished, non-focused pane that has new content the user
	// hasn't acknowledged -- lets the user see at a glance which pane
	// needs attention across a 4-up split.
	const needsAttention = $derived(!isProcessing && !isFocused && (chatRecord?.isUnread ?? false));
	let lastPointerFocusAt = 0;

	// Grabbing the header starts a pane drag; the workspace-level drop layer
	// (which covers every pane during a drag) resolves the target and swap.
	function handlePaneHeaderDragStart(e: DragEvent) {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', chatId);
		splitLayout.startPaneDrag(paneId, chatId);
	}

	function handlePaneHeaderDragEnd() {
		splitLayout.endDrag();
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

	function isInteractiveTarget(target: EventTarget | null, container: EventTarget | null): boolean {
		if (!(target instanceof Element) || !(container instanceof Element)) return false;
		const interactive = target.closest('button,a,input,textarea,select,[role="button"]');
		return Boolean(interactive && interactive !== container);
	}

	function handlePreviewClick(event: MouseEvent): void {
		if (consumePointerFocusClick()) return;
		if (isFocused || isInteractiveTarget(event.target, event.currentTarget)) return;
		onFocus();
	}

	function handlePanePointerDown(event: PointerEvent): void {
		if (isFocused || isInteractiveTarget(event.target, event.currentTarget)) return;
		event.preventDefault();
		lastPointerFocusAt = performance.now();
		onFocus();
	}

	function handlePaneHeaderPointerDown(event: PointerEvent): void {
		if (isFocused || isInteractiveTarget(event.target, event.currentTarget)) return;
		lastPointerFocusAt = performance.now();
		onFocus();
	}

	function handlePaneHeaderClick(event: MouseEvent): void {
		if (consumePointerFocusClick()) return;
		if (isFocused || isInteractiveTarget(event.target, event.currentTarget)) return;
		onFocus();
	}

	function consumePointerFocusClick(): boolean {
		if (lastPointerFocusAt === 0) return false;
		const ageMs = performance.now() - lastPointerFocusAt;
		lastPointerFocusAt = 0;
		return ageMs < 750;
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
	<!-- Pane header: grab to drag this pane onto another for a swap. -->
	<div
		class={cn(
			'flex items-center gap-1.5 px-2.5 py-1 flex-shrink-0 select-none cursor-grab',
			'border-b transition-colors duration-150',
			isFocused
				? 'bg-primary/5 border-primary/20'
				: 'bg-muted/20 border-border/30 hover:bg-muted/40',
		)}
		draggable={true}
		onpointerdown={handlePaneHeaderPointerDown}
		onclick={handlePaneHeaderClick}
		onkeydown={(e) => {
			if (e.key === 'Enter') onFocus();
		}}
		ondragstart={handlePaneHeaderDragStart}
		ondragend={handlePaneHeaderDragEnd}
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
				class="p-0.5 rounded hover:bg-accent hover:text-foreground text-muted-foreground/50 transition-colors flex-shrink-0"
				onclick={(e) => {
					e.stopPropagation();
					onMaximize();
				}}
				aria-label={m.chat_pane_maximize()}
			>
				<Maximize2 class="w-2.5 h-2.5" />
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

	<!-- Content area: full interactive workspace for focused pane, transcript preview for others -->
	{#if focusedContent && isFocused}
		<div class="flex-1 min-h-0 overflow-hidden" data-pane-body>
			{@render focusedContent()}
		</div>
	{:else}
		<div
			data-pane-body
			class={cn(
				'flex-1 min-h-0 flex flex-col text-left',
				'bg-background/40 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				'transition-colors',
			)}
			onpointerdown={handlePanePointerDown}
			onclick={handlePreviewClick}
			onkeydown={(e) => {
				if (isInteractiveTarget(e.target, e.currentTarget)) return;
				if (e.key === 'Enter' || e.key === ' ') onFocus();
			}}
			role="button"
			tabindex="0"
			aria-label={m.chat_pane_focus_composer({ title: chatTitle })}
		>
			<ScrollAreaPrimitive.Root type="auto" class="min-h-0 flex-1 overflow-hidden relative">
				<ScrollAreaPrimitive.Viewport
					bind:ref={previewScrollContainer}
					class={previewViewportClass}
					role="log"
					aria-label={m.chat_pane_preview({ title: chatTitle })}
				>
					{#if isPreviewLoading && previewRows.length === 0}
						<div
							class="flex items-center justify-center h-full text-muted-foreground/60 text-[11px]"
						>
							{m.chat_chat_loading_chat_messages()}
						</div>
					{:else if previewRows.length === 0}
						<div
							class="flex items-center justify-center h-full text-muted-foreground/60 text-[11px]"
						>
							{m.chat_messages_no_messages()}
						</div>
					{:else}
						<div class={previewContentClass}>
							<ConversationTranscript
								rows={previewRows}
								agentId={previewAgentId}
								showThinking={localSettings.showThinking}
								chatContext={previewChatContext}
								{textScale}
							/>
						</div>
					{/if}
				</ScrollAreaPrimitive.Viewport>
				<Scrollbar orientation="vertical" class="w-1.5" />
				<ScrollAreaPrimitive.Corner />
			</ScrollAreaPrimitive.Root>
			<SplitPaneComposerBar {chatId} title={chatTitle} {onFocus} />
		</div>
	{/if}

	<!-- Focus indicator: thin accent bar at top instead of bottom for cleaner look -->
	{#if isFocused}
		<div
			class="absolute top-0 left-2 right-2 h-0.5 bg-primary/60 rounded-b-full pointer-events-none"
		></div>
	{/if}
</div>
