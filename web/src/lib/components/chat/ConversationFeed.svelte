<script lang="ts">
	import ConversationMessage from './ConversationMessage.svelte';
	import {
		isToolUseMessage,
		ToolResultMessage,
		PermissionRequestMessage,
		PermissionResolvedMessage,
		PermissionCancelledMessage,
	} from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import { getChatState, getProviderState, getPreferences, getAppShell } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { createMessageIdAllocator } from '$lib/chat/message-id';
	import { Loader2, TriangleAlert, RefreshCw } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		scrollContainer?: HTMLDivElement;
		onscroll?: () => void;
		onPermissionDecision?: (permissionRequestId: string, decision: { allow: boolean; message?: string }) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		pendingPermissionRequests?: PendingPermissionRequest[];
		onRetry?: () => void;
	}

	let { scrollContainer = $bindable(), onscroll, onPermissionDecision, onExitPlanMode, pendingPermissionRequests = [], onRetry }: Props = $props();

	const chatState = getChatState();
	const providerState = getProviderState();
	const preferences = getPreferences();
	const appShell = getAppShell();

	function handleMessagePaneFocusIntent() {
		appShell.requestSidebarRecenterToSelected();
	}

	const getMessageId = createMessageIdAllocator();

	// Reset collision state when messages are cleared (chat switch via
	// resetForNewChat in state.svelte.ts). Prevents unbounded growth of the
	// allocator's internal Set/Map across chat switches.
	// INVARIANT: resetForNewChat must clear chatMessages before populating
	// the next chat's messages, so this effect fires between chat switches.
	$effect(() => {
		if (chatState.chatMessages.length === 0) {
			getMessageId.reset();
		}
	});

	// Builds a lookup of toolId -> ToolResultMessage so tool-use messages
	// can render their results inline. tool-result messages are then
	// skipped from the main render loop.
	const toolResultIndex = $derived.by(() => {
		const index = new Map<string, ToolResultMessage>();
		for (const msg of chatState.visibleMessages) {
			if (msg instanceof ToolResultMessage) {
				index.set(msg.toolId, msg);
			}
		}
		return index;
	});

	// Builds a lookup from permissionRequestId to terminal state so
	// permission-request rows render as pending/resolved/cancelled.
	// Terminal messages (permission-resolved, permission-cancelled) are
	// skipped from the main render loop.
	const permissionTerminalById = $derived.by(() => {
		const map = new Map<string, { state: 'resolved' | 'cancelled'; allowed?: boolean; reason?: string }>();
		for (const m of chatState.visibleMessages) {
			if (m instanceof PermissionResolvedMessage) {
				map.set(m.permissionRequestId, { state: 'resolved', allowed: m.allowed });
			}
			if (m instanceof PermissionCancelledMessage) {
				map.set(m.permissionRequestId, { state: 'cancelled', reason: m.reason });
			}
		}
		return map;
	});

	// Tracks which ExitPlanMode synthetic permission requests are still
	// pending so we can derive terminal state for the tool-use rendering.
	// Matches both PascalCase and snake_case variants since claude-cli
	// forwards tool_name verbatim from the provider.
	const pendingExitPlanIds = $derived(
		new Set(
			pendingPermissionRequests
				.filter((r) => r.toolName === 'ExitPlanMode' || r.toolName === 'exit_plan_mode')
				.map((r) => r.permissionRequestId),
		),
	);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scroll container needs programmatic focus for Ctrl+U/D -->
<div
	bind:this={scrollContainer}
	onscroll={onscroll}
	onfocusin={handleMessagePaneFocusIntent}
	tabindex={-1}
	role="log"
	aria-label="Chat messages"
	class="h-full overflow-y-auto overflow-x-hidden scrollbar-hide px-0 pt-3 pb-10 sm:pt-4 sm:px-4 sm:pb-12 space-y-2 sm:space-y-3 relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
	{#if chatState.isLoadingMessages && chatState.chatMessages.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<Loader2 class="h-4 w-4 animate-spin" />
				<p>{m.chat_chat_loading_chat_messages()}</p>
			</div>
		</div>
	{:else if chatState.loadStatus === 'error' && chatState.chatMessages.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<div class="flex items-center justify-center space-x-2">
				<TriangleAlert class="h-4 w-4 text-destructive" />
				<p class="text-sm">Failed to load messages</p>
			</div>
			{#if chatState.loadError}
				<p class="text-xs mt-1 text-muted-foreground/70">{chatState.loadError}</p>
			{/if}
			{#if onRetry}
				<Button
					variant="outline"
					size="sm"
					class="mt-3"
					onclick={onRetry}
				>
					<RefreshCw class="h-3 w-3 mr-1" />
					Retry
				</Button>
			{/if}
		</div>
	{:else if chatState.chatMessages.length === 0}
		<div class="text-center text-muted-foreground mt-8">
			<p class="text-sm">{m.chat_messages_no_messages()}</p>
			<p class="text-xs mt-1">{m.chat_messages_send_first_message()}</p>
		</div>
	{:else}
		{#if chatState.loadStatus === 'error' && chatState.chatMessages.length > 0}
			<div class="text-center text-sm text-muted-foreground py-2 border-b border-border bg-destructive/5">
				<div class="flex items-center justify-center space-x-2">
					<TriangleAlert class="h-3 w-3 text-destructive" />
					<span>Failed to refresh messages</span>
					{#if onRetry}
						<Button
							variant="ghost"
							size="sm"
							class="text-xs h-6 px-2"
							onclick={onRetry}
						>
							<RefreshCw class="h-3 w-3 mr-1" />
							Retry
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
				{#if chatState.totalMessages > 0}
					<span>
						{m.chat_chat_messages_showing_of({ shown: chatState.chatMessages.length, total: chatState.totalMessages })}
						| {m.chat_chat_messages_scroll_to_load()}
					</span>
				{/if}
				<div class="h-px flex-1 bg-border/70"></div>
			</div>
		{/if}

		{#if !chatState.hasMoreMessages && chatState.chatMessages.length > chatState.visibleMessageCount}
			<div class="my-1 flex items-center gap-2 text-xs text-muted-foreground">
				<div class="h-px flex-1 bg-border/70"></div>
				<span>
					{m.chat_chat_messages_showing_last({ count: chatState.visibleMessageCount, total: chatState.chatMessages.length })}
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

		{#each chatState.visibleMessages as message, index (getMessageId(message))}
			{@const isToolResult = message instanceof ToolResultMessage}
			{@const isPermissionTerminal = message instanceof PermissionResolvedMessage || message instanceof PermissionCancelledMessage}
			{@const isServerExitPlanPermission = message instanceof PermissionRequestMessage && (message.toolName === 'ExitPlanMode' || message.toolName === 'exit_plan_mode')}
			{#if !isToolResult && !isPermissionTerminal && !isServerExitPlanPermission}
				{@const prevMessage = index > 0 ? chatState.visibleMessages[index - 1] : null}
				{@const toolResult = isToolUseMessage(message)
					? toolResultIndex.get(message.toolId)
					: undefined}
				{@const exitPlanId = message.type === 'exit-plan-mode-tool-use'
					? `plan-exit-${message.toolId}`
					: null}
				{@const permTerminal = message instanceof PermissionRequestMessage
					? permissionTerminalById.get(message.permissionRequestId)
					: exitPlanId
						? (pendingExitPlanIds.has(exitPlanId) ? undefined : { state: 'resolved' as const, allowed: true })
						: undefined}
				<svelte:boundary>
					<ConversationMessage
						{message}
						{index}
						{prevMessage}
						{toolResult}
						permissionTerminal={permTerminal}
						{onPermissionDecision}
						{onExitPlanMode}
						provider={providerState.provider}
						showThinking={preferences.showThinking}
					/>
					{#snippet failed(error)}
						<div class="px-4 py-2 text-sm text-destructive bg-destructive/10 rounded border border-destructive/20">
							Failed to render message{error instanceof Error ? `: ${error.message}` : ''}
						</div>
					{/snippet}
				</svelte:boundary>
			{/if}
		{/each}
	{/if}
</div>
