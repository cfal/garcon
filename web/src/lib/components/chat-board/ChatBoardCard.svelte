<script lang="ts">
	import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import { cn } from '$lib/utils/cn';
	import ChatSummary from '$lib/components/chat/ChatSummary.svelte';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import type { ChatItemLayout } from '$lib/chat/presentation/chat-item-layout.js';
	import * as m from '$lib/paraglide/messages.js';
	import { getChatBoardCardDragData } from './chat-board-dnd.js';

	let {
		occurrence,
		layout,
		instanceId,
		boardId,
		canDrag,
		pending,
		recoveryRequired,
		canTransition,
		occurrenceIndex,
		onOpen,
		onTransition,
	}: {
		occurrence: ChatBoardOccurrence;
		layout: ChatItemLayout;
		instanceId: string;
		boardId: string;
		canDrag: boolean;
		pending: boolean;
		recoveryRequired: boolean;
		canTransition: boolean;
		occurrenceIndex: number;
		onOpen: (chatId: string) => void;
		onTransition: (occurrence: ChatBoardOccurrence) => void;
	} = $props();

	let cardRef = $state<HTMLElement | null>(null);
	let handleRef = $state<HTMLButtonElement | null>(null);
	let dragging = $state(false);
	let title = $derived(occurrence.chat.title || m.sidebar_chats_unnamed());

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
		recoveryRequired && 'border-status-warning-border',
	)}
	data-chat-board-occurrence={occurrence.key}
	data-chat-board-chat-id={occurrence.chat.id}
	data-chat-board-occurrence-index={occurrenceIndex}
	data-chat-board-dragging={dragging ? '' : undefined}
>
	<div class="flex min-w-0 items-stretch">
		<button
			type="button"
			class={cn(
				'min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
				layout === 'single-line' ? 'px-3 py-2' : layout === 'compact' ? 'px-3 py-2.5' : 'px-3 py-3',
			)}
			aria-label={m.chat_board_open_chat({ title })}
			onclick={() => onOpen(occurrence.chat.id)}
			data-chat-board-open
		>
			<ChatSummary
				session={occurrence.chat}
				variant="board"
				chatItemLayout={layout}
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
				disabled={!canTransition || pending || recoveryRequired}
				onclick={() => onTransition(occurrence)}
			>
				<ArrowRight class="size-3.5" aria-hidden="true" />
			</button>
			{#if canDrag}
				<button
					bind:this={handleRef}
					type="button"
					class="grid min-h-8 place-items-center border-t border-border/70 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					aria-label={m.chat_board_drag({ title })}
				>
					<GripVertical class="size-3.5" aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>

	{#if pending || recoveryRequired}
		<div
			class={cn(
				'flex items-center gap-1.5 border-t px-3 py-1 text-[11px] font-medium',
				recoveryRequired
					? 'border-status-warning-border bg-status-warning/10 text-status-warning-muted-foreground'
					: 'border-status-info-border bg-status-info text-status-info-foreground',
			)}
			role="status"
		>
			<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
			{recoveryRequired ? m.chat_board_confirming_tags() : m.chat_board_updating_tags()}
		</div>
	{/if}
</article>
