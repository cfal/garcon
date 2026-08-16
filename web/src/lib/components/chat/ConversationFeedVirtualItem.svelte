<script lang="ts">
	import ConversationTranscriptItem from './ConversationTranscriptItem.svelte';
	import TranscriptPageBoundary from './TranscriptPageBoundary.svelte';
	import PermissionRequestRow from './PermissionRequestRow.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { PermissionRequestMessage } from '$shared/chat-types';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import type { TranscriptPageState } from '$lib/chat/transcript/transcript-page-progress.js';
	import type { ConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
	import type { ConversationVirtualFeedItem } from './conversation-feed-virtual-items.js';
	import type { ConversationFeedItemState } from './ConversationFeedItemState.svelte.js';

	interface PermissionDecision {
		allow: PermissionDecisionPayload['allow'];
		alwaysAllow?: PermissionDecisionPayload['alwaysAllow'];
		response?: PermissionDecisionPayload['response'];
		message?: string;
	}

	interface Props {
		item: ConversationVirtualFeedItem;
		renderModel: ConversationFeedRenderModel;
		agentId: SessionAgentId | string;
		showThinking: boolean;
		textScale: number;
		pendingPermissionRequests: PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		earlierPageState: TranscriptPageState;
		laterPageState: TranscriptPageState;
		loadError?: string | null;
		onRetry?: () => void;
		onLoadEarlier: () => void;
		onLoadLater: () => void;
		onPermissionDecision?: (
			permissionOccurrenceId: string,
			decision: PermissionDecision,
		) => void;
		onExitPlanMode?: (
			permissionOccurrenceId: string,
			choice: string,
			plan: string,
		) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow: boolean;
		itemState: ConversationFeedItemState;
		acquireTransientActivity: (close: () => void) => () => void;
	}

	let {
		item,
		renderModel,
		agentId,
		showThinking,
		textScale,
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
		acquireTransientActivity,
	}: Props = $props();

	function permissionRequestMessage(request: PendingPermissionRequest): PermissionRequestMessage {
		const timestamp = request.receivedAt?.toISOString() ?? request.requestedTool.timestamp;
		return new PermissionRequestMessage(
			timestamp,
			request.permissionOccurrenceId,
			request.requestedTool,
		);
	}
</script>

{#if item.kind === 'viewport-start-spacer'}
	<div aria-hidden="true" class="h-3 sm:h-4" data-chat-feed-viewport-start-spacer></div>
{:else if item.kind === 'viewport-end-spacer'}
	<div
		aria-hidden="true"
		class={item.reserveComposerTraySpace ? 'h-14' : 'h-3 sm:h-4'}
		data-chat-feed-viewport-end-spacer
	></div>
{:else if item.kind === 'top-toolbar-spacer'}
	<div
		aria-hidden="true"
		class="h-[var(--workspace-floating-taskbar-inset)] shrink-0"
		data-chat-feed-top-floating-toolbar-spacer
	></div>
{:else if item.kind === 'refresh-error'}
	<div
		class="border-b border-border bg-destructive/5 py-2 text-center text-sm text-muted-foreground"
	>
		<div class="flex items-center justify-center space-x-2">
			<TriangleAlert class="h-3 w-3 text-destructive" />
			<span>{m.chat_feed_failed_to_refresh()}</span>
			{#if onRetry}
				<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={onRetry}>
					<RefreshCw class="mr-1 h-3 w-3" />
					{m.chat_feed_retry()}
				</Button>
			{/if}
		</div>
		{#if loadError}
			<p class="mt-1 text-xs text-muted-foreground/70">{loadError}</p>
		{/if}
	</div>
{:else if item.kind === 'earlier-boundary'}
	<TranscriptPageBoundary
		direction="earlier"
		pageState={earlierPageState}
		onRequest={onLoadEarlier}
	/>
{:else if item.kind === 'later-boundary'}
	<TranscriptPageBoundary direction="later" pageState={laterPageState} onRequest={onLoadLater} />
{:else if item.kind === 'permission'}
	<div class:pt-2={item.leadingSpacing}>
		{#if onPermissionDecision}
			<PermissionRequestRow
				request={permissionRequestMessage(item.request)}
				onDecision={onPermissionDecision}
				draft={itemState.permissionDraft(
					item.request.permissionOccurrenceId,
				)}
				{acquireTransientActivity}
				onDraftChange={(draft) =>
					itemState.setPermissionDraft(
						item.request.permissionOccurrenceId,
						draft,
					)}
			/>
		{/if}
		{#if item.spacingAfter === 'responsive-feed'}
			<div aria-hidden="true" class="h-2 sm:h-3"></div>
		{/if}
	</div>
{:else}
	<div class="flow-root" style:zoom={textScale}>
		<ConversationTranscriptItem
			item={item.item}
			{renderModel}
			{agentId}
			{showThinking}
			{pendingPermissionRequests}
			{chatContext}
			{onPermissionDecision}
			{onExitPlanMode}
			{onForkChat}
			{onGenerateTitleFromMessage}
			{canForkAtMessageNow}
			{itemState}
			{acquireTransientActivity}
		/>
		{#if item.spacingAfter === 'scaled-transcript'}
			<div aria-hidden="true" class="h-2 sm:h-3"></div>
		{/if}
	</div>
{/if}
