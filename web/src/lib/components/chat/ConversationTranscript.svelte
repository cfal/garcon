<script lang="ts">
	import ConversationMessage from './ConversationMessage.svelte';
	import ChatBashToolGroup from './tools/ChatBashToolGroup.svelte';
	import ChatReadToolGroup from './tools/ChatReadToolGroup.svelte';
	import MessageRenderFallback from './MessageRenderFallback.svelte';
	import LocalNoticeRow from './rows/LocalNoticeRow.svelte';
	import { isToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatDisplayRow } from '$lib/chat/state.svelte';
	import type { ConversationMessageChatContext } from '$lib/chat/conversation-message-context';
	import { buildConversationFeedRenderModel } from '$lib/chat/conversation-feed-items';
	import { getAppShell, getChatSessions, getFileViewer } from '$lib/context';
	import { resolveFileOpenTarget } from '$lib/chat/file-open-target';

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
		pendingPermissionRequests?: PendingPermissionRequest[];
		chatContext?: ConversationMessageChatContext | null;
		textScale?: number;
		onPermissionDecision?: (permissionRequestId: string, decision: PermissionDecision) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		/** Forks the current chat from the in-chat action. Omitted when the agent cannot fork. */
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
	}

	let {
		rows,
		agentId,
		showThinking = true,
		pendingPermissionRequests = [],
		chatContext = null,
		textScale = 1,
		onPermissionDecision,
		onExitPlanMode,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
	}: Props = $props();

	const sessions = getChatSessions();
	const fileViewer = getFileViewer();
	const appShell = getAppShell();
	const projectBasePath = $derived(appShell.projectBasePath);

	const activeChatContext = $derived.by((): ConversationMessageChatContext | null => {
		if (chatContext?.chatId) return chatContext;
		const selected = sessions.selectedChat;
		if (!selected?.id) return null;
		return { chatId: selected.id, projectPath: selected.projectPath ?? null };
	});

	const pendingExitPlanIds = $derived(
		new Set(
			pendingPermissionRequests
				.filter((request) => request.requestedTool.type === 'exit-plan-mode-tool-use')
				.map((request) => request.permissionRequestId),
		),
	);

		const renderModel = $derived(buildConversationFeedRenderModel(rows));
		const renderItems = $derived(renderModel.items);

		function handleReadFileOpen(filePath: string): void {
			const chat = activeChatContext;
			if (!chat?.projectPath) return;
			const resolved = resolveFileOpenTarget(filePath, {
				projectBasePath,
				chatProjectPath: chat.projectPath,
			});
			if (!resolved) return;
			fileViewer.openAuto({
				chatId: chat.chatId,
				fileRootPath: resolved.fileRootPath,
				relativePath: resolved.relativePath,
				source: 'tool',
				line: resolved.line,
				col: resolved.col,
			});
		}
</script>

<div
	class="flex w-full flex-col gap-2 sm:gap-3"
	style:zoom={textScale}
	data-chat-transcript-scale={String(textScale)}
>
	{#each renderItems as item (item.id)}
		{#if item.kind === 'bash-group'}
			<svelte:boundary>
				<ChatBashToolGroup messages={item.messages} />
				{#snippet failed(error)}
					<MessageRenderFallback {error} />
				{/snippet}
			</svelte:boundary>
		{:else if item.kind === 'read-group'}
			<svelte:boundary>
				<ChatReadToolGroup messages={item.messages} onFileOpen={handleReadFileOpen} />
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
			{@const exitPlanId =
				message.type === 'exit-plan-mode-tool-use' ? `plan-exit-${message.toolId}` : null}
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
					forkUpToSeq={item.seq}
					prevMessage={item.prevMessage}
					{toolResult}
					permissionTerminal={permTerminal}
					{onPermissionDecision}
					{onExitPlanMode}
					{agentId}
					{showThinking}
					{chatContext}
					{onForkChat}
					{onGenerateTitleFromMessage}
					{canForkAtMessageNow}
				/>
				{#snippet failed(error)}
					<MessageRenderFallback {error} />
				{/snippet}
			</svelte:boundary>
		{/if}
	{/each}
</div>
