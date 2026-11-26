<script lang="ts">
	import { isPlainTextInput } from '$shared/input-format';
	import {
		UserMessage,
		AssistantMessage,
		ThinkingMessage,
		isToolUseMessage,
		ErrorMessage,
		TranscriptNoticeMessage,
		CliRowMessage,
		PermissionRequestMessage,
		CompactionMessage,
		AgentSwitchMessage,
		ToolResultMessage,
		AskUserQuestionToolUseMessage,
	} from '$shared/chat-types';
	import type { ChatMessage, ToolUseChatMessage } from '$shared/chat-types';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Clock3 from '@lucide/svelte/icons/clock-3';
	import type { InputStatus } from '$lib/chat/transcript/optimistic-user-input.js';
	import {
		getChatSessions,
		getExecutors,
		getLocalSettings,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';
	import CodeBlock from '$lib/components/rich-text/CodeBlock.svelte';
	import { createChatMarkdownNavigation } from './chat-markdown-navigation.js';
	import MessageContextMenuShell from './MessageContextMenuShell.svelte';
	import PermissionRequestRow from './PermissionRequestRow.svelte';
	import AsyncQuestionMessage from './AsyncQuestionMessage.svelte';
	import CompactionRow from './CompactionRow.svelte';
	import AgentSwitchRow from './AgentSwitchRow.svelte';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import CliRow from './rows/CliRow.svelte';
	import CommandStatusRow from './rows/CommandStatusRow.svelte';
	import CliPresentationHeader from './rows/CliPresentationHeader.svelte';
	import CollapsibleBody from './rows/CollapsibleBody.svelte';
	import UserMessageAttachments from './UserMessageAttachments.svelte';
	import TranscriptNoticeRow from './rows/TranscriptNoticeRow.svelte';
	import { cliPresentationSurfaceClass } from '$lib/chat/transcript/cli-presentation-style';
	import { userMessageBodyDisclosure } from '$lib/chat/transcript/user-message-body-disclosure.js';
	import ChatToolEventRenderer from '../tools/ChatToolEventRenderer.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { PermissionTerminalState } from '$lib/chat/transcript/conversation-feed-items.js';
	import { historicalAskUserQuestion } from '$lib/chat/transcript/ask-user-question-history.js';
	import type {
		ConversationDisclosureStatePort,
		PermissionQuestionDraft,
	} from './ConversationFeedItemState.svelte.js';

	interface Props {
		isVisible?: boolean;
		message: ChatMessage;
		inputStatus?: InputStatus;
		rowId?: string;
		anchorId?: string;
		forkUpToSeq?: number;
		toolResult?: ToolResultMessage;
		toolResultRowId?: string;
		pairedToolUse?: ToolUseChatMessage;
		permissionTerminal?: PermissionTerminalState;
		permissionActionable?: boolean;
		onPermissionDecision?: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (permissionOccurrenceId: string, choice: string, plan: string) => void;
		showThinking?: boolean;
		chatContext?: ConversationMessageChatContext | null;
		/** Forks the current chat from the in-chat action. Omitted when the agent cannot fork. */
		onForkChat?: (upToSeq?: number) => void;
		onClearBefore?: (ordinal: number) => void;
		/** Appends a formatted block to the active chat draft. Omitted when no composer owns the chat. */
		onAppendToDraft?: (block: string) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
		disclosureState?: ConversationDisclosureStatePort;
		permissionDraft?: (permissionOccurrenceId: string) => PermissionQuestionDraft;
		onPermissionDraftChange?: (
			permissionOccurrenceId: string,
			draft: PermissionQuestionDraft,
		) => void;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		isVisible = true,
		message,
		inputStatus,
		rowId,
		anchorId,
		forkUpToSeq,
		toolResult,
		toolResultRowId,
		pairedToolUse,
		permissionTerminal,
		permissionActionable = false,
		onPermissionDecision,
		onExitPlanMode,
		showThinking = true,
		chatContext = null,
		onForkChat,
		onClearBefore,
		onAppendToDraft,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
		disclosureState,
		permissionDraft,
		onPermissionDraftChange,
		acquireTransientActivity,
	}: Props = $props();

	const sessions = getChatSessions();
	const executors = getExecutors();
	const workspace = getWorkspaceCoordinator();
	const localSettings = getLocalSettings();

	const activeChatContext = $derived.by((): ConversationMessageChatContext | null => {
		if (chatContext?.chatId) return chatContext;
		const selected = sessions.selectedChat;
		if (!selected?.id) return null;
		return {
			chatId: selected.id,
			executorId: selected.executorId,
			projectPath: selected.projectPath ?? null,
		};
	});
	const executorId = $derived(
		(message.type === 'command-output' ? message.context?.executorId : activeChatContext?.executorId) ??
			(activeChatContext ? sessions.byId[activeChatContext.chatId]?.executorId : null) ??
			'local',
	);
	const filesAvailable = $derived(executors.filesAvailable(executorId));
	const projectBasePath = $derived(executors.get(executorId)?.projectBasePath ?? '');
	const chatProjectPath = $derived.by(() => {
		if (!filesAvailable) return null;
		if (message.type === 'command-output') return message.context?.projectPath ?? null;
		return activeChatContext?.projectPath ?? null;
	});

	const shouldHideThinking = $derived(message instanceof ThinkingMessage && !showThinking);

	function getCssType(msg: ChatMessage): string {
		if (isToolUseMessage(msg)) return 'tool';
		switch (msg.type) {
			case 'user-message':
				return 'user';
			case 'assistant-message':
			case 'command-output':
				return 'assistant';
			default:
				return msg.type;
		}
	}

	const cssType = $derived(getCssType(message));

	const asUser = $derived(message instanceof UserMessage ? message : null);
	const userMessagePresentation = $derived(asUser?.presentation ?? null);
	const userMessageDisclosure = $derived(userMessageBodyDisclosure(userMessagePresentation));
	const userMessageDisclosureKind = $derived<'user-body' | 'cli-body'>(
		userMessagePresentation ? 'cli-body' : 'user-body',
	);
	const userMessageSurfaceClass = $derived(
		userMessagePresentation?.style
			? cliPresentationSurfaceClass(userMessagePresentation.style)
			: '',
	);
	const userMessageCustomStyle = $derived(
		userMessagePresentation?.style === 'custom' ? userMessagePresentation.customStyle : null,
	);
	const asAssistant = $derived(message instanceof AssistantMessage ? message : null);
	const asCommandOutput = $derived(message.type === 'command-output' ? message : null);
	const plainResponse = $derived(asCommandOutput?.format === 'plain');
	const asThinking = $derived(message instanceof ThinkingMessage ? message : null);
	const asToolUse = $derived(isToolUseMessage(message) ? message : null);
	const asToolResult = $derived(message instanceof ToolResultMessage ? message : null);
	const asNotice = $derived(message instanceof TranscriptNoticeMessage ? message : null);
	const asError = $derived(message instanceof ErrorMessage ? message : null);
	const asCliRow = $derived(message instanceof CliRowMessage ? message : null);
	const asCompaction = $derived(message instanceof CompactionMessage ? message : null);
	const asAgentSwitch = $derived(message instanceof AgentSwitchMessage ? message : null);
	const asPermissionRequest = $derived(
		message instanceof PermissionRequestMessage ? message : null,
	);
	const exitPlanPermissionRequest = $derived(
		asToolUse?.type === 'exit-plan-mode-tool-use'
			? new PermissionRequestMessage(message.timestamp, `plan-exit-${asToolUse.toolId}`, asToolUse)
			: null,
	);
	const historicalQuestion = $derived.by(() => {
		if (!(asToolResult && pairedToolUse instanceof AskUserQuestionToolUseMessage)) return null;
		return historicalAskUserQuestion(pairedToolUse, asToolResult);
	});
	function ignorePermissionDecision(): void {}

	const showNonAssistantHeader = $derived(Boolean(asError));

	function getFormattedContent(): string {
		if (message instanceof AssistantMessage || message instanceof ErrorMessage || message.type === 'command-output') {
			return String(message.content || '');
		}
		return '';
	}

	const formattedContent = $derived(getFormattedContent());
	const messageClass = $derived(
		cn(
			'chat-message',
			cssType,
			asUser
				? [
						'flex min-w-0',
						localSettings.userMessageAlignment === 'right' ? 'justify-end' : 'justify-start',
					]
				: 'flow-root',
		),
	);

	const { handleLinkNavigate, handleToolFileOpen, resolveImageFile, resolveChatReference } = createChatMarkdownNavigation({
		get sourceChatId() { return activeChatContext?.chatId; },
		get executorId() { return executorId; },
		get projectPath() { return chatProjectPath; },
	});

	let localThinkingOpen = $state(true);
	let thinkingOpen = $derived(
		disclosureState?.open('thinking', 'thinking', true) ?? localThinkingOpen,
	);

	function toggleThinking(): void {
		const next = !thinkingOpen;
		if (disclosureState) disclosureState.setOpen('thinking', 'thinking', next, true);
		else localThinkingOpen = next;
	}


</script>

{#if !shouldHideThinking}
	<div
		class={messageClass}
		data-chat-row-id={rowId}
		data-chat-anchor-id={anchorId}
		data-chat-message-type={message.type}
	>
		{#if asUser}
			<MessageContextMenuShell
				{isVisible}
				{forkUpToSeq}
				{canForkAtMessageNow}
				{onForkChat}
				{onAppendToDraft}
				{acquireTransientActivity}
				onGenerateTitleFromMessage={activeChatContext?.chatId ? onGenerateTitleFromMessage : undefined}
				messageMenuText={String(asUser.content || '')}
				{onClearBefore}
				triggerClass={cn(
					'user-message-context-target chat-message-context-target message-context-menu-trigger relative block bg-user-bubble text-user-bubble-foreground rounded-xl border border-border px-3 py-2 min-w-0 max-w-full',
					userMessagePresentation ? 'shadow-sm' : 'data-[state=open]:shadow-sm',
					!userMessagePresentation?.style &&
						'data-[state=open]:bg-user-bubble-selected selection:bg-user-bubble-foreground selection:text-user-bubble',
					userMessageSurfaceClass,
				)}
				presentationStyle={userMessagePresentation?.style}
			>
				{#snippet frame(trigger, menuButton, open)}
					<div
						class="user-message-row group/message mt-1 flex min-w-0 max-w-[85%] items-stretch gap-1.5"
						data-message-menu-open={open ? 'true' : undefined}
						style:--cli-presentation-accent-light={userMessageCustomStyle?.lightAccent}
						style:--cli-presentation-accent-dark={userMessageCustomStyle?.darkAccent}
					>
						{@render trigger()}
						<div
							class="user-message-accessory-rail relative w-3.5 shrink-0 [@media(hover:hover)_and_(pointer:fine)]:w-7"
						>
							{#if inputStatus === 'sending'}
								<LoaderCircle
									class="absolute bottom-0 right-0 size-3.5 animate-spin text-muted-foreground"
									aria-label={m.chat_message_delivery_sending()}
								/>
							{:else if inputStatus === 'waiting-to-steer'}
								<span
									class="absolute bottom-0 right-0 text-muted-foreground"
									role="img"
									aria-label={m.chat_queue_pending_steer()}
									title={m.chat_queue_pending_steer()}
								><Clock3 class="size-3.5" aria-hidden="true" /></span>
							{:else}
								{@render menuButton('bottom-0 right-0')}
							{/if}
						</div>
					</div>
				{/snippet}
				{#snippet children(_menuButton)}
				<div>
					{#if userMessagePresentation?.style}
						<CliPresentationHeader
							style={userMessagePresentation.style}
							title={userMessagePresentation.title}
						/>
					{/if}
					<CollapsibleBody
						disclosure={userMessageDisclosure}
						previewHeight={userMessagePresentation?.style ? 'default' : 'tall'}
						alwaysExpanded={Boolean(userMessagePresentation) &&
							localSettings.alwaysExpandCliMessages}
						expanded={disclosureState?.open(userMessageDisclosureKind, 'body', false)}
						onExpandedChange={disclosureState
							? (expanded) =>
									disclosureState.setOpen(userMessageDisclosureKind, 'body', expanded, false)
							: undefined}
					>
						<div
							class={['typography-chat-prose text-sm', userMessagePresentation?.style && 'mt-1']}
						>
							{#if isPlainTextInput(asUser)}
								<pre
									class="typography-chat-plain whitespace-pre-wrap break-words font-mono">{asUser.content}</pre>
							{:else}
							<Markdown
								source={asUser.content}
								variant={userMessagePresentation?.style ? 'presented' : 'user'}
								fileLinkBasePath={projectBasePath}
								onLinkNavigate={handleLinkNavigate}
								{resolveImageFile}
								{resolveChatReference}
								chatReferencePolicy={userMessagePresentation ? 'explicit' : 'explicit-and-bare'}
								{acquireTransientActivity}
							/>
							{/if}
						</div>
					</CollapsibleBody>
					{#if asUser.images}
						<UserMessageAttachments attachments={asUser.images} />
					{/if}
				</div>
				{/snippet}
			</MessageContextMenuShell>
		{:else}
			<div class="w-full">
				{#if showNonAssistantHeader}
					<div class="flex items-center space-x-3 mb-2">
						<div
							class="w-8 h-8 bg-status-error rounded-full flex items-center justify-center text-status-error-foreground text-sm flex-shrink-0"
						>
							!
						</div>
						<div class="text-sm font-medium text-foreground">
							{m.chat_message_error()}
						</div>
					</div>
				{/if}

				<div class="w-full">
					{#if asToolUse && asToolUse.type === 'enter-plan-mode-tool-use'}
						<ChatEventCard variant="info" compact>
							{#snippet body()}
								<span class="text-xs font-medium">
									{m.chat_message_entered_plan_mode()}
								</span>
							{/snippet}
						</ChatEventCard>
					{:else if exitPlanPermissionRequest}
						<PermissionRequestRow
							request={exitPlanPermissionRequest}
							terminal={permissionTerminal}
							actionable={permissionActionable}
							onDecision={onPermissionDecision ?? ignorePermissionDecision}
							{onExitPlanMode}
							{chatContext}
							draft={permissionDraft?.(exitPlanPermissionRequest.permissionOccurrenceId)}
							{acquireTransientActivity}
							onDraftChange={onPermissionDraftChange
								? (draft) =>
										onPermissionDraftChange(exitPlanPermissionRequest.permissionOccurrenceId, draft)
								: undefined}
						/>
					{:else if historicalQuestion}
						<PermissionRequestRow
							request={historicalQuestion.request}
							terminal={historicalQuestion.terminal}
							onDecision={ignorePermissionDecision}
							{chatContext}
							{acquireTransientActivity}
						/>
					{:else if asToolUse}
						<ChatToolEventRenderer
							toolMessage={asToolUse}
							toolResult={toolResult
								? { content: toolResult.content, isError: toolResult.isError }
								: undefined}
							mode="input"
							resultAnchorId={toolResultRowId ? `tool-result-${toolResultRowId}` : undefined}
							autoExpandTools={localSettings.autoExpandTools}
							onFileOpen={filesAvailable ? handleToolFileOpen : undefined}
							{resolveImageFile}
							{projectBasePath}
							{chatProjectPath}
							{resolveChatReference}
							{disclosureState}
							{acquireTransientActivity}
						/>
					{:else if asToolResult && pairedToolUse}
						<ChatToolEventRenderer
							toolMessage={pairedToolUse}
							toolResult={{ content: asToolResult.content, isError: asToolResult.isError }}
							mode="result"
							resultAnchorId={rowId ? `tool-result-${rowId}` : undefined}
							autoExpandTools={localSettings.autoExpandTools}
							onFileOpen={filesAvailable ? handleToolFileOpen : undefined}
							{resolveImageFile}
							{projectBasePath}
							{chatProjectPath}
							{resolveChatReference}
							{disclosureState}
							{acquireTransientActivity}
						/>
					{:else if asThinking}
						<ChatEventCard variant="thinking" compact>
							{#snippet body()}
								<button
									type="button"
									class="flex w-full items-center gap-2 text-left cursor-pointer"
									onclick={toggleThinking}
									aria-expanded={thinkingOpen}
								>
									<span class="text-xs font-medium text-muted-foreground"
										>{m.chat_message_thinking()}</span
									>
									<ChevronRight
										class="ml-auto w-3 h-3 transition-transform {thinkingOpen ? 'rotate-90' : ''}"
									/>
								</button>
								{#if thinkingOpen}
									<div class="typography-chat-prose mt-0.5 text-sm text-foreground/90">
										<Markdown
											source={asThinking.content}
											variant="thinking"
											fileLinkBasePath={projectBasePath}
											onLinkNavigate={handleLinkNavigate}
											{resolveImageFile}
											{resolveChatReference}
											chatReferencePolicy="explicit"
											{acquireTransientActivity}
										/>
									</div>
								{/if}
							{/snippet}
						</ChatEventCard>
					{:else if message.type === 'command-result' || (message.type === 'command-output' && message.channel === 'stderr')}
						<CommandStatusRow {message} />
					{:else if asAssistant?.questions}
						<AsyncQuestionMessage questions={asAssistant.questions} ordinal={forkUpToSeq} />
					{:else if asAssistant || asCommandOutput}
						<MessageContextMenuShell
							{isVisible}
							{forkUpToSeq}
							{canForkAtMessageNow}
							{onForkChat}
							{onAppendToDraft}
							{acquireTransientActivity}
							onGenerateTitleFromMessage={activeChatContext?.chatId ? onGenerateTitleFromMessage : undefined}
							messageMenuText={formattedContent}
							triggerClass="assistant-message-context-target chat-message-context-target message-context-menu-trigger relative -my-1 block w-full py-1"
						>
							{#snippet children(menuButton)}
								<div class="group/message relative [@media(hover:hover)_and_(pointer:fine)]:pr-8">
									<div class="typography-chat-prose px-px text-sm text-foreground">
										{#if plainResponse}
											<CodeBlock text={formattedContent} />
										{:else}
										<Markdown
											source={formattedContent}
											variant="assistant"
											fileLinkBasePath={projectBasePath}
											onLinkNavigate={handleLinkNavigate}
											{resolveImageFile}
											{resolveChatReference}
											chatReferencePolicy="explicit-and-bare"
											{acquireTransientActivity}
										/>
										{/if}
									</div>
									{@render menuButton('-bottom-1 right-1')}
								</div>
							{/snippet}
						</MessageContextMenuShell>
					{:else if asCliRow}
						<CliRow
							message={asCliRow}
							fileLinkBasePath={projectBasePath}
							onLinkNavigate={handleLinkNavigate}
							{resolveImageFile}
							{resolveChatReference}
							{acquireTransientActivity}
							alwaysExpanded={localSettings.alwaysExpandCliMessages}
							{disclosureState}
						/>
					{:else if asNotice}
						<TranscriptNoticeRow
							message={asNotice}
							onOpenTicket={(id) => workspace.openTicket(id)}
							fileLinkBasePath={projectBasePath}
							onLinkNavigate={handleLinkNavigate}
							{resolveImageFile}
							{acquireTransientActivity}
							{disclosureState}
							{resolveChatReference}
						/>
					{:else if asError}
						<ChatEventCard variant="error">
							{#snippet body()}
								<div class="typography-chat-prose text-sm whitespace-pre-wrap break-words">
									{formattedContent}
								</div>
							{/snippet}
						</ChatEventCard>
					{:else if asCompaction}
						<CompactionRow
							message={asCompaction}
							{projectBasePath}
							onLinkNavigate={handleLinkNavigate}
							{resolveImageFile}
							{resolveChatReference}
							{acquireTransientActivity}
							open={disclosureState?.open('compaction', 'compaction', false)}
							onOpenChange={disclosureState
								? (open) => disclosureState.setOpen('compaction', 'compaction', open, false)
								: undefined}
						/>
					{:else if asAgentSwitch}
						<AgentSwitchRow message={asAgentSwitch} />
					{:else if asPermissionRequest}
						<PermissionRequestRow
							request={asPermissionRequest}
							terminal={permissionTerminal}
							actionable={permissionActionable}
							onDecision={onPermissionDecision ?? ignorePermissionDecision}
							{onExitPlanMode}
							{chatContext}
							draft={permissionDraft?.(asPermissionRequest.permissionOccurrenceId)}
							{acquireTransientActivity}
							onDraftChange={onPermissionDraftChange
								? (draft) =>
										onPermissionDraftChange(asPermissionRequest.permissionOccurrenceId, draft)
								: undefined}
						/>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
