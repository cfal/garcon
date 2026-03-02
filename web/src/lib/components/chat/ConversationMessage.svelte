<script lang="ts">
	import {
		UserMessage,
		AssistantMessage,
		ThinkingMessage,
		ToolUseMessage,
		EnterPlanModeToolUseMessage,
		ExitPlanModeToolUseMessage,
		ErrorMessage,
		PermissionRequestMessage,
	} from '$shared/chat-types';
	import type { ChatMessage, ToolResultMessage } from '$shared/chat-types';
	import type { SessionProvider } from '$lib/types/app';
	import { ChevronRight } from '@lucide/svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Copy from '@lucide/svelte/icons/copy';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import { getChatSessions, getFileViewer, getAppShell, getPreferences } from '$lib/context';
	import Markdown from './Markdown.svelte';
	import type { MarkdownLinkNavigateEvent } from './Markdown.svelte';
	import { parseFileLink } from '$lib/chat/file-link-parser';
	import ChatToolEventRenderer from './tools/ChatToolEventRenderer.svelte';
	import PermissionRequestRow from './PermissionRequestRow.svelte';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import {
		ContextMenu,
		ContextMenuTrigger,
		ContextMenuContent,
		ContextMenuItem
	} from '$lib/components/ui/context-menu';
	import * as m from '$lib/paraglide/messages.js';
	import { copyTextToClipboard } from '$lib/utils/clipboard';

	interface PermissionTerminal {
		state: 'resolved' | 'cancelled';
		allowed?: boolean;
		reason?: string;
	}

	interface Props {
		message: ChatMessage;
		index: number;
		prevMessage: ChatMessage | null;
		toolResult?: ToolResultMessage;
		permissionTerminal?: PermissionTerminal;
		onPermissionDecision?: (permissionRequestId: string, decision: { allow: boolean; message?: string }) => void;
		onExitPlanMode?: (permissionRequestId: string, choice: string, plan: string) => void;
		provider: SessionProvider | string;
		showThinking?: boolean;
	}

	let {
		message,
		index,
		prevMessage,
		toolResult,
		permissionTerminal,
		onPermissionDecision,
		onExitPlanMode,
		provider,
		showThinking = true
	}: Props = $props();

	const sessions = getChatSessions();
	const fileViewer = getFileViewer();
	const appShell = getAppShell();
	const preferences = getPreferences();

	const projectBasePath = $derived(appShell.projectBasePath);
	const chatProjectPath = $derived(sessions.selectedChat?.projectPath ?? null);

	// Groups consecutive messages of the same visual category.
	function isGroupedWith(prev: ChatMessage | null, current: ChatMessage): boolean {
		if (!prev) return false;
		const prevCategory = prev instanceof AssistantMessage ? 'assistant' : prev.type;
		const curCategory = current instanceof AssistantMessage ? 'assistant' : current.type;
		return prevCategory === curCategory;
	}

	const isGrouped = $derived(isGroupedWith(prevMessage, message));
	const formattedTime = $derived(new Date(message.timestamp).toLocaleTimeString());
	const shouldHideThinking = $derived(message instanceof ThinkingMessage && !showThinking);

	// Maps message type to a simplified CSS class name.
	function getCssType(type: string): string {
		switch (type) {
			case 'user-message': return 'user';
			case 'assistant-message': return 'assistant';
			case 'tool-use': return 'tool';
			default: return type;
		}
	}

	const cssType = $derived(getCssType(message.type));

	// Instanceof helpers for type narrowing in the template.
	const asUser = $derived(message instanceof UserMessage ? message : null);
	const asAssistant = $derived(message instanceof AssistantMessage ? message : null);
	const asThinking = $derived(message instanceof ThinkingMessage ? message : null);
	const asToolUse = $derived(message instanceof ToolUseMessage ? message : null);
	const asError = $derived(message instanceof ErrorMessage ? message : null);
	const asPermissionRequest = $derived(message instanceof PermissionRequestMessage ? message : null);

	const showNonAssistantHeader = $derived(!isGrouped && message instanceof ErrorMessage);

		/** Formats assistant or error content for display. */
		function getFormattedContent(): string {
			if (message instanceof AssistantMessage || message instanceof ErrorMessage) {
				return String(message.content || '');
			}
			return '';
		}

	const formattedContent = $derived(getFormattedContent());

	function getMessageMenuText(): string {
		if (asAssistant) return String(asAssistant.content || '');
		if (asUser) return String(asUser.content || '');
		return '';
	}

	const messageMenuText = $derived(getMessageMenuText());

	function openContextMenuFromButton(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		const trigger = (e.currentTarget as HTMLElement | null)?.closest('[data-slot="context-menu-trigger"]');
		if (trigger) {
			trigger.dispatchEvent(
				new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })
			);
		}
	}

	async function copyText() {
		if (!messageMenuText) return;
		await copyTextToClipboard(messageMenuText);
	}

	function sendToNewSession() {
		if (!messageMenuText) return;
		appShell.openNewChatDialog({
			prefill: messageMenuText
		});
	}

	/** Routes a file-like markdown link to the viewer overlay. */
	function handleLinkNavigate(link: MarkdownLinkNavigateEvent): boolean | void {
		if (link.kind !== 'file') return;
		const chat = sessions.selectedChat;
		if (!chat) return;
		const parsed = parseFileLink(link.rawHref, { projectBasePath: chat.projectPath });
		if (parsed.kind !== 'file') return;
		fileViewer.openAuto({
			chatId: chat.id,
			projectPath: chat.projectPath,
			relativePath: parsed.relativePath,
			source: 'markdown-link',
			line: parsed.line,
			col: parsed.col,
		});
		return true;
	}

	/** Routes a tool file-open action to the viewer overlay. */
	function handleToolFileOpen(filePath: string): void {
		const chat = sessions.selectedChat;
		if (!chat) return;
		fileViewer.openAuto({
			chatId: chat.id,
			projectPath: chat.projectPath,
			relativePath: filePath,
			source: 'tool',
		});
	}

	let thinkingOpen = $state(true);
</script>

{#if !shouldHideThinking}
	<div
		class="chat-message {cssType} {isGrouped ? 'grouped' : ''} {message instanceof UserMessage ? 'flex justify-start px-3 sm:px-0 min-w-0' : 'px-3 sm:px-0'}"
	>
			{#if asUser}
				<div class="flex items-end w-full sm:w-auto sm:max-w-[85%] min-w-0">
					<ContextMenu>
						<ContextMenuTrigger class="message-context-menu-trigger relative block mt-1 bg-user-bubble text-user-bubble-foreground rounded-2xl rounded-bl-md px-3 sm:px-4 py-2 shadow-sm flex-1 sm:flex-initial min-w-0 max-w-full">
							<div class="group/message">
								<div class="text-sm">
									<Markdown source={asUser.content} variant="user" {projectBasePath} onLinkNavigate={handleLinkNavigate} />
								</div>
								{#if asUser.images && asUser.images.length > 0}
									<div class="mt-2 grid grid-cols-2 gap-2">
										{#each asUser.images as img, idx (img.name || idx)}
											<img
												src={img.data}
												alt={img.name}
												class="rounded-lg max-w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
											/>
										{/each}
									</div>
								{/if}
								<div class="mt-1 flex items-center justify-between gap-2">
									<div class="text-xs text-user-bubble-timestamp text-left">
										{formattedTime}
									</div>
									<div class="message-menu-actions flex justify-end opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100">
										<button
											type="button"
											class="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
											onclick={openContextMenuFromButton}
										>
											<EllipsisVertical class="size-4" />
										</button>
									</div>
								</div>
							</div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem onclick={copyText}>
								<Copy />
								Copy Text
							</ContextMenuItem>
							<ContextMenuItem onclick={sendToNewSession}>
								<SquareArrowOutUpRight />
								Send to New Session
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
				</div>
		{:else}
			<div class="w-full">
						{#if showNonAssistantHeader}
							<div class="flex items-center space-x-3 mb-2">
								<div class="w-8 h-8 bg-status-error rounded-full flex items-center justify-center text-status-error-foreground text-sm flex-shrink-0">
									!
								</div>
							<div class="text-sm font-medium text-foreground">
								{m.chat_message_error()}
							</div>
						</div>
					{/if}

					<div class="w-full">
						{#if asToolUse instanceof EnterPlanModeToolUseMessage}
							<ChatEventCard variant="info" compact>
								{#snippet body()}
									<span class="text-xs font-medium">
										{m.chat_message_entered_plan_mode()}
									</span>
								{/snippet}
							</ChatEventCard>
					{:else if asToolUse instanceof ExitPlanModeToolUseMessage}
						{@const exitPlanMsg = asToolUse}
						<PermissionRequestRow
							request={{
								type: 'permission-request',
								timestamp: message.timestamp,
								permissionRequestId: `plan-exit-${exitPlanMsg.toolId}`,
								toolName: 'ExitPlanMode',
								toolInput: { plan: exitPlanMsg.plan, allowedPrompts: exitPlanMsg.allowedPrompts },
							}}
							terminal={permissionTerminal}
							onDecision={onPermissionDecision ?? (() => {})}
							{onExitPlanMode}
						/>
					{:else if asToolUse}
						<ChatToolEventRenderer
							toolMessage={asToolUse}
							toolResult={toolResult ? { content: toolResult.content, isError: toolResult.isError } : undefined}
							mode="input"
							autoExpandTools={preferences.autoExpandTools}
							onFileOpen={handleToolFileOpen}
						/>
						{:else if asThinking}
							<ChatEventCard variant="thinking" compact>
								{#snippet body()}
									<button
										type="button"
										class="flex w-full items-center gap-2 text-left cursor-pointer"
										onclick={() => { thinkingOpen = !thinkingOpen; }}
										aria-expanded={thinkingOpen}
									>
										<span class="text-xs font-medium text-muted-foreground">{m.chat_message_thinking()}</span>
										<ChevronRight class="ml-auto w-3 h-3 transition-transform {thinkingOpen ? 'rotate-90' : ''}" />
									</button>
									{#if thinkingOpen}
										<div class="mt-0.5 text-sm text-foreground/90">
											<Markdown source={asThinking.content} variant="thinking" {projectBasePath} onLinkNavigate={handleLinkNavigate} />
										</div>
									{/if}
								{/snippet}
							</ChatEventCard>
						{:else if asAssistant}
							<ContextMenu>
								<ContextMenuTrigger class="message-context-menu-trigger relative block">
									<div class="group/message">
										<div class="text-sm text-foreground">
											<Markdown source={formattedContent} variant="assistant" {projectBasePath} onLinkNavigate={handleLinkNavigate} />
										</div>
										<div class="message-menu-actions mt-1 flex justify-end opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100">
											<button
												type="button"
												class="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
												onclick={openContextMenuFromButton}
										>
											<EllipsisVertical class="size-4" />
										</button>
										</div>
									</div>
								</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onclick={copyText}>
									<Copy />
									Copy Text
								</ContextMenuItem>
								<ContextMenuItem onclick={sendToNewSession}>
									<SquareArrowOutUpRight />
									Send to New Session
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
						{:else if asError}
							<ChatEventCard variant="error">
								{#snippet body()}
									<div class="text-sm whitespace-pre-wrap break-words">{formattedContent}</div>
								{/snippet}
							</ChatEventCard>
					{:else if asPermissionRequest && onPermissionDecision}
						<PermissionRequestRow
							request={asPermissionRequest}
							terminal={permissionTerminal}
							onDecision={onPermissionDecision}
							{onExitPlanMode}
						/>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
