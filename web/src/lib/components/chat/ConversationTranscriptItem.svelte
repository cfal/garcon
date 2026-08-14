<script lang="ts">
	import ConversationMessage from './ConversationMessage.svelte';
	import MessageRenderFallback from './MessageRenderFallback.svelte';
	import LocalNoticeRow from './rows/LocalNoticeRow.svelte';
	import {
		isToolUseMessage,
		PermissionRequestMessage,
		ToolResultMessage,
		type ChatMessage,
	} from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import type {
		ConversationFeedRenderItem,
		ConversationFeedRenderModel,
		PermissionTerminalState,
	} from '$lib/chat/transcript/conversation-feed-items.js';
	import type { ConversationFeedItemState } from './ConversationFeedItemState.svelte.js';

	interface PermissionDecision {
		allow: PermissionDecisionPayload['allow'];
		alwaysAllow?: PermissionDecisionPayload['alwaysAllow'];
		response?: PermissionDecisionPayload['response'];
		message?: string;
	}

	interface Props {
		item: ConversationFeedRenderItem;
		renderModel: ConversationFeedRenderModel;
		agentId: SessionAgentId | string;
		showThinking?: boolean;
		pendingPermissionRequests?: PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		onPermissionDecision?: (permissionRequestId: string, decision: PermissionDecision) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
		itemState?: ConversationFeedItemState;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		item,
		renderModel,
		agentId,
		showThinking = true,
		pendingPermissionRequests = [],
		chatContext = null,
		onPermissionDecision,
		onExitPlanMode,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
		itemState,
		acquireTransientActivity,
	}: Props = $props();

	const pendingExitPlanIds = $derived(
		new Set(
			pendingPermissionRequests
				.filter((request) => request.requestedTool.type === 'exit-plan-mode-tool-use')
				.map((request) => request.permissionRequestId),
		),
	);
	const disclosureState = $derived(itemState?.disclosurePort(item.id));

	function permissionTerminalFor(message: ChatMessage): PermissionTerminalState | undefined {
		if (message instanceof PermissionRequestMessage) {
			return renderModel.permissionTerminalById.get(message.permissionRequestId);
		}
		if (message.type !== 'exit-plan-mode-tool-use') return undefined;
		const permissionRequestId = `plan-exit-${message.toolId}`;
		if (pendingExitPlanIds.has(permissionRequestId)) return undefined;
		return { state: 'resolved', allowed: true };
	}
</script>

{#if item.kind === 'local-notice'}
	<svelte:boundary>
		<LocalNoticeRow notice={item.notice} />
		{#snippet failed(error)}
			<MessageRenderFallback {error} />
		{/snippet}
	</svelte:boundary>
{:else}
	{@const message = item.message}
	{@const toolResult = isToolUseMessage(message)
		? renderModel.toolResultByUseRowId.get(item.id)
		: undefined}
	{@const toolResultRowId = isToolUseMessage(message)
		? renderModel.toolResultRowIdByUseRowId.get(item.id)
		: undefined}
	{@const pairedToolUse = message instanceof ToolResultMessage ? item.pairedToolUse : undefined}
	{@const permTerminal = permissionTerminalFor(message)}
	<svelte:boundary>
		<ConversationMessage
			{message}
			rowId={item.id}
			awaitingDelivery={item.awaitingDelivery}
			anchorId={item.ordinal === undefined ? undefined : item.id}
			index={item.index}
			forkUpToSeq={item.ordinal}
			{toolResult}
			{toolResultRowId}
			{pairedToolUse}
			permissionTerminal={permTerminal}
			{onPermissionDecision}
			{onExitPlanMode}
			{agentId}
			{showThinking}
			{chatContext}
			{onForkChat}
			{onGenerateTitleFromMessage}
			{canForkAtMessageNow}
			{disclosureState}
			permissionDraft={itemState ? (id) => itemState.permissionDraft(id) : undefined}
			onPermissionDraftChange={itemState
				? (id, draft) => itemState.setPermissionDraft(id, draft)
				: undefined}
			{acquireTransientActivity}
		/>
		{#snippet failed(error)}
			<MessageRenderFallback {error} />
		{/snippet}
	</svelte:boundary>
{/if}
