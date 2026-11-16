<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import {
		draggable,
		dropTargetForElements,
	} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
	import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
	import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import {
		getSidebarChatDragData,
		getSidebarChatDropTargetData,
		isSidebarChatDragData,
		sidebarDragCanReorder,
	} from './sidebar-pragmatic-dnd';
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
		sidebarChatInset,
		type SidebarVirtualChatRow,
	} from '../../sidebar/display/sidebar-virtual-chat-list';
	import type { SidebarDisplayOptions } from '../../sidebar/display/sidebar-display-options';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarVirtualSortableChatRowProps {
		onToggleBranch?: (key: string) => void;
		row: SidebarVirtualChatRow;
		index: number;
		instanceId: symbol;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: boolean;
		displayOptions: SidebarDisplayOptions;
		// The row can always be dragged to workspace windows when dragEnabled;
		// reorderEnabled additionally allows it as a sidebar reorder target.
		dragEnabled?: boolean;
		reorderEnabled?: boolean;
		isDragging?: boolean;
		onDragStart: (row: SidebarVirtualChatRow) => void;
		onDragSourceUnmount: (chatId: string) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		isArchiveMutationPending?: boolean;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onMoveUp?: () => void;
		onMoveDown?: () => void;
		moveBoundaryLabels?: { first: string; last: string };
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onDragUpdate: (sourceData: unknown, dropTargets: DropTargetRecord[], input: Input) => void;
		onDropOnRow: (sourceData: unknown, dropTargets: DropTargetRecord[], input: Input) => void;
	}

	let {
		onToggleBranch,
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
		reorderEnabled = true,
		isDragging = false,
		onDragStart,
		onDragSourceUnmount,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		isArchiveMutationPending = false,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onMoveUp,
		onMoveDown,
		moveBoundaryLabels,
		onMoveToTop,
		onMoveToBottom,
		onSortChatOrder,
		onOpenInNewWindow,
		newWindowEdges,
		onDragUpdate,
		onDropOnRow,
	}: SidebarVirtualSortableChatRowProps = $props();

	let rowEl = $state<HTMLElement | null>(null);
	let isActiveChat = $derived(
		!isMultiSelectMode &&
			(selectedChatId === row.chat.id ||
				Boolean(
					selectedChatId && row.branch?.isCollapsed && row.branch.containsChat(selectedChatId),
				)),
	);

	onMount(() => {
		if (!rowEl) return;
		const mountedChatId = row.chat.id;
		const cleanupDragAndDrop = combine(
			draggable({
				element: rowEl,
				canDrag: ({ input }) =>
					dragEnabled &&
					!isMobile &&
					!document
						.elementFromPoint(input.clientX, input.clientY)
						?.closest('[data-sidebar-touch-drag-ignore]'),
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
					if (!reorderEnabled || !isSidebarChatDragData(source.data)) return false;
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

		return () => {
			cleanupDragAndDrop();
			onDragSourceUnmount(mountedChatId);
		};
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
	data-sidebar-row-depth={row.depth}
	data-sidebar-virtual-list-row={row.list}
	data-sidebar-virtual-reorder-scope={row.reorderScopeKey}
	data-sidebar-drag-disabled={!dragEnabled ? 'true' : undefined}
>
	<div
		class={cn(
			'flex items-stretch overflow-hidden',
			isActiveChat ? 'bg-sidebar-chat-item-selected-bg' : 'bg-sidebar-chat-item-bg',
		)}
		style={`height:${
			displayOptions.chatItemLayout === 'single-line'
				? '100%'
				: `calc(100% - ${CHAT_ROW_SEPARATOR_SLOT_HEIGHT}px)`
		};`}
		data-sidebar-virtual-row-content
	>
		<div class="min-w-0 flex-1">
			<svelte:boundary>
				<SidebarChatItem
					session={row.chat}
					{selectedChatId}
					containsSelectedChat={isActiveChat && selectedChatId !== row.chat.id}
					{currentTime}
					{isMobile}
					isPinned={row.isPinned}
					isArchived={row.isArchived}
					{displayOptions}
					depth={row.depth}
					branch={row.branch}
					onToggleDelegatedChats={row.branch && onToggleBranch
						? () => onToggleBranch?.(row.branch!.collapseKey)
						: undefined}
					contextOnly={row.contextOnly}
					executorGrouped={row.executorGrouped}
					inArchivedSection={row.section === 'archived'}
					{isMultiSelectMode}
					{isMultiSelected}
					enableNativeDrag={false}
					enableRecenterOnRequest={false}
					{onChatSelect}
					{onDeleteChat}
					{onStartRenameChat}
					{onTogglePinned}
					{onToggleArchive}
					{isArchiveMutationPending}
					{onShowDetails}
					{onForkChat}
					{onShareChat}
					{onTagClick}
					{onManageTags}
					{onEnterMultiSelect}
					{onMultiSelectToggle}
					{onMoveUp}
					{onMoveDown}
					{moveBoundaryLabels}
					{onMoveToTop}
					{onMoveToBottom}
					{onSortChatOrder}
					{onOpenInNewWindow}
					{newWindowEdges}
				/>
				{#snippet failed()}
					<div
						class="flex h-full items-center pr-3 text-sm text-muted-foreground"
						style={`padding-left:${sidebarChatInset(row.depth)}px;`}
						data-sidebar-virtual-row-error={row.chat.id}
					>
						{row.chat.title || m.sidebar_chats_unnamed()}
					</div>
				{/snippet}
			</svelte:boundary>
		</div>
	</div>
</div>
