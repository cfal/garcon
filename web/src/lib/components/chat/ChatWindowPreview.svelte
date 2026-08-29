<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { cn } from '$lib/utils/cn';
	import { getChatSessions, getLocalSettings } from '$lib/context';
	import type { ChatWindowPreviewStore } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import {
		CHAT_FEED_CONTENT_BASE_CLASS,
		CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
		CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import ConversationTranscript from './ConversationTranscript.svelte';
	import { Scrollbar } from '$lib/components/ui/scroll-area';
	import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		chatId,
		previewStore,
		textScale = 1,
		onFocus,
	}: {
		chatId: string;
		previewStore: ChatWindowPreviewStore;
		textScale?: number;
		onFocus: () => void;
	} = $props();

	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	let previewScrollContainer: HTMLDivElement | null = $state(null);
	let lastPointerFocusAt = 0;

	const previewEntry = $derived(previewStore.entry(chatId));
	const previewRows = $derived.by((): ChatDisplayRow[] =>
		previewEntry.messages.map((entry) => ({
			kind: 'message',
			id: `${previewEntry.transcriptViewId}:${entry.ordinal}`,
			ordinal: entry.ordinal,
			message: entry.message,
		})),
	);
	const chatRecord = $derived(sessions.byId[chatId] ?? null);
	const chatTitle = $derived(chatRecord?.title || m.chat_window_untitled());
	const previewChatContext = $derived.by((): ConversationMessageChatContext => ({
		chatId,
		projectPath: chatRecord?.projectPath ?? null,
	}));
	const previewContentClass = $derived(
		cn(CHAT_FEED_CONTENT_BASE_CLASS, CHAT_MAX_WIDTH_FEED_CONTENT_CLASS[localSettings.chatMaxWidth]),
	);
	const previewViewportClass = $derived(
		cn(
			'h-full overflow-y-auto overflow-x-hidden relative outline-none pt-3 sm:pt-4 pb-3 sm:pb-4',
			CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS[localSettings.chatMaxWidth],
		),
	);

	$effect(() => {
		const id = chatId;
		untrack(() => {
			previewStore.restore(id);
			void previewStore.ensureLoaded(id);
		});
	});

	$effect(() => {
		previewEntry.lastOrdinal;
		previewScrollContainer;
		tick().then(() => {
			if (previewScrollContainer)
				previewScrollContainer.scrollTop = previewScrollContainer.scrollHeight;
		});
	});

	$effect(() => {
		const region = previewScrollContainer;
		if (!region) return;
		return registerNativeWorkspaceScrollRegion(region, 'contextual');
	});

	function isInteractiveTarget(target: EventTarget | null, container: EventTarget | null): boolean {
		if (!(target instanceof Element) || !(container instanceof Element)) return false;
		const interactive = target.closest('button,a,input,textarea,select,[role="button"]');
		return Boolean(interactive && interactive !== container);
	}

	function consumePointerFocusClick(): boolean {
		if (lastPointerFocusAt === 0) return false;
		const ageMs = performance.now() - lastPointerFocusAt;
		lastPointerFocusAt = 0;
		return ageMs < 750;
	}

	function handlePointerDown(event: PointerEvent): void {
		if (isInteractiveTarget(event.target, event.currentTarget)) return;
		event.preventDefault();
		lastPointerFocusAt = performance.now();
		onFocus();
	}

	function handleClick(event: MouseEvent): void {
		if (consumePointerFocusClick() || isInteractiveTarget(event.target, event.currentTarget))
			return;
		onFocus();
	}
</script>

<div
	class={cn(
		'flex h-full min-h-0 flex-col text-left',
		'bg-background/40 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
		'transition-colors',
	)}
	onpointerdown={handlePointerDown}
	onclick={handleClick}
	onkeydown={(event) => {
		if (isInteractiveTarget(event.target, event.currentTarget)) return;
		if (event.key === 'Enter' || event.key === ' ') onFocus();
	}}
	role="button"
	tabindex="0"
	aria-label={m.chat_window_focus_composer({ title: chatTitle })}
	data-chat-window-preview={chatId}
>
	<ScrollAreaPrimitive.Root type="auto" class="min-h-0 flex-1 overflow-hidden relative">
		<ScrollAreaPrimitive.Viewport
			bind:ref={previewScrollContainer}
			class={previewViewportClass}
			role="log"
			aria-live="polite"
			aria-label={m.chat_window_preview({ title: chatTitle })}
		>
			{#if previewEntry.isLoading && previewRows.length === 0}
				<div class="flex h-full items-center justify-center text-[11px] text-muted-foreground/60">
					{m.chat_chat_loading_chat_messages()}
				</div>
			{:else if previewRows.length === 0}
				<div class="flex h-full items-center justify-center text-[11px] text-muted-foreground/60">
					{m.chat_messages_no_messages()}
				</div>
			{:else}
				<div class={previewContentClass}>
					<ConversationTranscript
						rows={previewRows}
						agentId={chatRecord?.agentId || 'unknown'}
						showThinking={localSettings.showThinking}
						hiddenToolTypes={localSettings.hiddenToolTypes}
						chatContext={previewChatContext}
						{textScale}
					/>
				</div>
			{/if}
		</ScrollAreaPrimitive.Viewport>
		<Scrollbar orientation="vertical" class="w-1.5" />
		<ScrollAreaPrimitive.Corner />
	</ScrollAreaPrimitive.Root>
</div>
