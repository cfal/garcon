<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import type { VirtualItem } from '$lib/virt/virtual-list-types.js';
	import {
		draggable,
		dropTargetForElements,
	} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
	import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
	import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge';
	import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge';
	import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
	import type { QueueEntry } from '$lib/types/chat';
	import type { QueueEntryPlacement } from '$shared/chat-command-contracts';
	import {
		isQueuedInputDragData,
		placementFromEdge,
		queuedInputDragData,
	} from './queued-input-dnd.js';
	import QueuedInputAttachments from './QueuedInputAttachments.svelte';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages.js';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Clock3 from '@lucide/svelte/icons/clock-3';
	import CornerUpRight from '@lucide/svelte/icons/corner-up-right';
	import FastForward from '@lucide/svelte/icons/fast-forward';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface Props {
		chatId: string;
		entry: QueueEntry;
		position: number;
		count: number;
		virtualItem: VirtualItem;
		measurement: Attachment<HTMLElement>;
		expanded: boolean;
		onToggle: () => void;
		onRetain: (reason: 'focus' | 'drag' | 'menu', active: boolean) => void;
		blocked: boolean;
		steering: boolean;
		deleting: boolean;
		canSteer: boolean;
		canInterrupt: boolean;
		onEdit: () => void;
		onDelete: () => void;
		onSteer: () => void;
		onInterrupt: () => void;
		onDrop: (sourceId: string, targetId: string, placement: QueueEntryPlacement) => Promise<void>;
	}
	let {
		chatId,
		entry,
		position,
		count,
		virtualItem,
		measurement,
		expanded,
		onToggle,
		onRetain,
		blocked,
		steering,
		deleting,
		canSteer,
		canInterrupt,
		onEdit,
		onDelete,
		onSteer,
		onInterrupt,
		onDrop,
	}: Props = $props();
	let rowElement = $state<HTMLLIElement | null>(null);
	let dragHandle = $state<HTMLSpanElement | null>(null);
	let menuTrigger = $state<HTMLElement | null>(null);
	let menuOpen = $state(false);
	let dragging = $state(false);
	let edge = $state<Edge | null>(null);
	const attachmentNames = $derived(
		entry.attachments.map((attachment) => attachment.name).join(', '),
	);
	const steerBlocked = $derived(blocked || entry.attachments.length > 0);
	const iconButtonClass =
		'grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
	$effect(() => {
		onRetain('menu', menuOpen);
	});

	$effect(() => {
		if (!rowElement || !dragHandle || blocked) return;
		const operationChatId = chatId;
		return combine(
			draggable({
				element: rowElement,
				dragHandle,
				getInitialData: () => ({ ...queuedInputDragData(entry.id), chatId: operationChatId }),
				canDrag: () => !blocked && !menuOpen,
				onDragStart: () => {
					dragging = true;
					onRetain('drag', true);
				},
				onDrop: () => {
					dragging = false;
					onRetain('drag', false);
				},
			}),
			dropTargetForElements({
				element: rowElement,
				canDrop: ({ source }) =>
					!blocked &&
					isQueuedInputDragData(source.data) &&
					source.data.chatId === operationChatId &&
					source.data.entryId !== entry.id,
				getData: ({ input, element }) =>
					attachClosestEdge(queuedInputDragData(entry.id), {
						input,
						element,
						allowedEdges: ['top', 'bottom'],
					}),
				getDropEffect: () => 'move',
				onDragEnter: ({ self }) => (edge = extractClosestEdge(self.data)),
				onDrag: ({ self }) => (edge = extractClosestEdge(self.data)),
				onDragLeave: () => (edge = null),
				onDrop: ({ source, self }) => {
					const placement = placementFromEdge(extractClosestEdge(self.data));
					edge = null;
					if (
						!blocked &&
						source.data.chatId === chatId &&
						isQueuedInputDragData(source.data) &&
						placement
					)
						void onDrop(source.data.entryId, entry.id, placement);
				},
			}),
		);
	});
</script>

<li
	bind:this={rowElement}
	data-queue-entry-id={entry.id}
	aria-busy={steering || deleting}
	aria-posinset={position}
	aria-setsize={count}
	class="@container/queue-row absolute inset-x-0 top-0 border-b border-border/50 px-2 py-1.5 sm:px-3"
	style:transform={`translateY(${virtualItem.start}px)`}
	class:opacity-50={dragging}
	onfocusin={() => onRetain('focus', true)}
	onfocusout={() =>
		queueMicrotask(() => {
			if (!rowElement?.contains(document.activeElement)) onRetain('focus', false);
		})}
	{@attach measurement}
>
	{#if edge}<div
			class="pointer-events-none absolute inset-x-2 h-0.5 bg-primary"
			class:top-0={edge === 'top'}
			class:bottom-0={edge === 'bottom'}
		></div>{/if}
	<div class="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 @min-[30rem]/queue-row:grid-cols-[1.5rem_minmax(0,1fr)_auto]">
		<span
			bind:this={dragHandle}
			data-queue-drag-id={entry.id}
			role="img"
			aria-label={m.chat_queue_drag_handle({ position })}
			title={m.chat_queue_drag_handle({ position })}
			class="row-span-2 flex size-6 items-center justify-center text-muted-foreground @min-[30rem]/queue-row:row-span-1"
			class:cursor-grab={!blocked}
		>
			<GripVertical class="size-3.5" />
		</span>
		<button
			type="button"
			onclick={onToggle}
			aria-expanded={expanded}
			aria-label={expanded
				? m.chat_queue_collapse_message({ position })
				: m.chat_queue_toggle_message({ position })}
			title={entry.content || attachmentNames}
			class="flex min-w-0 items-start gap-2 rounded text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span
				data-queue-preview
				class="block min-w-0 flex-1"
				class:truncate={!expanded}
				class:whitespace-pre-wrap={expanded}
				class:break-words={expanded}>{entry.content.trim() ? entry.content : attachmentNames}</span
			>
			<ChevronDown class={`mt-1 size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
		</button>
		<div class="col-start-2 flex items-center justify-end gap-1 @min-[30rem]/queue-row:col-start-3 @min-[30rem]/queue-row:row-start-1">
		{#if entry.attachments.length > 0 && !expanded}<span
				data-queue-preview-attachments
				title={attachmentNames}
				class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
				><Paperclip class="size-3.5" /><span>{entry.attachments.length}</span></span
			>{/if}
			{#if entry.kind === 'steer' && !steering}
				<span class="mr-auto inline-flex h-8 items-center gap-1.5 text-xs text-muted-foreground @min-[30rem]/queue-row:mr-1" title={m.chat_queue_pending_steer_detail()}>
					<Clock3 class="size-3.5" aria-hidden="true" />{m.chat_queue_pending_steer()}
				</span>
			{:else if canSteer || steering}
				<button
					type="button"
					onclick={() => {
						if (!steerBlocked && !steering) onSteer();
					}}
					disabled={steerBlocked}
					aria-busy={steering || undefined}
					aria-label={m.chat_queue_steer()}
					title={entry.attachments.length > 0
						? m.chat_queue_steer_attachments_unavailable()
						: m.chat_queue_steer_queue()}
					class="mr-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 @min-[30rem]/queue-row:mr-0"
				>
					{#if steering}<Loader2 class="size-3.5 animate-spin" />{:else}<CornerUpRight
							class="size-3.5"
						/>{/if}<span>{m.chat_queue_steer()}</span>
				</button>
			{/if}
			<button
				type="button"
				data-queue-edit-id={entry.id}
				onclick={() => {
					if (!blocked) onEdit();
				}}
				disabled={blocked}
				class={iconButtonClass}
				aria-label={m.chat_queue_edit_message()}
				title={m.chat_queue_edit_message()}><Pencil class="size-3.5" /></button
			>
			<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					bind:ref={menuTrigger}
					data-queue-menu-id={entry.id}
					disabled={blocked}
					class={iconButtonClass}
					aria-label={m.chat_queue_actions()}
					title={m.chat_queue_actions()}>{#if deleting}<Loader2 class="size-3.5 animate-spin" />{:else}<Ellipsis class="size-4" />{/if}</DropdownMenuTrigger
				>
				<DropdownMenuContent align="end" class="w-56" getFocusReturnTarget={() => menuTrigger}>
					{#if canInterrupt}<DropdownMenuItem
							disabled={blocked}
							onSelect={onInterrupt}
							title={m.chat_queue_interrupt_and_send_queue()}
							><FastForward class="size-4" />{m.chat_queue_interrupt_and_send()}</DropdownMenuItem
						>{/if}
					<DropdownMenuItem disabled={blocked} onSelect={onDelete} class="text-destructive focus:text-destructive">
						<Trash2 class="size-4" />{m.chat_queue_remove_from_queue()}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	</div>
	{#if expanded && entry.attachments.length > 0}<div class="mt-2 sm:pl-8">
			<QueuedInputAttachments attachments={entry.attachments} />
		</div>{/if}
</li>
