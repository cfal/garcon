<script lang="ts">
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
	import FastForward from '@lucide/svelte/icons/fast-forward';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Route from '@lucide/svelte/icons/route';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	interface Props {
		chatId: string;
		entry: QueueEntry;
		position: number;
		expanded: boolean;
		expansionRevision: number;
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
		expanded,
		expansionRevision,
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
	let expansionOverride = $state<{ revision: number; expanded: boolean } | null>(null);
	let dragging = $state(false);
	let edge = $state<Edge | null>(null);
	const messageExpanded = $derived(
		expansionOverride?.revision === expansionRevision ? expansionOverride.expanded : expanded,
	);
	const attachmentNames = $derived(
		entry.attachments.map((attachment) => attachment.name).join(', '),
	);
	const steerBlocked = $derived(blocked || entry.attachments.length > 0);
	const iconButtonClass =
		'grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

	$effect(() => {
		if (!rowElement || !dragHandle || blocked) return;
		const operationChatId = chatId;
		return combine(
			draggable({
				element: rowElement,
				dragHandle,
				getInitialData: () => ({ ...queuedInputDragData(entry.id), chatId: operationChatId }),
				canDrag: () => !blocked && !menuOpen,
				onDragStart: () => (dragging = true),
				onDrop: () => (dragging = false),
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
	class="relative px-2 py-1.5 sm:px-3"
	class:opacity-50={dragging}
>
	{#if edge}<div
			class="pointer-events-none absolute inset-x-2 h-0.5 bg-primary"
			class:top-0={edge === 'top'}
			class:bottom-0={edge === 'bottom'}
		></div>{/if}
	<div class="flex items-center gap-1 sm:gap-2">
		<span
			bind:this={dragHandle}
			data-queue-drag-id={entry.id}
			role="img"
			aria-label={m.chat_queue_drag_handle({ position })}
			title={m.chat_queue_drag_handle({ position })}
			class="flex size-6 shrink-0 items-center justify-center text-muted-foreground"
			class:cursor-grab={!blocked}
		>
			<GripVertical class="size-3.5" />
		</span>
		<button
			type="button"
			onclick={() =>
				(expansionOverride = { revision: expansionRevision, expanded: !messageExpanded })}
			aria-expanded={messageExpanded}
			aria-label={m.chat_queue_toggle_message({ position })}
			title={entry.content || attachmentNames}
			class="min-w-0 flex-1 rounded text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span
				data-queue-preview
				class="block"
				class:truncate={!messageExpanded}
				class:whitespace-pre-wrap={messageExpanded}
				class:break-words={messageExpanded}
				>{entry.content.trim() ? entry.content : attachmentNames}</span
			>
		</button>
		{#if entry.attachments.length > 0 && !messageExpanded}<span
				data-queue-preview-attachments
				title={attachmentNames}
				class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
				><Paperclip class="size-3.5" /><span>{entry.attachments.length}</span></span
			>{/if}
		<div class="flex shrink-0 items-center gap-0.5">
			{#if canSteer || steering}
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
					class="inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
				>
					{#if steering}<Loader2 class="size-3.5 animate-spin" />{:else}<Route
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
			<button
				type="button"
				onclick={() => {
					if (!blocked) onDelete();
				}}
				disabled={blocked}
				class={iconButtonClass}
				aria-label={m.chat_queue_remove_from_queue()}
				title={m.chat_queue_remove_from_queue()}
				>{#if deleting}<Loader2 class="size-3.5 animate-spin" />{:else}<Trash2
						class="size-3.5"
					/>{/if}</button
			>
			<DropdownMenu bind:open={menuOpen}>
				<DropdownMenuTrigger
					bind:ref={menuTrigger}
					data-queue-menu-id={entry.id}
					disabled={blocked}
					class={iconButtonClass}
					aria-label={m.chat_queue_actions()}
					title={m.chat_queue_actions()}><Ellipsis class="size-4" /></DropdownMenuTrigger
				>
				<DropdownMenuContent align="end" class="w-56" getFocusReturnTarget={() => menuTrigger}>
					<DropdownMenuItem disabled={blocked} onSelect={onEdit}
						><Pencil class="size-4" />{m.chat_queue_edit_message()}</DropdownMenuItem
					>
					{#if canInterrupt}<DropdownMenuItem
							disabled={blocked}
							onSelect={onInterrupt}
							title={m.chat_queue_interrupt_and_send_queue()}
							><FastForward class="size-4" />{m.chat_queue_interrupt_and_send()}</DropdownMenuItem
						>{/if}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	</div>
	{#if messageExpanded && entry.attachments.length > 0}<div class="mt-2 sm:pl-8">
			<QueuedInputAttachments attachments={entry.attachments} />
		</div>{/if}
	{#if entry.kind === 'steer' && !steering}<p
			class="px-1 pt-1 text-xs text-muted-foreground sm:pl-8"
			title={m.chat_queue_pending_steer_detail()}
		>
			{m.chat_queue_pending_steer()}
		</p>{/if}
</li>
