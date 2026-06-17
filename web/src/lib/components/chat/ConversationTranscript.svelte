<script lang="ts">
	import ConversationMessage from './ConversationMessage.svelte';
	import ChatBashToolGroup from './tools/ChatBashToolGroup.svelte';
	import MessageRenderFallback from './MessageRenderFallback.svelte';
	import LocalNoticeRow from './rows/LocalNoticeRow.svelte';
	import { isToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatDisplayRow } from '$lib/chat/state.svelte';
	import type { ConversationMessageChatContext } from '$lib/chat/conversation-message-context';
	import { buildConversationFeedRenderModel } from '$lib/chat/conversation-feed-items';

	interface PermissionDecision {
		allow: boolean;
		message?: string;
	}

	interface Props {
		rows: ChatDisplayRow[];
		agentId: SessionAgentId | string;
		showThinking?: boolean;
		pendingPermissionRequests?: PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		onPermissionDecision?: (permissionRequestId: string, decision: PermissionDecision) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
	}

	let {
		rows,
		agentId,
		showThinking = true,
		pendingPermissionRequests = [],
		chatContext = null,
		onPermissionDecision,
		onExitPlanMode,
	}: Props = $props();

	const pendingExitPlanIds = $derived(
		new Set(
			pendingPermissionRequests
				.filter((request) => request.requestedTool.type === 'exit-plan-mode-tool-use')
				.map((request) => request.permissionRequestId),
		),
	);

	const renderModel = $derived(buildConversationFeedRenderModel(rows));
	const renderItems = $derived(renderModel.items);
</script>

{#each renderItems as item (item.id)}
	{#if item.kind === 'bash-group'}
		<svelte:boundary>
			<ChatBashToolGroup messages={item.messages} />
			{#snippet failed(error)}
				<MessageRenderFallback {error} />
			{/snippet}
		</svelte:boundary>
	{:else if item.kind === 'local-notice'}
		<svelte:boundary>
			<LocalNoticeRow notice={item.notice} />
			{#snippet failed(error)}
				<MessageRenderFallback {error} />
			{/snippet}
		</svelte:boundary>
	{:else}
		{@const message = item.message}
		{@const toolResult = isToolUseMessage(message)
			? renderModel.toolResultIndex.get(message.toolId)
			: undefined}
		{@const exitPlanId = message.type === 'exit-plan-mode-tool-use'
			? `plan-exit-${message.toolId}`
			: null}
		{@const permTerminal =
			message instanceof PermissionRequestMessage
				? renderModel.permissionTerminalById.get(message.permissionRequestId)
				: exitPlanId
					? pendingExitPlanIds.has(exitPlanId)
						? undefined
						: { state: 'resolved' as const, allowed: true }
					: undefined}
		<svelte:boundary>
			<ConversationMessage
				{message}
				index={item.index}
				prevMessage={item.prevMessage}
				{toolResult}
				permissionTerminal={permTerminal}
				{onPermissionDecision}
				{onExitPlanMode}
				{agentId}
				{showThinking}
				{chatContext}
			/>
			{#snippet failed(error)}
				<MessageRenderFallback {error} />
			{/snippet}
		</svelte:boundary>
	{/if}
{/each}
