<script lang="ts">
	import { onDestroy, tick, type Snippet } from 'svelte';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import { getAppShell } from '$lib/context';
	import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from '$lib/components/ui/context-menu';
	import * as m from '$lib/paraglide/messages.js';
	import { formatQuoteBlock } from '$lib/chat/composer/quote-selection.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { cn } from '$lib/utils/cn';
	import MessageActionMenu from './MessageActionMenu.svelte';
	import MessageTextSelectionDialog from './MessageTextSelectionDialog.svelte';

	const MESSAGE_CONTEXT_MENU_LONG_PRESS_MS = 250;
	const MESSAGE_CONTEXT_INTERACTIVE_SELECTOR =
		'a, button, input, textarea, select, [role="button"], [contenteditable]:not([contenteditable="false"])';

	type MenuButton = Snippet<[positionClass: string]>;
	interface Props {
		isVisible: boolean;
		messageMenuText: string;
		forkUpToSeq?: number;
		canForkAtMessageNow: boolean;
		onForkChat?: (upToSeq?: number) => void;
		onClearBefore?: (ordinal: number) => void;
		onAppendToDraft?: (block: string) => void;
		onGenerateTitleFromMessage?: (message: string, ordinal?: number) => void | Promise<void>;
		acquireTransientActivity?: (close: () => void) => () => void;
		triggerClass: string;
		presentationStyle?: string;
		children: Snippet<[MenuButton]>;
		frame?: Snippet<[trigger: Snippet, menuButton: MenuButton, open: boolean | undefined]>;
	}

	let {
		isVisible, messageMenuText, forkUpToSeq, canForkAtMessageNow, onForkChat, onClearBefore,
		onAppendToDraft, onGenerateTitleFromMessage, acquireTransientActivity, triggerClass,
		presentationStyle, children, frame,
	}: Props = $props();
	const appShell = getAppShell();
	const canGenerateTitleFromMessage = $derived(
		Boolean(onGenerateTitleFromMessage && messageMenuText.trim() && forkUpToSeq !== undefined),
	);

	// Undefined keeps unopened portals out of document.body; false retains their close and focus lifecycle.
	let messageMenuOpen = $state<boolean>();
	let messageMenuTriggerRef = $state<HTMLElement | null>(null);
	let messageMenuContentRef = $state<HTMLElement | null>(null);
	let selectTextDialogOpen = $state<boolean>();
	let messageSelectionText = $state<string | null>(null);
	let messageLongPressTimer: ReturnType<typeof setTimeout> | null = null;
	let suppressNextMenuButtonClick = false;
	let releaseMessageMenu: (() => void) | null = null;
	let releaseSelectionDialog: (() => void) | null = null;

	const hasMessageSelection = $derived(messageSelectionText !== null);

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
			if (!isVisible) return;
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
		if (!isVisible || !trigger || typeof window === 'undefined') return;

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

	// Snapshots the live selection on the capture-phase contextmenu event, before Bits UI
	// focus management can collapse it. Each menu open overwrites the previous snapshot.
	function captureMessageSelection(): void {
		const trigger = messageMenuTriggerRef;
		const selection = window.getSelection();
		if (!trigger || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
			messageSelectionText = null;
			return;
		}
		const fullyInsideMessage = Array.from({ length: selection.rangeCount }, (_, index) => {
			const range = selection.getRangeAt(index);
			return trigger.contains(range.startContainer) && trigger.contains(range.endContainer);
		}).every(Boolean);
		const text = selection.toString();
		messageSelectionText = fullyInsideMessage && text.trim() ? text : null;
	}

	async function copyText() {
		const text = messageSelectionText ?? messageMenuText;
		if (!text) return;
		await copyToClipboard(text);
	}

	function quoteSelection() {
		const text = messageSelectionText;
		if (!text) return;
		onAppendToDraft?.(formatQuoteBlock(text));
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

	onDestroy(() => {
		clearMessageLongPressTimer();
		releaseMessageMenu?.();
		releaseSelectionDialog?.();
	});
</script>

{#snippet messageMenuContent()}
	{#if messageMenuOpen !== undefined}
		<ContextMenuContent
			bind:ref={messageMenuContentRef}
			onInteractOutside={closeMessageMenuFromInteractOutside}
		>
			<MessageActionMenu
				hasSelection={hasMessageSelection}
				canFork={Boolean(onForkChat && forkUpToSeq)}
				onClearBefore={onClearBefore && forkUpToSeq !== undefined ? () => onClearBefore?.(forkUpToSeq!) : undefined}
				canForkNow={canForkAtMessageNow}
				onFork={handleFork}
				onCopy={copyText}
				onQuoteSelection={onAppendToDraft ? quoteSelection : undefined}
				onSendToNewSession={sendToNewSession}
				onSelectText={openSelectTextDialog}
				onGenerateTitleFromMessage={canGenerateTitleFromMessage
					? generateTitleFromCurrentMessage
					: undefined}
			/>
		</ContextMenuContent>
	{/if}
{/snippet}

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

{#snippet trigger()}
	<ContextMenu open={messageMenuOpen} onOpenChange={handleMessageMenuOpenChange}>
		<ContextMenuTrigger
			disabled={!isVisible}
			bind:ref={messageMenuTriggerRef}
			oncontextmenucapture={captureMessageSelection}
			class={triggerClass}
			data-user-message-presentation={presentationStyle}
		>
			{@render children(floatingMessageMenuButton)}
		</ContextMenuTrigger>
		{@render messageMenuContent()}
	</ContextMenu>
{/snippet}

{#if frame}
	{@render frame(trigger, floatingMessageMenuButton, messageMenuOpen)}
{:else}
	{@render trigger()}
{/if}

{#if selectTextDialogOpen !== undefined && messageMenuText}
	<MessageTextSelectionDialog
		open={selectTextDialogOpen}
		text={messageMenuText}
		onClose={closeSelectTextDialog}
	/>
{/if}
