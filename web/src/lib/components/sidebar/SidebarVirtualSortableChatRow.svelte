<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
	import {
		draggable,
		dropTargetForElements,
	} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import {
		attachClosestEdge,
		type Edge,
	} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import {
		getSidebarChatDragData,
		getSidebarChatDropTargetData,
		isSidebarChatDragData,
		sidebarDragCanReorder,
	} from './sidebar-pragmatic-dnd';
	import type { SidebarVirtualChatRow } from './sidebar-virtual-chat-list';
	import type { SessionAgentId } from '$lib/types/app';

	interface SidebarVirtualSortableChatRowProps {
		row: SidebarVirtualChatRow;
		index: number;
		instanceId: symbol;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: boolean;
		dragEnabled?: boolean;
		isDragging?: boolean;
		dropIndicatorEdge?: Edge | null;
		onDragStart: (list: SidebarVirtualChatRow['list'], chatId: string) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, chatTitle: string, agentId: SessionAgentId) => void;
		onStartRenameChat: (chatId: string, currentName: string) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chatId: string, chatTitle: string) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		hasPinnedChats?: boolean;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onDragUpdate: (sourceData: unknown, dropTargets: DropTargetRecord[], input: Input) => void;
		onDropOnRow: (sourceData: unknown, dropTargets: DropTargetRecord[], input: Input) => void;
	}

	let {
		row,
		index,
		instanceId,
		selectedChatId,
		currentTime,
		isMobile,
		isMultiSelectMode = false,
		isMultiSelected = false,
		dragEnabled = true,
		isDragging = false,
		dropIndicatorEdge = null,
		onDragStart,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onMoveToTop,
		onMoveToBottom,
		onDragUpdate,
		onDropOnRow,
		hasPinnedChats = false,
	}: SidebarVirtualSortableChatRowProps = $props();

	let rowEl = $state<HTMLElement | null>(null);

	onMount(() => {
		if (!rowEl) return;
		return combine(
			draggable({
				element: rowEl,
				canDrag: () => dragEnabled && !isMobile,
				getInitialData: () =>
					getSidebarChatDragData({
						chatId: row.chat.id,
						list: row.list,
						index,
						instanceId,
					}) as unknown as Record<string, unknown>,
				getInitialDataForExternal: () => ({ 'text/plain': row.chat.id }),
				onDragStart: () => onDragStart(row.list, row.chat.id),
			}),
			dropTargetForElements({
				element: rowEl,
				canDrop: ({ source }) => {
					if (!dragEnabled || !isSidebarChatDragData(source.data)) return false;
					const target = getSidebarChatDropTargetData({
						chatId: row.chat.id,
						list: row.list,
						index,
						instanceId,
					});
					return sidebarDragCanReorder(source.data, target);
				},
				getData: ({ input, element }) =>
					attachClosestEdge(
						getSidebarChatDropTargetData({
							chatId: row.chat.id,
							list: row.list,
							index,
							instanceId,
						}) as unknown as Record<string | symbol, unknown>,
						{ element, input, allowedEdges: ['top', 'bottom'] },
					),
				getDropEffect: () => 'move',
				getIsSticky: () => true,
				onDrag: ({ source, location }) => {
					onDragUpdate(source.data, location.current.dropTargets, location.current.input);
				},
				onDropTargetChange: ({ source, location }) => {
					onDragUpdate(source.data, location.current.dropTargets, location.current.input);
				},
				onDrop: ({ source, location }) => {
					onDropOnRow(source.data, location.current.dropTargets, location.current.input);
				},
			}),
		);
	});
</script>

<div
	bind:this={rowEl}
	class={cn(
		'relative h-full overflow-hidden bg-sidebar-chat-item-bg transition-opacity',
		dragEnabled && 'cursor-grab active:cursor-grabbing',
		isMobile && 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]',
		isDragging && 'opacity-45',
	)}
	data-sidebar-virtual-row={row.chat.id}
	data-sidebar-virtual-list-row={row.list}
	data-sidebar-drag-disabled={!dragEnabled ? 'true' : undefined}
>
	{#if dropIndicatorEdge === 'top'}
		<div
			class="pointer-events-none absolute left-2 right-2 top-0 z-20 h-0.5 rounded-full bg-primary"
		></div>
	{:else if dropIndicatorEdge === 'bottom'}
		<div
			class="pointer-events-none absolute bottom-0 left-2 right-2 z-20 h-0.5 rounded-full bg-primary"
		></div>
	{/if}

	<svelte:boundary>
		<SidebarChatItem
			session={row.chat}
			{selectedChatId}
			{currentTime}
			{isMobile}
			isPinned={row.isPinned}
			isArchived={row.isArchived}
			{isMultiSelectMode}
			{isMultiSelected}
			enableNativeDrag={false}
			enableRecenterOnRequest={false}
			{onChatSelect}
			{onDeleteChat}
			{onStartRenameChat}
			{onTogglePinned}
			{onToggleArchive}
			{onShowDetails}
			{onForkChat}
			{onShareChat}
			{onTagClick}
			{onManageTags}
			{onEnterMultiSelect}
			{onMultiSelectToggle}
			{onMoveToTop}
			{onMoveToBottom}
			{hasPinnedChats}
		/>
		{#snippet failed()}
			<div
				class="flex h-full items-center border-b border-border/30 px-3 text-sm text-muted-foreground"
				data-sidebar-virtual-row-error={row.chat.id}
			>
				{row.chat.title || m.sidebar_chats_unnamed()}
			</div>
		{/snippet}
	</svelte:boundary>
</div>
