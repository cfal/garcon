<script lang="ts">
	import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import Activity from '@lucide/svelte/icons/activity';
	import { cn } from '$lib/utils/cn';
	import type {
		ChatBoardLaneProjection,
		ChatBoardOccurrence,
	} from '$lib/chat-board/projection/chat-board-projection.js';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import * as m from '$lib/paraglide/messages.js';
	import { CHAT_BOARD_COLUMN_DROP_TYPE, isChatBoardCardDragData } from './chat-board-dnd.js';
	import ChatBoardLaneList from './ChatBoardLaneList.svelte';

	let {
		lane,
		boardId,
		instanceId,
		layout,
		canDrag,
		narrow,
		isDropTarget,
		pendingChatIds,
		recoveryChatIds,
		canTransition,
		onOpen,
		onTransition,
		onRegisterScroller,
	}: {
		lane: ChatBoardLaneProjection;
		boardId: string;
		instanceId: string;
		layout: ChatItemLayout;
		canDrag: boolean;
		narrow: boolean;
		isDropTarget: boolean;
		pendingChatIds: ReadonlySet<string>;
		recoveryChatIds: ReadonlySet<string>;
		canTransition: boolean;
		onOpen: (chatId: string) => void;
		onTransition: (occurrence: ChatBoardOccurrence) => void;
		onRegisterScroller?: (columnId: string, scroll: ((key: string) => void) | null) => void;
	} = $props();

	let laneRef = $state<HTMLElement | null>(null);
	let rule = $derived(
		lane.column.match === 'all'
			? m.chat_board_rule_all({ tags: lane.column.tags.join(', ') })
			: m.chat_board_rule_any({ tags: lane.column.tags.join(', ') }),
	);

	$effect(() => {
		if (!canDrag || !laneRef) return;
		return dropTargetForElements({
			element: laneRef,
			getData: () => ({
				type: CHAT_BOARD_COLUMN_DROP_TYPE,
				instanceId,
				boardId,
				columnId: lane.column.id,
			}),
			canDrop: ({ source }) => {
				if (!isChatBoardCardDragData(source.data)) return false;
				return (
					source.data.instanceId === instanceId &&
					source.data.boardId === boardId &&
					source.data.sourceColumnId !== lane.column.id
				);
			},
			getIsSticky: () => true,
		});
	});
</script>

<section
	bind:this={laneRef}
	class={cn(
		'flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[10px] border border-chat-board-lane-border bg-chat-board-lane transition-[border-color,background-color,box-shadow] duration-150',
		narrow
			? 'w-full'
			: layout === 'single-line'
				? 'w-[clamp(280px,30vw,340px)]'
				: layout === 'compact'
					? 'w-[clamp(304px,32vw,368px)]'
					: 'w-[clamp(336px,36vw,416px)]',
		isDropTarget && 'border-ring bg-chat-board-drop shadow-[0_0_0_2px_hsl(var(--ring))]',
	)}
	aria-labelledby={`chat-board-column-${lane.column.id}`}
	data-chat-board-column-id={lane.column.id}
	data-chat-board-drop-target={isDropTarget ? '' : undefined}
>
	<header
		class="z-10 shrink-0 border-b border-chat-board-lane-border bg-chat-board-lane/95 px-3 py-2.5 backdrop-blur"
	>
		<div class="flex min-w-0 items-center gap-2">
			<h2
				id={`chat-board-column-${lane.column.id}`}
				class="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
				tabindex="-1"
				data-chat-board-lane-heading={lane.column.id}
			>
				{lane.column.name}
			</h2>
			<span
				class="rounded-full border border-border/80 bg-background/80 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
			>
				{lane.occurrences.length}
			</span>
			{#if lane.processingCount > 0}
				<span
					class="inline-flex items-center gap-1 rounded-full border border-status-processing-border/50 bg-status-processing/10 px-1.5 py-0.5 text-[10px] font-medium text-status-processing-foreground"
					title={m.chat_board_processing_count({ count: lane.processingCount })}
				>
					<Activity class="size-3" aria-hidden="true" />
					{lane.processingCount}
				</span>
			{/if}
		</div>
		<p class="mt-1 truncate text-[10px] text-foreground/70" title={rule}>{rule}</p>
		{#if isDropTarget}
			<p class="mt-1 text-[11px] font-medium text-foreground">
				{m.chat_board_transition_to({ column: lane.column.name })}
			</p>
		{/if}
	</header>

	<ChatBoardLaneList
		columnId={lane.column.id}
		{boardId}
		{instanceId}
		occurrences={lane.occurrences}
		{layout}
		{canDrag}
		{pendingChatIds}
		{recoveryChatIds}
		{canTransition}
		{onOpen}
		{onTransition}
		{onRegisterScroller}
	/>
</section>
