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
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
		type SidebarVirtualChatRow,
	} from './sidebar-virtual-chat-list';
	import type { SidebarDisplayOptions } from './sidebar-display-options';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarVirtualSortableChatRowProps {
		row: SidebarVirtualChatRow;
		index: number;
		instanceId: symbol;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: boolean;
		displayOptions: SidebarDisplayOptions;
		dragEnabled?: boolean;
		isDragging?: boolean;
		dropIndicatorEdge?: Edge | null;
		onDragStart: (row: SidebarVirtualChatRow) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
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
		displayOptions,
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
	let isActiveChat = $derived(!isMultiSelectMode && selectedChatId === row.chat.id);

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
						reorderScopeKey: row.reorderScopeKey,
					}),
				getInitialDataForExternal: () => ({ 'text/plain': row.chat.id }),
				onDragStart: () => onDragStart(row),
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
						reorderScopeKey: row.reorderScopeKey,
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
							reorderScopeKey: row.reorderScopeKey,
						}),
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
		'relative h-full overflow-hidden transition-opacity',
		isActiveChat && 'bg-sidebar-chat-item-selected-bg',
		dragEnabled && 'cursor-grab active:cursor-grabbing',
		isMobile && 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]',
		isDragging && 'opacity-45',
	)}
	data-sidebar-virtual-row={row.chat.id}
	data-sidebar-virtual-list-row={row.list}
	data-sidebar-virtual-reorder-scope={row.reorderScopeKey}
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

	<div
		class={cn(
			'overflow-hidden',
			isActiveChat ? 'bg-sidebar-chat-item-selected-bg' : 'bg-sidebar-chat-item-bg',
		)}
		style={`height:calc(100% - ${CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px);`}
		data-sidebar-virtual-row-content
	>
		<svelte:boundary>
			<SidebarChatItem
				session={row.chat}
				{selectedChatId}
				{currentTime}
				{isMobile}
				isPinned={row.isPinned}
				isArchived={row.isArchived}
				{displayOptions}
				showProjectPathInGroup={row.showProjectPathInGroup}
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
					class="flex h-full items-center px-3 text-sm text-muted-foreground"
					data-sidebar-virtual-row-error={row.chat.id}
				>
					{row.chat.title || m.sidebar_chats_unnamed()}
				</div>
			{/snippet}
		</svelte:boundary>
	</div>
</div>
