<script lang="ts">
	import ConversationTranscriptItem from './ConversationTranscriptItem.svelte';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import {
		buildConversationFeedRenderModel,
		filterHiddenToolRenderItems,
	} from '$lib/chat/transcript/conversation-feed-items.js';
	import type { HideableToolType } from '$lib/stores/local-settings.svelte';

	interface PermissionDecision {
		allow: PermissionDecisionPayload['allow'];
		alwaysAllow?: PermissionDecisionPayload['alwaysAllow'];
		response?: PermissionDecisionPayload['response'];
		message?: string;
	}

	interface Props {
		rows: ChatDisplayRow[];
		agentId: SessionAgentId | string;
		showThinking?: boolean;
		hiddenToolTypes?: HideableToolType[];
		pendingPermissionRequests?: PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		textScale?: number;
		onPermissionDecision?: (
			permissionRequestId: string,
			incarnation: string,
			decision: PermissionDecision,
		) => void;
		onExitPlanMode?: (
			permissionRequestId: string,
			incarnation: string,
			choice: string,
			plan: string,
		) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
	}

	let {
		rows,
		agentId,
		showThinking = true,
		hiddenToolTypes = [],
		pendingPermissionRequests = [],
		chatContext = null,
		textScale = 1,
		onPermissionDecision,
		onExitPlanMode,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
	}: Props = $props();

	const renderModel = $derived(buildConversationFeedRenderModel(rows));
	const renderItems = $derived(filterHiddenToolRenderItems(renderModel.items, hiddenToolTypes));
</script>

<div
	class="flex w-full flex-col gap-2 sm:gap-3"
	style:zoom={textScale}
	data-chat-transcript-scale={String(textScale)}
>
	{#each renderItems as item (item.id)}
		<ConversationTranscriptItem
			{item}
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
		/>
	{/each}
</div>
