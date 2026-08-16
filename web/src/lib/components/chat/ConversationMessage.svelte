<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		UserMessage,
		AssistantMessage,
		ThinkingMessage,
		isToolUseMessage,
		ErrorMessage,
		PermissionRequestMessage,
		CompactionMessage,
		AgentSwitchMessage,
		ToolResultMessage,
		AskUserQuestionToolUseMessage,
	} from '$shared/chat-types';
	import type {
		ChatMessage,
		ToolUseChatMessage,
	} from '$shared/chat-types';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import FileText from '@lucide/svelte/icons/file-text';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { getChatSessions, getFileSessions, getAppShell, getLocalSettings } from '$lib/context';
	import Markdown from './Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from './Markdown.svelte';
	import { resolveFileOpenTarget } from '$lib/chat/file-links/file-open-target.js';
	import { resolveFileLinkTarget } from '$lib/chat/file-links/file-link-resolver.js';
	import PermissionRequestRow from './PermissionRequestRow.svelte';
	import CompactionRow from './CompactionRow.svelte';
	import AgentSwitchRow from './AgentSwitchRow.svelte';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import ChatToolEventRenderer from './tools/ChatToolEventRenderer.svelte';
	import {
		ContextMenu,
		ContextMenuTrigger,
		ContextMenuContent,
	} from '$lib/components/ui/context-menu';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { cn } from '$lib/utils/cn';
	import MessageActionMenu from './MessageActionMenu.svelte';
	import MessageTextSelectionDialog from './MessageTextSelectionDialog.svelte';
	import type { PermissionTerminalState } from '$lib/chat/transcript/conversation-feed-items.js';
	import { historicalAskUserQuestion } from '$lib/chat/transcript/ask-user-question-history.js';
	import type {
		ConversationDisclosureStatePort,
		PermissionQuestionDraft,
	} from './ConversationFeedItemState.svelte.js';

	const MESSAGE_CONTEXT_MENU_LONG_PRESS_MS = 250;
	const MESSAGE_CONTEXT_INTERACTIVE_SELECTOR =
		'a, button, input, textarea, select, [role="button"], [contenteditable]:not([contenteditable="false"])';

	interface Props {
		message: ChatMessage;
		/** Marks a submitted message whose request has not come back yet. */
		awaitingDelivery?: boolean;
		rowId?: string;
		anchorId?: string;
		index: number;
		forkUpToSeq?: number;
		toolResult?: ToolResultMessage;
		toolResultRowId?: string;
		pairedToolUse?: ToolUseChatMessage;
		permissionTerminal?: PermissionTerminalState;
		permissionActionable?: boolean;
		onPermissionDecision?: (
			permissionRequestId: string,
			incarnation: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (
			permissionRequestId: string,
			incarnation: string,
			choice: string,
			plan: string,
		) => void;
		agentId: SessionAgentId | string;
		showThinking?: boolean;
		chatContext?: ConversationMessageChatContext | null;
		/** Forks the current chat from the in-chat action. Omitted when the agent cannot fork. */
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
		disclosureState?: ConversationDisclosureStatePort;
		permissionDraft?: (
			permissionRequestId: string,
			incarnation: string,
		) => PermissionQuestionDraft;
		onPermissionDraftChange?: (
			permissionRequestId: string,
			incarnation: string,
			draft: PermissionQuestionDraft,
		) => void;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let {
		message,
		awaitingDelivery = false,
		rowId,
		anchorId,
		index,
		forkUpToSeq,
		toolResult,
		toolResultRowId,
		pairedToolUse,
		permissionTerminal,
		permissionActionable = false,
		onPermissionDecision,
		onExitPlanMode,
		agentId,
		showThinking = true,
		chatContext = null,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
		disclosureState,
		permissionDraft,
		onPermissionDraftChange,
		acquireTransientActivity,
	}: Props = $props();

	const sessions = getChatSessions();
	const fileSessions = getFileSessions();
	const appShell = getAppShell();
	const localSettings = getLocalSettings();

	const projectBasePath = $derived(appShell.projectBasePath);
	const activeChatContext = $derived.by((): ConversationMessageChatContext | null => {
		if (chatContext?.chatId) return chatContext;
		const selected = sessions.selectedChat;
		if (!selected?.id) return null;
		return { chatId: selected.id, projectPath: selected.projectPath ?? null };
	});
	const chatProjectPath = $derived(activeChatContext?.projectPath ?? null);

	const shouldHideThinking = $derived(message instanceof ThinkingMessage && !showThinking);

	function getCssType(msg: ChatMessage): string {
		if (isToolUseMessage(msg)) return 'tool';
		switch (msg.type) {
			case 'user-message':
				return 'user';
			case 'assistant-message':
				return 'assistant';
			default:
				return msg.type;
		}
	}

	const cssType = $derived(getCssType(message));

	const asUser = $derived(message instanceof UserMessage ? message : null);
	const asAssistant = $derived(message instanceof AssistantMessage ? message : null);
	const asThinking = $derived(message instanceof ThinkingMessage ? message : null);
	const asToolUse = $derived(isToolUseMessage(message) ? message : null);
	const asToolResult = $derived(message instanceof ToolResultMessage ? message : null);
	const asError = $derived(message instanceof ErrorMessage ? message : null);
	const asCompaction = $derived(message instanceof CompactionMessage ? message : null);
	const asAgentSwitch = $derived(message instanceof AgentSwitchMessage ? message : null);
	const asPermissionRequest = $derived(
		message instanceof PermissionRequestMessage ? message : null,
	);
	const exitPlanPermissionRequest = $derived(
		asToolUse?.type === 'exit-plan-mode-tool-use'
			? new PermissionRequestMessage(
					message.timestamp,
					`plan-exit-${asToolUse.toolId}`,
					`plan-exit-${asToolUse.toolId}`,
					asToolUse,
				)
			: null,
	);
	const historicalQuestion = $derived.by(() => {
		if (!(asToolResult && pairedToolUse instanceof AskUserQuestionToolUseMessage)) return null;
		return historicalAskUserQuestion(pairedToolUse, asToolResult);
	});
	function ignorePermissionDecision(): void {}

	const showNonAssistantHeader = $derived(message instanceof ErrorMessage);

	function getFormattedContent(): string {
		if (message instanceof AssistantMessage || message instanceof ErrorMessage) {
			return String(message.content || '');
		}
		return '';
	}

	const formattedContent = $derived(getFormattedContent());
	const messageClass = $derived(
		cn(
			'chat-message',
			cssType,
			message instanceof UserMessage ? 'flex justify-start min-w-0' : 'flow-root',
		),
	);

	function getMessageMenuText(): string {
		if (asAssistant) return String(asAssistant.content || '');
		if (asUser) return String(asUser.content || '');
		return '';
	}

	const messageMenuText = $derived(getMessageMenuText());
	const canGenerateTitleFromMessage = $derived(
		Boolean(
			(asUser || asAssistant) &&
			messageMenuText.trim() &&
			activeChatContext?.chatId &&
			forkUpToSeq !== undefined &&
			onGenerateTitleFromMessage,
		),
	);
	function attachmentMimeType(attachment: { data?: string; mimeType?: string }): string {
		if (attachment.mimeType) return attachment.mimeType;
		return attachment.data?.match(/^data:([^;]+);base64,/)?.[1] ?? '';
	}

	function isImageAttachment(attachment: { data?: string; mimeType?: string }): boolean {
		return attachmentMimeType(attachment).startsWith('image/');
	}

	let messageMenuOpen = $state(false);
	let messageMenuTriggerRef = $state<HTMLElement | null>(null);
	let messageMenuContentRef = $state<HTMLElement | null>(null);
	let selectTextDialogOpen = $state(false);
	let messageLongPressTimer: ReturnType<typeof setTimeout> | null = null;
	let suppressNextMenuButtonClick = false;
	let releaseMessageMenu: (() => void) | null = null;
	let releaseSelectionDialog: (() => void) | null = null;

	async function releaseAfterPortalClose(release: (() => void) | null): Promise<void> {
		if (!release) return;
		await tick();
		release();
	}

	function handleMessageMenuOpenChange(open: boolean): void {
		if (open) {
			releaseMessageMenu ??=
				acquireTransientActivity?.(() => handleMessageMenuOpenChange(false)) ?? null;
			messageMenuOpen = true;
			return;
		}
		messageMenuOpen = false;
		const release = releaseMessageMenu;
		releaseMessageMenu = null;
		void releaseAfterPortalClose(release);
	}

	function openContextMenuFromButton(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (suppressNextMenuButtonClick) {
			suppressNextMenuButtonClick = false;
			return;
		}
		const trigger =
			(e.currentTarget as HTMLElement | null)?.closest('[data-slot="context-menu-trigger"]') ??
			messageMenuTriggerRef;
		if (trigger) {
			trigger.dispatchEvent(
				new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY }),
			);
		}
	}

	function clearMessageLongPressTimer(): void {
		if (messageLongPressTimer === null) return;
		clearTimeout(messageLongPressTimer);
		messageLongPressTimer = null;
	}

	function openContextMenuAtPoint(trigger: HTMLElement, clientX: number, clientY: number): void {
		trigger.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				clientX,
				clientY,
			}),
		);
	}

	function isMessageInteractiveTarget(event: PointerEvent): boolean {
		return (
			event.target instanceof Element &&
			Boolean(event.target.closest(MESSAGE_CONTEXT_INTERACTIVE_SELECTOR))
		);
	}

	function startMessageLongPress(trigger: HTMLElement, event: PointerEvent): void {
		if (
			event.defaultPrevented ||
			event.pointerType === 'mouse' ||
			messageMenuOpen ||
			isMessageInteractiveTarget(event)
		) {
			return;
		}
		clearMessageLongPressTimer();
		const { clientX, clientY } = event;
		messageLongPressTimer = setTimeout(() => {
			messageLongPressTimer = null;
			openContextMenuAtPoint(trigger, clientX, clientY);
		}, MESSAGE_CONTEXT_MENU_LONG_PRESS_MS);
	}

	function eventTargetsMenuContent(event: PointerEvent): boolean {
		const content = messageMenuContentRef;
		if (!content) return false;
		if (event.composedPath().includes(content)) return true;
		return event.target instanceof Node && content.contains(event.target);
	}

	function closeMessageMenuFromOutsidePointer(event: PointerEvent): void {
		if (eventTargetsMenuContent(event)) return;
		if (event.pointerType === 'touch') event.preventDefault();
		suppressNextMenuButtonClick =
			event.target instanceof Element &&
			Boolean(event.target.closest('.chat-message-menu-button, .chat-message-action-button'));
		handleMessageMenuOpenChange(false);
	}

	function closeMessageMenuFromInteractOutside(): void {
		handleMessageMenuOpenChange(false);
	}

	// Closes touch context menus on pointerdown because Bits UI defers touch dismissal to click.
	$effect(() => {
		if (!messageMenuOpen || typeof document === 'undefined') return;
		document.addEventListener('pointerdown', closeMessageMenuFromOutsidePointer, true);
		return () => {
			document.removeEventListener('pointerdown', closeMessageMenuFromOutsidePointer, true);
		};
	});

	// Opens message context menus faster than Bits UI's default long-press delay.
	$effect(() => {
		const trigger = messageMenuTriggerRef;
		if (!trigger || typeof window === 'undefined') return;

		const handlePointerDown = (event: PointerEvent) => startMessageLongPress(trigger, event);
		trigger.addEventListener('pointerdown', handlePointerDown);
		trigger.addEventListener('pointermove', clearMessageLongPressTimer);
		trigger.addEventListener('pointercancel', clearMessageLongPressTimer);
		trigger.addEventListener('pointerup', clearMessageLongPressTimer);

		return () => {
			trigger.removeEventListener('pointerdown', handlePointerDown);
			trigger.removeEventListener('pointermove', clearMessageLongPressTimer);
			trigger.removeEventListener('pointercancel', clearMessageLongPressTimer);
			trigger.removeEventListener('pointerup', clearMessageLongPressTimer);
			clearMessageLongPressTimer();
		};
	});

	async function copyText() {
		if (!messageMenuText) return;
		await copyToClipboard(messageMenuText);
	}

	function sendToNewSession() {
		if (!messageMenuText) return;
		appShell.openNewChatDialog({
			prefill: messageMenuText,
		});
	}

	function handleFork(e: MouseEvent) {
		e.stopPropagation();
		if (!canForkAtMessageNow) return;
		onForkChat?.(forkUpToSeq);
	}

	function openSelectTextDialog(): void {
		if (!messageMenuText) return;
		releaseSelectionDialog ??= acquireTransientActivity?.(closeSelectTextDialog) ?? null;
		selectTextDialogOpen = true;
	}

	async function generateTitleFromCurrentMessage(): Promise<void> {
		if (!canGenerateTitleFromMessage) return;
		await onGenerateTitleFromMessage?.(messageMenuText, forkUpToSeq);
	}

	function closeSelectTextDialog(): void {
		selectTextDialogOpen = false;
		const release = releaseSelectionDialog;
		releaseSelectionDialog = null;
		void releaseAfterPortalClose(release);
	}

	/** Routes a file-like markdown link to the viewer overlay. */
	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file') return;
		const chat = activeChatContext;
		if (!chat?.projectPath) return;
		const resolved = resolveFileLinkTarget(link.rawHref, {
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
		return true;
	}

	/** Routes a tool file-open action to the viewer overlay. */
	function handleToolFileOpen(filePath: string): void {
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

	let localThinkingOpen = $state(true);
	let thinkingOpen = $derived(
		disclosureState?.open('thinking', 'thinking', true) ?? localThinkingOpen,
	);

	function toggleThinking(): void {
		const next = !thinkingOpen;
		if (disclosureState) disclosureState.setOpen('thinking', 'thinking', next, true);
		else localThinkingOpen = next;
	}

	onDestroy(() => {
		clearMessageLongPressTimer();
		releaseMessageMenu?.();
		releaseSelectionDialog?.();
	});
</script>

{#snippet floatingMessageMenuButton(positionClass: string)}
	<button
		type="button"
		class={cn(
			'chat-message-action-button absolute z-10 h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground shadow-sm transition-[opacity,color,background-color] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			positionClass,
		)}
		onclick={openContextMenuFromButton}
		aria-label={m.chat_message_more_actions()}
	>
		<EllipsisVertical class="size-4" />
	</button>
{/snippet}

{#if !shouldHideThinking}
	<div
		class={messageClass}
		data-chat-row-id={rowId}
		data-chat-anchor-id={anchorId}
		data-chat-message-type={message.type}
	>
		{#if asUser}
			<div
				class="user-message-row group/message mt-1 flex w-full min-w-0 items-stretch gap-1.5 sm:w-auto sm:max-w-[85%]"
				data-message-menu-open={messageMenuOpen ? 'true' : undefined}
			>
				<ContextMenu open={messageMenuOpen} onOpenChange={handleMessageMenuOpenChange}>
					<ContextMenuTrigger
						bind:ref={messageMenuTriggerRef}
						class="user-message-context-target chat-message-context-target message-context-menu-trigger relative block bg-user-bubble text-user-bubble-foreground data-[state=open]:bg-user-bubble-selected rounded-xl border border-border px-3 py-2 shadow-sm flex-1 sm:flex-initial min-w-0 max-w-full"
					>
						<div>
							<div class="text-sm">
								<Markdown
									source={asUser.content}
									variant="user"
									fileLinkBasePath={projectBasePath}
									onLinkNavigate={handleLinkNavigate}
									{acquireTransientActivity}
								/>
							</div>
							{#if asUser.images && asUser.images.length > 0}
								<div class="mt-2 grid grid-cols-2 gap-2">
									{#each asUser.images as img, idx (img.name || idx)}
										{#if isImageAttachment(img)}
											<img
												src={img.data}
												alt={img.name}
												class="rounded-lg max-w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
											/>
										{:else}
											<div
												class="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2 py-1.5 text-foreground"
											>
												<FileText
													class="h-4 w-4 flex-shrink-0 text-muted-foreground"
													aria-hidden="true"
												/>
												<span class="truncate text-xs">{img.name}</span>
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent
						bind:ref={messageMenuContentRef}
						onInteractOutside={closeMessageMenuFromInteractOutside}
					>
						<MessageActionMenu
							canFork={Boolean(onForkChat && forkUpToSeq)}
							canForkNow={canForkAtMessageNow}
							onFork={handleFork}
							onCopy={copyText}
							onSendToNewSession={sendToNewSession}
							onSelectText={openSelectTextDialog}
							onGenerateTitleFromMessage={canGenerateTitleFromMessage
								? generateTitleFromCurrentMessage
								: undefined}
						/>
					</ContextMenuContent>
				</ContextMenu>
				<div
					class="user-message-accessory-rail relative w-3.5 shrink-0 [@media(hover:hover)_and_(pointer:fine)]:w-7"
				>
					{#if awaitingDelivery}
						<LoaderCircle
							class="absolute bottom-0 right-0 size-3.5 animate-spin text-muted-foreground"
							aria-label={m.chat_message_delivery_sending()}
						/>
					{:else}
						{@render floatingMessageMenuButton('bottom-0 right-0')}
					{/if}
				</div>
			</div>
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
							draft={permissionDraft?.(
								exitPlanPermissionRequest.permissionRequestId,
								exitPlanPermissionRequest.incarnation,
							)}
							{acquireTransientActivity}
							onDraftChange={onPermissionDraftChange
								? (draft) =>
										onPermissionDraftChange(
											exitPlanPermissionRequest.permissionRequestId,
											exitPlanPermissionRequest.incarnation,
											draft,
										)
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
							onFileOpen={handleToolFileOpen}
							{projectBasePath}
							{chatProjectPath}
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
							onFileOpen={handleToolFileOpen}
							{projectBasePath}
							{chatProjectPath}
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
									<div class="mt-0.5 text-sm text-foreground/90">
										<Markdown
											source={asThinking.content}
											variant="thinking"
											fileLinkBasePath={projectBasePath}
											onLinkNavigate={handleLinkNavigate}
											{acquireTransientActivity}
										/>
									</div>
								{/if}
							{/snippet}
						</ChatEventCard>
					{:else if asAssistant}
						<ContextMenu open={messageMenuOpen} onOpenChange={handleMessageMenuOpenChange}>
							<ContextMenuTrigger
								bind:ref={messageMenuTriggerRef}
								class="assistant-message-context-target chat-message-context-target message-context-menu-trigger relative -my-1 block w-full py-1"
							>
								<div class="group/message relative [@media(hover:hover)_and_(pointer:fine)]:pr-8">
									<div class="px-px text-sm text-foreground">
										<Markdown
											source={formattedContent}
											variant="assistant"
											fileLinkBasePath={projectBasePath}
											onLinkNavigate={handleLinkNavigate}
											{acquireTransientActivity}
										/>
									</div>
									{@render floatingMessageMenuButton('-bottom-1 right-1')}
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent
								bind:ref={messageMenuContentRef}
								onInteractOutside={closeMessageMenuFromInteractOutside}
							>
								<MessageActionMenu
									canFork={Boolean(onForkChat && forkUpToSeq)}
									canForkNow={canForkAtMessageNow}
									onFork={handleFork}
									onCopy={copyText}
									onSendToNewSession={sendToNewSession}
									onSelectText={openSelectTextDialog}
									onGenerateTitleFromMessage={canGenerateTitleFromMessage
										? generateTitleFromCurrentMessage
										: undefined}
								/>
							</ContextMenuContent>
						</ContextMenu>
					{:else if asError}
						<ChatEventCard variant="error">
							{#snippet body()}
								<div class="text-sm whitespace-pre-wrap break-words">{formattedContent}</div>
							{/snippet}
						</ChatEventCard>
					{:else if asCompaction}
						<CompactionRow
							message={asCompaction}
							{projectBasePath}
							onLinkNavigate={handleLinkNavigate}
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
							draft={permissionDraft?.(
								asPermissionRequest.permissionRequestId,
								asPermissionRequest.incarnation,
							)}
							{acquireTransientActivity}
							onDraftChange={onPermissionDraftChange
								? (draft) => onPermissionDraftChange(
										asPermissionRequest.permissionRequestId,
										asPermissionRequest.incarnation,
										draft,
									)
								: undefined}
						/>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

{#if !shouldHideThinking && messageMenuText}
	<MessageTextSelectionDialog
		open={selectTextDialogOpen}
		text={messageMenuText}
		onClose={closeSelectTextDialog}
	/>
{/if}
