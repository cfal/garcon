<script lang="ts">
	import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import { cn } from '$lib/utils/cn';
	import { getMinuteClock } from '$lib/context';
	import ChatSummary from '$lib/components/chat/ChatSummary.svelte';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import {
		isChatTagRefreshRequired,
		type ChatTagReconciliationKind,
	} from '$lib/chat/sessions/chat-sessions-contract.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getChatBoardCardDragData } from './chat-board-dnd.js';

	let {
		occurrence,
		layout,
		instanceId,
		boardId,
		canDrag,
		pending,
		reconciliationKind,
		canTransition,
		occurrenceIndex,
		onOpen,
		onTransition,
		onReconcileTags,
	}: {
		occurrence: ChatBoardOccurrence;
		layout: ChatItemLayout;
		instanceId: string;
		boardId: string;
		canDrag: boolean;
		pending: boolean;
		reconciliationKind: ChatTagReconciliationKind;
		canTransition: boolean;
		occurrenceIndex: number;
		onOpen: (chatId: string) => void;
		onTransition: (occurrence: ChatBoardOccurrence, invoker: HTMLElement) => void;
		onReconcileTags: (chatId: string) => void;
	} = $props();

	const minuteClock = getMinuteClock();
	const componentId = $props.id();
	const statusDescriptionId = `${componentId}-status`;
	let cardRef = $state<HTMLElement | null>(null);
	let handleRef = $state<HTMLButtonElement | null>(null);
	let dragging = $state(false);
	let title = $derived(occurrence.chat.title || m.sidebar_chats_unnamed());
	let statusDescription = $derived.by(() => {
		const descriptions: string[] = [];
		if (occurrence.chat.isUnread) descriptions.push(m.sidebar_chat_unread());
		if (occurrence.chat.isProcessing) descriptions.push(m.chat_window_processing());
		return descriptions.join('. ');
	});
	let reconciliationLabel = $derived(
		isChatTagRefreshRequired(reconciliationKind)
			? m.chat_board_refreshing_tags()
			: m.chat_board_confirming_tags(),
	);

	function summaryPadding(itemLayout: ChatItemLayout): string {
		switch (itemLayout) {
			case 'single-line':
				return 'px-3 py-2';
			case 'compact':
				return 'px-3 py-2.5';
			case 'detailed':
				return 'px-3 py-3';
		}
	}

	$effect(() => {
		if (!canDrag || !cardRef || !handleRef) return;
		return draggable({
			element: cardRef,
			dragHandle: handleRef,
			getInitialData: () => ({
				...getChatBoardCardDragData({
					instanceId,
					boardId,
					sourceColumnId: occurrence.columnId,
					chatId: occurrence.chat.id,
				}),
			}),
			onDragStart: () => (dragging = true),
			onDrop: () => (dragging = false),
		});
	});
</script>

<article
	bind:this={cardRef}
	class={cn(
		'group relative overflow-hidden rounded-[10px] border border-chat-board-card-border bg-chat-board-card shadow-[var(--chat-board-shadow)] transition-[border-color,background-color,box-shadow,transform] duration-150',
		'hover:-translate-y-px hover:border-foreground/20 hover:bg-chat-board-card-hover hover:shadow-sm focus-within:border-foreground/25',
		dragging && 'scale-[0.99] opacity-70',
		pending && 'border-status-info-border',
		reconciliationKind && 'border-status-warning-border',
	)}
	data-chat-board-occurrence={occurrence.key}
	data-chat-board-chat-id={occurrence.chat.id}
	data-chat-board-occurrence-index={occurrenceIndex}
	data-chat-board-dragging={dragging ? '' : undefined}
>
	{#if statusDescription}
		<span id={statusDescriptionId} class="sr-only">{statusDescription}</span>
	{/if}
	<div class="flex min-w-0 items-stretch">
		<button
			type="button"
			class={cn(
				'min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
				summaryPadding(layout),
			)}
			aria-label={m.chat_board_open_chat({ title })}
			aria-describedby={statusDescription ? statusDescriptionId : undefined}
			onclick={() => onOpen(occurrence.chat.id)}
			data-chat-board-open
			data-chat-board-focus-target="open"
		>
			<ChatSummary
				session={occurrence.chat}
				variant="board"
				chatItemLayout={layout}
				currentTime={minuteClock.currentTime}
				showTimestamp
				showProjectPath={false}
			/>
		</button>

		<div class="flex w-9 shrink-0 flex-col border-l border-border/70 bg-muted/20">
			<button
				type="button"
				class="grid min-h-9 flex-1 place-items-center text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35"
				aria-label={m.chat_board_transition()}
				title={m.chat_board_transition()}
				disabled={!canTransition || pending || reconciliationKind !== null}
				onclick={(event) => onTransition(occurrence, event.currentTarget)}
				data-chat-board-focus-target="transition"
			>
				<ArrowRight class="size-3.5" aria-hidden="true" />
			</button>
			{#if canDrag}
				<button
					bind:this={handleRef}
					type="button"
					class="grid min-h-8 place-items-center border-t border-border/70 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					aria-label={m.chat_board_drag({ title })}
					data-chat-board-focus-target="drag"
				>
					<GripVertical class="size-3.5" aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>

	{#if reconciliationKind}
		<button
			type="button"
			class="flex w-full items-center gap-1.5 border-t border-status-warning-border bg-status-warning/10 px-3 py-1 text-left text-[11px] font-medium text-status-warning-muted-foreground outline-none hover:bg-status-warning/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			onclick={() => onReconcileTags(occurrence.chat.id)}
			data-chat-board-focus-target="recovery"
		>
			<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
			<span class="flex-1">{reconciliationLabel}</span>
			<span class="underline decoration-current/50 underline-offset-2">
				{m.chat_board_try_again()}
			</span>
		</button>
	{:else if pending}
		<div
			class="flex items-center gap-1.5 border-t border-status-info-border bg-status-info px-3 py-1 text-[11px] font-medium text-status-info-foreground"
			role="status"
		>
			<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
			{m.chat_board_updating_tags()}
		</div>
	{/if}
</article>
