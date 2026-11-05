<script lang="ts">
	import ConversationTranscriptItem from './ConversationTranscriptItem.svelte';
	import ConversationToolGroupRow from './ConversationToolGroupRow.svelte';
	import TranscriptPageBoundary from './TranscriptPageBoundary.svelte';
	import PermissionRequestRow from './PermissionRequestRow.svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { PermissionRequestMessage } from '$shared/chat-types';
	import type { GroupDescriptor, MemberWindowRequest } from '$shared/transcript-display-contract';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PendingPermissionRequest } from '$lib/types/chat';
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
		onClearBefore?: (ordinal: number) => void;
		onAppendToDraft?: (block: string) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow: boolean;
		itemState: ConversationFeedItemState;
		acquireTransientActivity: (close: () => void) => () => void;
		onToggleToolGroup?: (group: GroupDescriptor, expanded: boolean) => void;
		onLoadMembers?: (group: GroupDescriptor, anchor: MemberWindowRequest['anchor']) => void;
	}

	let {
		item,
		renderModel,
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
		onClearBefore,
		onAppendToDraft,
		onGenerateTitleFromMessage,
		canForkAtMessageNow,
		itemState,
		acquireTransientActivity,
		onToggleToolGroup = () => {},
		onLoadMembers = () => {},
	}: Props = $props();

	function permissionRequestMessage(request: PendingPermissionRequest): PermissionRequestMessage {
		const timestamp = request.receivedAt?.toISOString() ?? request.requestedTool.timestamp;
		return new PermissionRequestMessage(
			timestamp,
			request.permissionOccurrenceId,
			request.requestedTool,
			request.reason,
		);
	}
</script>

{#if item.kind === 'viewport-start-spacer'}
	<div aria-hidden="true" class="h-3 sm:h-4" data-chat-feed-viewport-start-spacer></div>
{:else if item.kind === 'viewport-end-spacer'}
	<div
		aria-hidden="true"
		class={item.reserveComposerCapSpace ? 'h-14' : 'h-3 sm:h-4'}
		data-chat-feed-viewport-end-spacer
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
{:else if item.kind === 'retained-gap'}
	<div role="separator" aria-label={m.chat_feed_retained_boundary()} class="flex h-6 items-center gap-2 text-muted-foreground">
		<span class="flex-1 border-t border-dashed border-border"></span>
		<Ellipsis class="size-4" />
		<span class="flex-1 border-t border-dashed border-border"></span>
	</div>
{:else if item.kind === 'permission'}
	<div class:pt-2={item.leadingSpacing}>
		{#if onPermissionDecision}
			<PermissionRequestRow
				request={permissionRequestMessage(item.request)}
				onDecision={onPermissionDecision}
				{onExitPlanMode}
				onDismissPlan={item.request.planReference && !item.request.control && onExitPlanMode
					? () => onExitPlanMode?.(item.request.permissionOccurrenceId, 'dismiss', '') : undefined}
				{chatContext}
				draft={itemState.permissionDraft(item.request.permissionOccurrenceId)}
				{acquireTransientActivity}
				onDraftChange={(draft) =>
					itemState.setPermissionDraft(item.request.permissionOccurrenceId, draft)}
			/>
		{/if}
		{#if item.spacingAfter === 'responsive-feed'}
			<div aria-hidden="true" class="h-2 sm:h-3"></div>
		{/if}
	</div>
{:else if item.kind === 'tool-group'}
	<ConversationToolGroupRow {item} onToggle={onToggleToolGroup} />
{:else if item.kind === 'member-boundary'}
	<Button variant="ghost" size="sm" class="my-1 text-muted-foreground" onclick={() => onLoadMembers(item.group, item.anchor)}>
		{#if item.anchor.kind === 'before'}<ChevronUp class="size-4" />{:else}<ChevronDown class="size-4" />{/if}
		{item.remaining.toLocaleString()} {item.anchor.kind === 'before' ? 'earlier' : 'later'} actions
	</Button>
{:else if item.kind === 'transcript'}
	<div class="flow-root">
		<ConversationTranscriptItem
			item={item.item}
			{renderModel}
			{showThinking}
			{pendingPermissionRequests}
			{chatContext}
			{onPermissionDecision}
			{onExitPlanMode}
			{onForkChat}
			{onClearBefore}
			{onAppendToDraft}
			{onGenerateTitleFromMessage}
			{canForkAtMessageNow}
			{itemState}
			{acquireTransientActivity}
		/>
		{#if item.spacingAfter === 'transcript'}
			<div aria-hidden="true" class="h-2 sm:h-3"></div>
		{/if}
	</div>
{/if}
