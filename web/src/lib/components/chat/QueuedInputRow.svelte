<script lang="ts">
	import { tick } from 'svelte';
	import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
	import {
		draggable,
		dropTargetForElements,
	} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import {
		attachClosestEdge,
		extractClosestEdge,
		type Edge,
	} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import type { QueueEntry } from '$lib/types/chat';
	import type { QueueEntryPlacement } from '$shared/chat-command-contracts';
	import {
		isQueuedInputDragData,
		placementFromEdge,
		queuedInputDragData,
	} from './queued-input-dnd.js';
	import * as m from '$lib/paraglide/messages.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface Props {
		entry: QueueEntry;
		position: number;
		error?: string;
		deleting: boolean;
		editDisabled: boolean;
		deleteDisabled: boolean;
		movePending: boolean;
		moveBlocked: boolean;
		canMoveUp: boolean;
		canMoveDown: boolean;
		dragEnabled: boolean;
		onEdit: (entry: QueueEntry) => void;
		onDelete: (entryId: string) => void;
		onMove: (entryId: string, delta: -1 | 1) => Promise<void>;
		onDrop: (
			sourceEntryId: string,
			targetEntryId: string,
			placement: QueueEntryPlacement,
		) => Promise<void>;
		onFocusFallback: () => void;
	}

	let {
		entry,
		position,
		error,
		deleting,
		editDisabled,
		deleteDisabled,
		movePending,
		moveBlocked,
		canMoveUp,
		canMoveDown,
		dragEnabled,
		onEdit,
		onDelete,
		onMove,
		onDrop,
		onFocusFallback,
	}: Props = $props();

	let rowElement: HTMLLIElement | null = $state(null);
	let dragHandleElement: HTMLSpanElement | null = $state(null);
	let upButtonElement: HTMLButtonElement | null = $state(null);
	let downButtonElement: HTMLButtonElement | null = $state(null);
	let requestedDirection = $state<-1 | 1 | null>(null);
	let isDragging = $state(false);
	let dropIndicatorEdge = $state<Edge | null>(null);

	$effect(() => {
		if (!rowElement || !dragHandleElement || !dragEnabled) return;
		return combine(
			draggable({
				element: rowElement,
				dragHandle: dragHandleElement,
				getInitialData: () => queuedInputDragData(entry.id),
				canDrag: () => !moveBlocked,
				onDragStart: () => (isDragging = true),
				onDrop: () => (isDragging = false),
			}),
			dropTargetForElements({
				element: rowElement,
				canDrop: ({ source }) =>
					!moveBlocked &&
					isQueuedInputDragData(source.data) &&
					source.data.entryId !== entry.id,
				getData: ({ input, element }) =>
					attachClosestEdge(queuedInputDragData(entry.id), {
						input,
						element,
						allowedEdges: ['top', 'bottom'],
					}),
				getDropEffect: () => 'move',
				onDragEnter: ({ self }) => (dropIndicatorEdge = extractClosestEdge(self.data)),
				onDrag: ({ self }) => (dropIndicatorEdge = extractClosestEdge(self.data)),
				onDragLeave: () => (dropIndicatorEdge = null),
				onDrop: ({ source, self }) => {
					const placement = placementFromEdge(extractClosestEdge(self.data));
					dropIndicatorEdge = null;
					if (isQueuedInputDragData(source.data) && placement) {
						void onDrop(source.data.entryId, entry.id, placement);
					}
				},
			}),
		);
	});

	async function move(delta: -1 | 1): Promise<void> {
		if (moveBlocked || (delta === -1 ? !canMoveUp : !canMoveDown)) return;
		requestedDirection = delta;
		try {
			await onMove(entry.id, delta);
		} finally {
			requestedDirection = null;
			await tick();
			const requestedButton = delta === -1 ? upButtonElement : downButtonElement;
			const fallbackButton = delta === -1 ? downButtonElement : upButtonElement;
			if (requestedButton && !requestedButton.disabled) requestedButton.focus();
			else if (fallbackButton && !fallbackButton.disabled) fallbackButton.focus();
			else onFocusFallback();
		}
	}
</script>

<li
	bind:this={rowElement}
	class="relative flex items-start gap-3 px-5 py-4 transition-opacity sm:px-6"
	class:opacity-50={isDragging}
>
	{#if dropIndicatorEdge === 'top'}
		<div class="pointer-events-none absolute inset-x-5 top-0 h-0.5 bg-primary sm:inset-x-6"></div>
	{:else if dropIndicatorEdge === 'bottom'}
		<div class="pointer-events-none absolute inset-x-5 bottom-0 h-0.5 bg-primary sm:inset-x-6"></div>
	{/if}
	{#if dragEnabled}
		<span
			bind:this={dragHandleElement}
			data-queue-drag-id={entry.id}
			class="mt-0.5 flex size-8 shrink-0 items-center justify-center text-muted-foreground"
			class:cursor-grab={!moveBlocked}
			class:cursor-default={moveBlocked}
			class:opacity-50={moveBlocked}
			aria-label={m.chat_queue_drag_handle({ position })}
			role="img"
			title={m.chat_queue_drag_handle({ position })}
		>
			<GripVertical class="size-4" />
		</span>
	{/if}
	<span class="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
		{position}
	</span>
	<div class="min-w-0 flex-1">
		<p class="whitespace-pre-wrap break-words text-sm leading-5">{entry.content}</p>
		{#if error}
			<p class="mt-2 text-xs text-destructive" role="alert">{error}</p>
		{/if}
	</div>
	<div class="flex shrink-0 items-center gap-0.5">
		<button
			bind:this={upButtonElement}
			type="button"
			data-queue-move-id={entry.id}
			data-queue-move-direction="up"
			onclick={() => void move(-1)}
			disabled={!canMoveUp}
			aria-disabled={moveBlocked}
			aria-busy={movePending && requestedDirection === -1}
			class="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50"
			title={m.chat_queue_move_up({ position })}
			aria-label={m.chat_queue_move_up({ position })}
		>
			{#if movePending && requestedDirection === -1}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<ChevronUp class="h-4 w-4" />
			{/if}
		</button>
		<button
			bind:this={downButtonElement}
			type="button"
			data-queue-move-id={entry.id}
			data-queue-move-direction="down"
			onclick={() => void move(1)}
			disabled={!canMoveDown}
			aria-disabled={moveBlocked}
			aria-busy={movePending && requestedDirection === 1}
			class="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50"
			title={m.chat_queue_move_down({ position })}
			aria-label={m.chat_queue_move_down({ position })}
		>
			{#if movePending && requestedDirection === 1}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<ChevronDown class="h-4 w-4" />
			{/if}
		</button>
		<button
			type="button"
			data-queue-edit-id={entry.id}
			onclick={() => onEdit(entry)}
			disabled={editDisabled}
			class="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			title={m.chat_queue_edit_message()}
			aria-label={m.chat_queue_edit_message()}
		>
			<Pencil class="h-4 w-4" />
		</button>
		<button
			type="button"
			onclick={() => onDelete(entry.id)}
			disabled={deleteDisabled}
			class="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			title={m.chat_queue_remove_from_queue()}
			aria-label={m.chat_queue_remove_from_queue()}
		>
			{#if deleting}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Trash2 class="h-4 w-4" />
			{/if}
		</button>
	</div>
</li>
