<script lang="ts">
	import {
		UserMessage,
		AssistantMessage,
		ThinkingMessage,
		isToolUseMessage,
		ErrorMessage,
		PermissionRequestMessage,
		CompactionMessage,
		AgentSwitchMessage,
	} from '$shared/chat-types';
	import type { ChatMessage, ToolResultMessage, ToolUseChatMessage } from '$shared/chat-types';
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
	import {
		askUserQuestionPermissionId,
		askUserQuestionTerminalFromResult,
		type PermissionTerminalState,
	} from '$lib/chat/transcript/conversation-feed-items.js';

	const MESSAGE_CONTEXT_MENU_LONG_PRESS_MS = 250;
	const MESSAGE_CONTEXT_INTERACTIVE_SELECTOR =
		'a, button, input, textarea, select, [role="button"], [contenteditable]:not([contenteditable="false"])';

	interface Props {
		message: ChatMessage;
		rowId?: string;
		index: number;
		forkUpToSeq?: number;
		prevMessage: ChatMessage | null;
		toolResult?: ToolResultMessage;
		permissionTerminal?: PermissionTerminalState;
		onPermissionDecision?: (
			permissionRequestId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		agentId: SessionAgentId | string;
		showThinking?: boolean;
		chatContext?: ConversationMessageChatContext | null;
		/** Forks the current chat from the in-chat action. Omitted when the agent cannot fork. */
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
	}

	let {
		message,
		rowId,
		index,
		forkUpToSeq,
		prevMessage,
		toolResult,
		permissionTerminal,
		onPermissionDecision,
		onExitPlanMode,
		agentId,
		showThinking = true,
		chatContext = null,
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
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

	// Groups consecutive messages of the same visual category.
	function isGroupedWith(prev: ChatMessage | null, current: ChatMessage): boolean {
		if (!prev) return false;
		const prevCategory = prev instanceof AssistantMessage ? 'assistant' : prev.type;
		const curCategory = current instanceof AssistantMessage ? 'assistant' : current.type;
		return prevCategory === curCategory;
	}

	const isGrouped = $derived(isGroupedWith(prevMessage, message));
	const shouldHideThinking = $derived(message instanceof ThinkingMessage && !showThinking);

	// Maps message type to a simplified CSS class name.
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

	// Type narrowing helpers for the template.
	const asUser = $derived(message instanceof UserMessage ? message : null);
	const asAssistant = $derived(message instanceof AssistantMessage ? message : null);
	const asThinking = $derived(message instanceof ThinkingMessage ? message : null);
	const asToolUse = $derived(isToolUseMessage(message) ? message : null);
	const asError = $derived(message instanceof ErrorMessage ? message : null);
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
	const askUserQuestionPermissionRequest = $derived(
		asToolUse?.type === 'ask-user-question-tool-use' && toolResult
			? new PermissionRequestMessage(
					message.timestamp,
					askUserQuestionPermissionId(asToolUse.toolId),
					asToolUse,
				)
			: null,
	);
	const askUserQuestionTerminal = $derived(
		asToolUse?.type === 'ask-user-question-tool-use'
			? askUserQuestionTerminalFromResult(asToolUse, toolResult)
			: undefined,
	);
	const userDeliveryStatus = $derived(asUser?.metadata?.deliveryStatus ?? null);
	const userDeliveryTitle = $derived(
		userDeliveryStatus === 'submitting'
			? m.chat_message_delivery_sending()
			: userDeliveryStatus === 'unconfirmed'
				? m.chat_message_delivery_unconfirmed()
				: userDeliveryStatus === 'failed'
					? m.chat_message_delivery_failed()
					: '',
	);

	const showNonAssistantHeader = $derived(!isGrouped && message instanceof ErrorMessage);

	/** Formats assistant or error content for display. */
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
			isGrouped && 'grouped',
			message instanceof UserMessage && 'flex justify-start min-w-0',
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
			asUser &&
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
		messageMenuOpen = false;
	}

	function closeMessageMenuFromInteractOutside(): void {
		messageMenuOpen = false;
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
		selectTextDialogOpen = true;
	}

	async function generateTitleFromCurrentMessage(): Promise<void> {
		if (!canGenerateTitleFromMessage) return;
		await onGenerateTitleFromMessage?.(messageMenuText, forkUpToSeq);
	}

	function closeSelectTextDialog(): void {
		selectTextDialogOpen = false;
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

	let thinkingOpen = $state(true);
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
	<div class={messageClass} data-chat-row-id={rowId}>
		{#if asUser}
			<div
				class="user-message-row group/message mt-1 flex w-full min-w-0 items-stretch gap-1.5 sm:w-auto sm:max-w-[85%]"
				data-message-menu-open={messageMenuOpen ? 'true' : undefined}
			>
				<ContextMenu bind:open={messageMenuOpen}>
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
					{@render floatingMessageMenuButton('bottom-0 right-0')}
					{#if userDeliveryStatus === 'submitting' || userDeliveryStatus === 'unconfirmed' || userDeliveryStatus === 'failed'}
						<span
							class={cn(
								'user-message-delivery-indicator absolute left-1/2 top-1/2 inline-flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center',
								userDeliveryStatus === 'failed' && 'text-status-error-foreground',
								userDeliveryStatus === 'unconfirmed' && 'text-status-warning-muted-foreground',
							)}
							title={userDeliveryTitle}
							aria-label={userDeliveryTitle}
						>
							{#if userDeliveryStatus === 'submitting'}
								<LoaderCircle class="size-3.5 animate-spin" />
							{:else}
								<CircleAlert class="size-3" />
							{/if}
						</span>
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
							onDecision={onPermissionDecision ?? (() => {})}
							{onExitPlanMode}
							{chatContext}
						/>
					{:else if askUserQuestionPermissionRequest}
						<PermissionRequestRow
							request={askUserQuestionPermissionRequest}
							terminal={askUserQuestionTerminal}
							onDecision={onPermissionDecision ?? (() => {})}
							{chatContext}
						/>
					{:else if asToolUse}
						<ChatToolEventRenderer
							toolMessage={asToolUse}
							toolResult={toolResult
								? { content: toolResult.content, isError: toolResult.isError }
								: undefined}
							mode="input"
							autoExpandTools={localSettings.autoExpandTools}
							onFileOpen={handleToolFileOpen}
							{projectBasePath}
							{chatProjectPath}
						/>
					{:else if asThinking}
						<ChatEventCard variant="thinking" compact>
							{#snippet body()}
								<button
									type="button"
									class="flex w-full items-center gap-2 text-left cursor-pointer"
									onclick={() => {
										thinkingOpen = !thinkingOpen;
									}}
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
										/>
									</div>
								{/if}
							{/snippet}
						</ChatEventCard>
					{:else if asAssistant}
						<ContextMenu bind:open={messageMenuOpen}>
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
						/>
					{:else if asAgentSwitch}
						<AgentSwitchRow message={asAgentSwitch} />
					{:else if asPermissionRequest && onPermissionDecision}
						<PermissionRequestRow
							request={asPermissionRequest}
							terminal={permissionTerminal}
							onDecision={onPermissionDecision}
							{onExitPlanMode}
							{chatContext}
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
