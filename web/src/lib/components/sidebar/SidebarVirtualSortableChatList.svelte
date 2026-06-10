<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		createVirtualizer,
		observeElementRect,
		type Rect,
		type Virtualizer,
	} from '@tanstack/svelte-virtual';
	import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import { extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import { getAppShell, getSplitLayout } from '$lib/context';
	import SidebarVirtualSortableChatRow from './SidebarVirtualSortableChatRow.svelte';
	import {
		DEFAULT_CHAT_ROW_OVERSCAN,
		DESKTOP_CHAT_ROW_HEIGHT,
		MOBILE_CHAT_ROW_HEIGHT,
		type SidebarVirtualChatRow,
	} from './sidebar-virtual-chat-list';
	import {
		SidebarChatReorderState,
		type SidebarChatReorderRequest,
	} from './sidebar-chat-reorder-state.svelte';
	import {
		isSidebarChatDragData,
		isSidebarChatDropTargetData,
		sidebarDragCanReorder,
	} from './sidebar-pragmatic-dnd';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import type { DropTargetRecord } from '@atlaskit/pragmatic-drag-and-drop/types';
	import type { SessionAgentId } from '$lib/types/app';

	interface SidebarVirtualSortableChatListProps {
		rows: SidebarVirtualChatRow[];
		viewportRef: HTMLElement | null;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isFiltered: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		rowHeight?: number;
		overscan?: number;
		reorder: SidebarChatReorderState;
		onPersistReorder: (request: SidebarChatReorderRequest | null) => void;
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
	}

	let {
		rows,
		viewportRef,
		selectedChatId,
		currentTime,
		isMobile,
		isFiltered,
		isMultiSelectMode = false,
		isMultiSelected,
		rowHeight,
		overscan = DEFAULT_CHAT_ROW_OVERSCAN,
		reorder,
		onPersistReorder,
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
		hasPinnedChats = false,
	}: SidebarVirtualSortableChatListProps = $props();

	const appShell = getAppShell();
	const splitLayout = getSplitLayout();
	const instanceId = Symbol('sidebar-chat-list');
	const desktopBottomPadding = 16;
	const mobileBottomPadding = 112;
	const fallbackViewportHeight = 640;

	let activeDrop = $state<{ chatId: string; edge: Edge | null } | null>(null);
	let draggingChatId = $state<string | null>(null);
	let effectiveRowHeight = $derived(
		rowHeight ?? (isMobile ? MOBILE_CHAT_ROW_HEIGHT : DESKTOP_CHAT_ROW_HEIGHT)
	);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	let dragEnabled = $derived(!isMultiSelectMode);

	function withFallbackRect(rect: Rect): Rect {
		return rect.height > 0 ? rect : { ...rect, height: fallbackViewportHeight };
	}

	function observeSidebarElementRect(
		instance: Virtualizer<HTMLElement, HTMLElement>,
		callback: (rect: Rect) => void,
	) {
		return observeElementRect(instance, (rect) => {
			callback(withFallbackRect(rect));
		});
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		estimateSize: () => effectiveRowHeight,
		observeElementRect: observeSidebarElementRect,
		initialRect: { width: 0, height: fallbackViewportHeight },
		overscan: 0,
		paddingEnd: 0,
	});
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());

	$effect(() => {
		const count = rows.length;
		const scrollElement = viewportRef;
		const estimateSize = effectiveRowHeight;
		const rowOverscan = overscan;
		const paddingEnd = bottomPadding;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: () => estimateSize,
				observeElementRect: observeSidebarElementRect,
				initialRect: { width: 0, height: fallbackViewportHeight },
				overscan: rowOverscan,
				paddingEnd,
			});
		});
	});

	$effect(() => {
		if (!viewportRef) return;
		const rowCount = rows.length;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		const frame = requestAnimationFrame(() => {
			if (!viewportRef || rowCount === 0 || viewportRef.scrollHeight <= viewportRef.clientHeight) return;
			void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then((module) => {
				if (disposed || !viewportRef || rowCount === 0 || viewportRef.scrollHeight <= viewportRef.clientHeight) {
					return;
				}
				cleanup = module.autoScrollForElements({
					element: viewportRef,
					canScroll: ({ source }) => dragEnabled && isSidebarChatDragData(source.data),
					getAllowedAxis: () => 'vertical',
				});
			});
		});
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			cleanup?.();
		};
	});

	function sidebarTargetFrom(dropTargets: DropTargetRecord[]): DropTargetRecord | null {
		for (const target of dropTargets) {
			if (isSidebarChatDropTargetData(target.data)) return target;
		}
		return null;
	}

	function startSidebarDrag(list: ChatOrderList, chatId: string): void {
		if (!dragEnabled) return;
		draggingChatId = chatId;
		activeDrop = null;
		reorder.begin(list, chatId);
		splitLayout.startDrag(chatId);
	}

	function previewSidebarDrop(
		sourceData: unknown,
		dropTargets: DropTargetRecord[],
	): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		const targetRecord = sidebarTargetFrom(dropTargets);
		const targetData = targetRecord?.data;
		if (!targetRecord || !isSidebarChatDropTargetData(targetData)) {
			activeDrop = null;
			return;
		}
		if (!sidebarDragCanReorder(sourceData, targetData)) {
			activeDrop = null;
			return;
		}

		const closestEdge = extractClosestEdge(targetRecord.data);
		activeDrop = { chatId: targetData.chatId, edge: closestEdge };
		reorder.preview({
			list: sourceData.list,
			sourceChatId: sourceData.chatId,
			targetChatId: targetData.chatId,
			closestEdge,
		});
	}

	function finishSidebarDrop(sourceData: unknown, dropTargets: DropTargetRecord[]): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		const targetRecord = sidebarTargetFrom(dropTargets);
		const targetData = targetRecord?.data;
		if (targetRecord && isSidebarChatDropTargetData(targetData) && sidebarDragCanReorder(sourceData, targetData)) {
			previewSidebarDrop(sourceData, dropTargets);
			onPersistReorder(reorder.finish(sourceData.list));
		} else {
			reorder.cancel(sourceData.list);
		}

		activeDrop = null;
		draggingChatId = null;
		setTimeout(() => {
			if (splitLayout.draggedChatId === sourceData.chatId) {
				splitLayout.endDrag();
			}
		}, 0);
	}

	function scrollChatIntoView(chatId: string | null): void {
		if (!chatId) return;
		const index = rows.findIndex((row) => row.chat.id === chatId);
		if (index < 0) return;
		untrack(() => {
			$virtualizer.scrollToIndex(index, { align: 'center' });
		});
		if (viewportRef) {
			viewportRef.scrollTop = Math.max(
				0,
				index * effectiveRowHeight - fallbackViewportHeight * 0.5,
			);
		}
	}

	function moveToBoundary(row: SidebarVirtualChatRow, boundary: 'start' | 'end'): void {
		onPersistReorder(reorder.moveToBoundary({
			list: row.list,
			chatId: row.chat.id,
			boundary,
		}));
	}

	function getMoveToTop(row: SidebarVirtualChatRow): (() => void) | undefined {
		if (isMultiSelectMode) return undefined;
		const order = reorder.orderFor(row.list);
		const index = order.indexOf(row.chat.id);
		if (index <= 0) return undefined;
		return () => moveToBoundary(row, 'start');
	}

	function getMoveToBottom(row: SidebarVirtualChatRow): (() => void) | undefined {
		if (isMultiSelectMode) return undefined;
		const order = reorder.orderFor(row.list);
		const index = order.indexOf(row.chat.id);
		if (index < 0 || index >= order.length - 1) return undefined;
		return () => moveToBoundary(row, 'end');
	}

	onMount(() => appShell.onSidebarRecenterRequested(() => {
		scrollChatIntoView(selectedChatId);
	}));

	onMount(() => monitorForElements({
		canMonitor: ({ source }) => (
			isSidebarChatDragData(source.data) && source.data.instanceId === instanceId
		),
		onDrag: ({ source, location }) => {
			previewSidebarDrop(source.data, location.current.dropTargets);
		},
		onDropTargetChange: ({ source, location }) => {
			previewSidebarDrop(source.data, location.current.dropTargets);
		},
		onDrop: ({ source, location }) => {
			finishSidebarDrop(source.data, location.current.dropTargets);
		},
	}));
</script>

<div
	class="relative min-h-full"
	style={`height:${totalHeight}px;`}
	data-sidebar-virtual-list
	data-sidebar-filtered={isFiltered ? 'true' : 'false'}
>
	{#each virtualItems as virtualItem (rows[virtualItem.index]?.key ?? virtualItem.key)}
		{@const row = rows[virtualItem.index]}
		{#if row}
			<div
				class="absolute left-0 right-0 top-0"
				style={`height:${virtualItem.size}px; transform:translateY(${virtualItem.start}px);`}
			>
				<SidebarVirtualSortableChatRow
					{row}
					index={virtualItem.index}
					{instanceId}
					{selectedChatId}
					{currentTime}
					{isMobile}
					{isMultiSelectMode}
					isMultiSelected={isMultiSelected?.(row.chat.id) ?? false}
					dragEnabled={dragEnabled}
					isDragging={draggingChatId === row.chat.id}
					dropIndicatorEdge={activeDrop?.chatId === row.chat.id ? activeDrop.edge : null}
					onDragStart={startSidebarDrag}
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
					onMoveToTop={getMoveToTop(row)}
					onMoveToBottom={getMoveToBottom(row)}
					{hasPinnedChats}
				/>
			</div>
		{/if}
	{/each}
</div>
