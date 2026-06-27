<script lang="ts">
	import ConversationTranscript from './ConversationTranscript.svelte';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import {
		getChatState,
		getAgentState,
		getLocalSettings,
		getAppShell,
		getModelCatalog,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import {
		CHAT_FEED_CONTENT_BASE_CLASS,
		CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
		CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS,
	} from '$lib/chat/chat-max-width';
	import { Loader2, TriangleAlert, RefreshCw } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Scrollbar } from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils/cn';
	import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';

	interface Props {
		scrollContainer?: HTMLDivElement | null;
		onscroll?: () => void;
		onPermissionDecision?: (
			permissionRequestId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		pendingPermissionRequests?: PendingPermissionRequest[];
		onRetry?: () => void;
		reserveLoadingStatusSpace?: boolean;
		textScale?: number;
		onForkChat?: (upToSeq?: number) => void;
	}

	let {
		scrollContainer = $bindable(null),
		onscroll,
		onPermissionDecision,
		onExitPlanMode,
		pendingPermissionRequests = [],
		onRetry,
		reserveLoadingStatusSpace = false,
		textScale = 1,
		onForkChat,
	}: Props = $props();

	const chatState = getChatState();
	const agentState = getAgentState();
	const localSettings = getLocalSettings();
	const appShell = getAppShell();
	const modelCatalog = getModelCatalog();

	const canFork = $derived(modelCatalog.supportsFork(agentState.agentId));

	function handleMessagePaneFocusIntent() {
		appShell.requestSidebarRecenterToSelected();
	}

	const feedScrollAreaClass = 'h-full overflow-hidden relative';
	const feedViewportClass = $derived(
		cn(
			'h-full overflow-y-auto overflow-x-hidden relative outline-none focus-visible:ring-2 focus-visible:ring-ring',
			'pt-3 sm:pt-4',
			reserveLoadingStatusSpace ? 'pb-14' : 'pb-3 sm:pb-4',
			CHAT_MAX_WIDTH_FEED_VIEWPORT_CLASS[localSettings.chatMaxWidth],
		),
	);
	const feedContentClass = $derived(
		cn(CHAT_FEED_CONTENT_BASE_CLASS, CHAT_MAX_WIDTH_FEED_CONTENT_CLASS[localSettings.chatMaxWidth]),
	);
</script>

{#snippet feedContent()}
	{#if chatState.isLoadingMessages && chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<Loader2 class="h-4 w-4 animate-spin" />
				<p>{m.chat_chat_loading_chat_messages()}</p>
			</div>
		</div>
	{:else if chatState.loadStatus === 'error' && chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<TriangleAlert class="h-4 w-4 text-destructive" />
				<p class="text-sm">{m.chat_feed_failed_to_load()}</p>
			</div>
			{#if chatState.loadError}
				<p class="text-xs mt-1 text-muted-foreground/70">{chatState.loadError}</p>
			{/if}
			{#if onRetry}
				<Button variant="outline" size="sm" class="mt-3" onclick={onRetry}>
					<RefreshCw class="h-3 w-3 mr-1" />
					{m.chat_feed_retry()}
				</Button>
			{/if}
		</div>
	{:else if chatState.displayMessageCount === 0}
		<div class="text-center text-muted-foreground mt-8">
			<p class="text-sm">{m.chat_messages_no_messages()}</p>
			<p class="text-xs mt-1">{m.chat_messages_send_first_message()}</p>
		</div>
	{:else}
		{#if chatState.loadStatus === 'error' && chatState.displayMessageCount > 0}
			<div
				class="text-center text-sm text-muted-foreground py-2 border-b border-border bg-destructive/5"
			>
				<div class="flex items-center justify-center space-x-2">
					<TriangleAlert class="h-3 w-3 text-destructive" />
					<span>{m.chat_feed_failed_to_refresh()}</span>
					{#if onRetry}
						<Button variant="ghost" size="sm" class="text-xs h-6 px-2" onclick={onRetry}>
							<RefreshCw class="h-3 w-3 mr-1" />
							{m.chat_feed_retry()}
						</Button>
					{/if}
				</div>
			</div>
		{/if}
		{#if chatState.isLoadingMoreMessages}
			<div class="my-1 flex items-center gap-2 text-xs text-muted-foreground">
				<div class="h-px flex-1 bg-border/70"></div>
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				<span>{m.chat_chat_loading_older_messages()}</span>
				<div class="h-px flex-1 bg-border/70"></div>
			</div>
		{/if}

		{#if chatState.hasMoreMessages && !chatState.isLoadingMoreMessages}
			<div class="my-1 flex items-center gap-2 text-xs text-muted-foreground">
				<div class="h-px flex-1 bg-border/70"></div>
				<span>{m.chat_chat_messages_scroll_to_load()}</span>
				<div class="h-px flex-1 bg-border/70"></div>
			</div>
		{/if}

		{#if !chatState.hasMoreMessages && chatState.displayMessageCount > chatState.visibleMessageCount}
			<div class="my-1 flex items-center gap-2 text-xs text-muted-foreground">
				<div class="h-px flex-1 bg-border/70"></div>
				<span>
					{m.chat_chat_messages_showing_last({
						count: chatState.visibleMessageCount,
						total: chatState.displayMessageCount,
					})}
				</span>
				<Button
					variant="link"
					class="text-primary hover:text-primary/80 underline p-0 h-auto text-xs"
					onclick={() => chatState.loadEarlierMessages()}
				>
					{m.chat_chat_messages_load_earlier()}
				</Button>
				<div class="h-px flex-1 bg-border/70"></div>
			</div>
		{/if}

		<ConversationTranscript
			rows={chatState.visibleRows}
			agentId={agentState.agentId}
			showThinking={localSettings.showThinking}
			{textScale}
			{pendingPermissionRequests}
			{onPermissionDecision}
			{onExitPlanMode}
			onForkChat={canFork ? onForkChat : undefined}
		/>
	{/if}
{/snippet}

<ScrollAreaPrimitive.Root type="auto" class={feedScrollAreaClass}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scroll container needs programmatic focus for Ctrl+U/D -->
	<ScrollAreaPrimitive.Viewport
		bind:ref={scrollContainer}
		{onscroll}
		onfocusin={handleMessagePaneFocusIntent}
		tabindex={-1}
		role="log"
		aria-label={m.chat_messages_region()}
		class={feedViewportClass}
	>
		<div class={feedContentClass}>
			{@render feedContent()}
		</div>
	</ScrollAreaPrimitive.Viewport>
	<Scrollbar orientation="vertical" class="w-1.5" />
	<ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
