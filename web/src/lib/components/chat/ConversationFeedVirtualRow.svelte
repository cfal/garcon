<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { VirtualItem } from '$lib/virt/virtual-list-types.js';
	import ConversationFeedVirtualItem from './ConversationFeedVirtualItem.svelte';
	import type { ConversationFeedVirtualController } from './ConversationFeedVirtualController.svelte.js';
	import type { ConversationFeedRetentionState } from './ConversationFeedRetentionState.svelte.js';
	import type { ConversationVirtualFeedItem } from './conversation-feed-virtual-items.js';
	import type { ConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
	import type { TranscriptPageState } from '$lib/chat/transcript/transcript-page-progress.js';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { ConversationFeedItemState } from './ConversationFeedItemState.svelte.js';
	import MessageRenderFallback from './MessageRenderFallback.svelte';

	interface PermissionDecision {
		allow: PermissionDecisionPayload['allow'];
		alwaysAllow?: PermissionDecisionPayload['alwaysAllow'];
		response?: PermissionDecisionPayload['response'];
		message?: string;
	}

	interface Props {
		virtualItem: VirtualItem;
		item: ConversationVirtualFeedItem;
		controller: ConversationFeedVirtualController;
		retention: ConversationFeedRetentionState;
		renderModel: ConversationFeedRenderModel;
		agentId: SessionAgentId | string;
		showThinking: boolean;
		pendingPermissionRequests: readonly PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		earlierPageState: TranscriptPageState;
		laterPageState: TranscriptPageState;
		loadError?: string | null;
		onRetry?: () => void;
		onLoadEarlier: () => void;
		onLoadLater: () => void;
		onPermissionDecision?: (permissionOccurrenceId: string, decision: PermissionDecision) => void;
		onExitPlanMode?: (permissionOccurrenceId: string, choice: string, plan: string) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow: boolean;
		itemState: ConversationFeedItemState;
	}

	let {
		virtualItem,
		item,
		controller,
		retention,
		renderModel,
		agentId,
		showThinking,
		pendingPermissionRequests,
		chatContext = null,
		earlierPageState,
		laterPageState,
		loadError = null,
		onRetry,
		onLoadEarlier,
		onLoadLater,
		onPermissionDecision,
		onExitPlanMode,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow,
		itemState,
	}: Props = $props();

	let wrapper: HTMLDivElement;
	let releaseFocus: (() => void) | null = null;
	function handleFocusIn(): void {
		releaseFocus ??= retention.acquire(item.key, 'focus');
	}

	function handleFocusOut(): void {
		queueMicrotask(() => {
			if (wrapper?.contains(document.activeElement)) return;
			releaseFocus?.();
			releaseFocus = null;
		});
	}

	onDestroy(() => releaseFocus?.());
</script>

<div
	bind:this={wrapper}
	class="absolute inset-x-0 top-0 w-full"
	style:transform={`translateY(${virtualItem.start}px)`}
	data-index={virtualItem.index}
	data-chat-virtual-item={item.key}
	role="presentation"
	onfocusin={handleFocusIn}
	onfocusout={handleFocusOut}
	{@attach controller.item(virtualItem.key)}
>
	<svelte:boundary>
		<ConversationFeedVirtualItem
			{item}
			{renderModel}
			{agentId}
			{showThinking}
			{pendingPermissionRequests}
			{chatContext}
			{earlierPageState}
			{laterPageState}
			{loadError}
			{onRetry}
			{onLoadEarlier}
			{onLoadLater}
			{onPermissionDecision}
			{onExitPlanMode}
			{onForkChat}
			{onGenerateTitleFromMessage}
			{canForkAtMessageNow}
			{itemState}
			acquireTransientActivity={(close) => retention.acquireTransient(item.key, close)}
		/>
		{#snippet failed(error)}
			<MessageRenderFallback {error} />
		{/snippet}
	</svelte:boundary>
</div>
