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
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import type {
		ConversationFeedRenderItem,
		ConversationFeedRenderModel,
	} from '$lib/chat/transcript/conversation-feed-items.js';
	import { getAppShell, getChatSessions, getFileSessions } from '$lib/context';
	import { resolveFileOpenTarget } from '$lib/chat/file-links/file-open-target.js';
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

	const sessions = getChatSessions();
	const fileSessions = getFileSessions();
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
	const disclosureState = $derived(itemState?.disclosurePort(item.id));

	function handleReadFileOpen(filePath: string): void {
		const chat = activeChatContext;
		if (!chat?.projectPath) return;
		const resolved = resolveFileOpenTarget(filePath, {
			fileRootPath: projectBasePath,
			sourceDirectoryPath: chat.projectPath,
		});
		if (!resolved) return;
		void fileSessions.open({
			fileRootPath: resolved.fileRootPath,
			relativePath: resolved.relativePath,
			mode: 'auto',
			origin: appShell.isMobile ? 'mobile' : 'main',
			reason: 'user-open',
			line: resolved.line,
			col: resolved.col,
		});
	}
</script>

{#if item.kind === 'bash-group'}
	<svelte:boundary>
		<ChatBashToolGroup rows={item.rows} />
		{#snippet failed(error)}
			<MessageRenderFallback {error} />
		{/snippet}
	</svelte:boundary>
{:else if item.kind === 'read-group'}
	<svelte:boundary>
		<ChatReadToolGroup rows={item.rows} onFileOpen={handleReadFileOpen} />
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
			rowId={item.id}
			anchorId={item.seq === undefined ? undefined : item.id}
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
