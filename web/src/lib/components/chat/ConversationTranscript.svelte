<script lang="ts">
	import ConversationTranscriptItem from './ConversationTranscriptItem.svelte';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import {
		buildConversationFeedRenderModel,
		filterHiddenToolRenderItems,
	} from '$lib/chat/transcript/conversation-feed-items.js';
	import type { HideableToolType } from '$lib/stores/local-settings.svelte';
	import {
		compileHiddenBashCommandPatterns,
		type HiddenBashCommandPattern,
	} from '$lib/chat/transcript/hidden-bash-commands.js';
	import { CHAT_FEED_CONTENT_BASE_CLASS } from '$lib/chat/conversation/chat-max-width.js';

	interface PermissionDecision {
		allow: PermissionDecisionPayload['allow'];
		alwaysAllow?: PermissionDecisionPayload['alwaysAllow'];
		response?: PermissionDecisionPayload['response'];
		message?: string;
	}

	interface Props {
		rows: ChatDisplayRow[];
		showThinking?: boolean;
		hiddenToolTypes?: HideableToolType[];
		hiddenBashCommandPatterns?: HiddenBashCommandPattern[];
		pendingPermissionRequests?: readonly PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		onPermissionDecision?: (permissionOccurrenceId: string, decision: PermissionDecision) => void;
		onExitPlanMode?: (permissionOccurrenceId: string, choice: string, plan: string) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
	}

	let {
		rows,
		showThinking = true,
		hiddenToolTypes = [],
		hiddenBashCommandPatterns = [],
		pendingPermissionRequests = [],
		chatContext = null,
		onPermissionDecision,
		onExitPlanMode,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
	}: Props = $props();

	const renderModel = $derived(buildConversationFeedRenderModel(rows));
	const hiddenBashCommands = $derived(compileHiddenBashCommandPatterns(hiddenBashCommandPatterns));
	const renderItems = $derived(
		filterHiddenToolRenderItems(renderModel.items, hiddenToolTypes, hiddenBashCommands),
	);
</script>

<div class={CHAT_FEED_CONTENT_BASE_CLASS}>
	{#each renderItems as item (item.id)}
		<ConversationTranscriptItem
			{item}
			{renderModel}
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
