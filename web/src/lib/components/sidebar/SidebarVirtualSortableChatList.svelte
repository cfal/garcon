<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		createVirtualizer,
		observeElementRect,
		type Rect,
		type Virtualizer,
	} from '@tanstack/svelte-virtual';
	import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import { getAppShell, getSplitLayout } from '$lib/context';
	import SidebarProjectHeaderRow from './SidebarProjectHeaderRow.svelte';
	import SidebarVirtualSortableChatRow from './SidebarVirtualSortableChatRow.svelte';
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
		DEFAULT_CHAT_ROW_OVERSCAN,
		estimateSidebarVirtualRowSize,
		PROJECT_HEADER_ROW_HEIGHT,
		type SidebarVirtualChatRow,
		type SidebarVirtualRow,
	} from './sidebar-virtual-chat-list';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from './sidebar-display-options';
	import {
		SidebarChatReorderState,
		type SidebarChatReorderRequest,
	} from './sidebar-chat-reorder-state.svelte';
	import {
		getSidebarChatDragData,
		getSidebarChatDropTargetData,
		isSidebarChatDragData,
		resolveSidebarDropInstruction,
		resolveSidebarDropInstructionForTarget,
		type SidebarChatDragData,
		type SidebarDropInstruction,
	} from './sidebar-pragmatic-dnd';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
	import type { SessionAgentId } from '$lib/types/app';

	interface SidebarVirtualSortableChatListProps {
		rows: SidebarVirtualRow[];
		viewportRef: HTMLElement | null;
		selectedChatId: string | null;
		currentTime: Date;
		isMobile: boolean;
		isFiltered: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		displayOptions?: SidebarDisplayOptions;
		rowHeight?: number;
		overscan?: number;
		reorder: SidebarChatReorderState;
		onPersistReorder: (request: SidebarChatReorderRequest) => void;
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
		onToggleProjectCollapsed?: (projectKey: string) => void;
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
		displayOptions = DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
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
		onToggleProjectCollapsed,
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
	const touchLongPressMs = 360;
	const touchMoveCancelThresholdPx = 10;
	const touchAutoScrollEdgePx = 56;
	const touchAutoScrollMaxPx = 18;

	let activeDrop = $state<{ chatId: string; edge: Edge | null } | null>(null);
	let draggingChatId = $state<string | null>(null);
	let listEl = $state<HTMLElement | null>(null);
	let lastValidDrop: SidebarDropInstruction | null = null;
	let touchDrag: {
		identifier: number;
		sourceChatId: string;
		sourceList: ChatOrderList;
		sourceScopeKey: string;
		startX: number;
		startY: number;
		currentX: number;
		currentY: number;
		timer: ReturnType<typeof setTimeout>;
		activated: boolean;
	} | null = null;
	let touchAutoScrollFrame: number | null = null;
	let suppressTouchClickUntil = 0;
	let touchSelectionGuard: {
		body: Record<string, string>;
		documentElement: Record<string, string>;
	} | null = null;
	let separatorPixelRatio = $state(1);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	// Manual drag/quick-move only applies to the manual sort order; the
	// recent-activity sort is derived, so reordering is disabled there.
	let dragEnabled = $derived(!isMultiSelectMode && displayOptions.sortMode === 'manual');
	let separatorLineHeight = $derived(1 / Math.max(separatorPixelRatio, 1));

	type SidebarPointDropContext =
		| { kind: 'outside' }
		| { kind: 'empty' }
		| { kind: 'source-row' }
		| { kind: 'compatible-row'; instruction: SidebarDropInstruction }
		| { kind: 'blocked-row' }
		| { kind: 'blocked-item' };

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function snapCssPixel(value: number, pixelRatio: number): number {
		const ratio = Math.max(pixelRatio, 1);
		return Math.round(value * ratio) / ratio;
	}

	function syncSeparatorPixelRatio(): void {
		separatorPixelRatio = window.devicePixelRatio || 1;
	}

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

	function estimateRowSize(row: SidebarVirtualRow | undefined): number {
		if (row?.type === 'project-header') return PROJECT_HEADER_ROW_HEIGHT;
		if (rowHeight !== undefined) return rowHeight;
		return estimateSidebarVirtualRowSize(row, displayOptions.compactChatItems);
	}

	const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
		count: 0,
		getScrollElement: () => viewportRef,
		getItemKey: (index) => rows[index]?.key ?? index,
		estimateSize: (index) => estimateRowSize(rows[index]),
		observeElementRect: observeSidebarElementRect,
		initialRect: { width: 0, height: fallbackViewportHeight },
		overscan: 0,
		paddingEnd: 0,
	});
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let totalHeight = $derived($virtualizer.getTotalSize());
	let separatorItems = $derived.by(() =>
		virtualItems
			.filter((virtualItem) => rows[virtualItem.index]?.type === 'chat')
			.map((virtualItem) => {
				const slotStart = virtualItem.start + virtualItem.size - CHAT_ROW_SEPARATOR_SLOT_HEIGHT;
				const slotEnd = virtualItem.start + virtualItem.size;
				const preferredTop = slotStart + (CHAT_ROW_SEPARATOR_SLOT_HEIGHT - separatorLineHeight) / 2;
				const top = clamp(
					snapCssPixel(preferredTop, separatorPixelRatio),
					slotStart,
					slotEnd - separatorLineHeight,
				);
				return {
					key: rows[virtualItem.index]?.key ?? virtualItem.key,
					top,
					height: separatorLineHeight,
				};
			}),
	);
	let selectedBackgroundItem = $derived.by(() => {
		if (isMultiSelectMode || !selectedChatId) return null;

		for (const virtualItem of virtualItems) {
			const row = rows[virtualItem.index];
			if (!row || row.type !== 'chat' || row.chat.id !== selectedChatId) continue;

			const top =
				virtualItem.start > 0 ? virtualItem.start - CHAT_ROW_SEPARATOR_SLOT_HEIGHT : virtualItem.start;
			return {
				key: row.key ?? virtualItem.key,
				top,
				height: virtualItem.start + virtualItem.size - top,
			};
		}

		return null;
	});

	$effect(() => {
		const count = rows.length;
		const scrollElement = viewportRef;
		const compactChatItems = displayOptions.compactChatItems;
		const explicitRowHeight = rowHeight;
		const rowOverscan = overscan;
		const paddingEnd = bottomPadding;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				getItemKey: (index) => rows[index]?.key ?? index,
				estimateSize: (index) => {
					const row = rows[index];
					if (row?.type === 'project-header') return PROJECT_HEADER_ROW_HEIGHT;
					if (explicitRowHeight !== undefined) return explicitRowHeight;
					return estimateSidebarVirtualRowSize(row, compactChatItems);
				},
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
			if (!viewportRef || rowCount === 0 || viewportRef.scrollHeight <= viewportRef.clientHeight)
				return;
			void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then((module) => {
				if (
					disposed ||
					!viewportRef ||
					rowCount === 0 ||
					viewportRef.scrollHeight <= viewportRef.clientHeight
				) {
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

	function startSidebarDrag(row: SidebarVirtualChatRow): void {
		if (!dragEnabled) return;
		draggingChatId = row.chat.id;
		activeDrop = null;
		lastValidDrop = null;
		reorder.begin(row.list, row.chat.id, { ids: row.reorderScopeIds });
		splitLayout.startDrag(row.chat.id);
	}

	function pointIsInsideViewport(clientX: number, clientY: number): boolean {
		if (!viewportRef) return false;
		const rect = viewportRef.getBoundingClientRect();
		return (
			clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
		);
	}

	function inputIsInsideViewport(input: Input): boolean {
		return pointIsInsideViewport(input.clientX, input.clientY);
	}

	function mountedRowAtPoint(clientX: number, clientY: number): HTMLElement | null {
		const target = document.elementFromPoint(clientX, clientY);
		if (!(target instanceof Element)) return null;
		return target.closest<HTMLElement>('[data-sidebar-virtual-row]');
	}

	function mountedVirtualItemAtPoint(clientX: number, clientY: number): HTMLElement | null {
		const target = document.elementFromPoint(clientX, clientY);
		if (!(target instanceof Element)) return null;
		return target.closest<HTMLElement>('[data-sidebar-virtual-item]');
	}

	function mountedChatRowIds(): string[] {
		const container = viewportRef ?? listEl;
		if (!container) return [];
		return Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-virtual-row]'))
			.map((element) => element.dataset.sidebarVirtualRow)
			.filter((id): id is string => Boolean(id));
	}

	function closestEdgeForRow(rowEl: HTMLElement, clientY: number): Edge {
		const rect = rowEl.getBoundingClientRect();
		return clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
	}

	function lastValidDropMatches(sourceData: SidebarChatDragData): boolean {
		return (
			lastValidDrop?.sourceChatId === sourceData.chatId &&
			lastValidDrop.sourceList === sourceData.list &&
			lastValidDrop.sourceScopeKey === sourceData.reorderScopeKey
		);
	}

	function lastValidDropMatchesPreviewedSourcePlacement(sourceData: SidebarChatDragData): boolean {
		if (!lastValidDropMatches(sourceData) || !lastValidDrop) return false;
		const mountedOrder = mountedChatRowIds();
		const sourceIndex = mountedOrder.indexOf(sourceData.chatId);
		const targetIndex = mountedOrder.indexOf(lastValidDrop.targetChatId);
		if (sourceIndex < 0 || targetIndex < 0) return false;

		if (lastValidDrop.closestEdge === 'top') return sourceIndex === targetIndex - 1;
		if (lastValidDrop.closestEdge === 'bottom') return sourceIndex === targetIndex + 1;
		return Math.abs(sourceIndex - targetIndex) === 1;
	}

	function pointDropContext(
		sourceData: SidebarChatDragData,
		clientX: number,
		clientY: number,
	): SidebarPointDropContext {
		if (!pointIsInsideViewport(clientX, clientY)) return { kind: 'outside' };

		const virtualItem = mountedVirtualItemAtPoint(clientX, clientY);
		const rowEl = mountedRowAtPoint(clientX, clientY);
		if (!rowEl) return virtualItem ? { kind: 'blocked-item' } : { kind: 'empty' };

		const targetChatId = rowEl.dataset.sidebarVirtualRow;
		const targetList = rowListFromElement(rowEl);
		const targetScopeKey = rowScopeFromElement(rowEl);
		if (!targetChatId || !targetList || !targetScopeKey) return { kind: 'blocked-row' };

		if (
			targetChatId === sourceData.chatId &&
			targetList === sourceData.list &&
			targetScopeKey === sourceData.reorderScopeKey
		) {
			return { kind: 'source-row' };
		}

		const instruction = resolveSidebarDropInstructionForTarget({
			source: sourceData,
			target: getSidebarChatDropTargetData({
				chatId: targetChatId,
				list: targetList,
				index: -1,
				instanceId,
				reorderScopeKey: targetScopeKey,
			}),
			closestEdge: closestEdgeForRow(rowEl, clientY),
		});
		return instruction ? { kind: 'compatible-row', instruction } : { kind: 'blocked-row' };
	}

	function fallbackInstructionForPointContext(
		sourceData: SidebarChatDragData,
		context: SidebarPointDropContext,
	): SidebarDropInstruction | null {
		if (context.kind === 'compatible-row') return context.instruction;
		const fallback = lastValidDrop;
		if (!fallback || !lastValidDropMatches(sourceData)) return null;
		if (context.kind === 'empty') return fallback;
		if (context.kind === 'source-row' && lastValidDropMatchesPreviewedSourcePlacement(sourceData)) {
			return fallback;
		}
		return null;
	}

	function applySidebarDropInstruction(instruction: SidebarDropInstruction): void {
		activeDrop = { chatId: instruction.targetChatId, edge: instruction.closestEdge };
		reorder.preview({
			list: instruction.sourceList,
			sourceChatId: instruction.sourceChatId,
			targetChatId: instruction.targetChatId,
			closestEdge: instruction.closestEdge,
		});
	}

	function persistReorderRequest(request: SidebarChatReorderRequest | null): void {
		if (!request) return;
		onPersistReorder(request);
	}

	function previewSidebarDrop(
		sourceData: unknown,
		dropTargets: DropTargetRecord[],
		input: Input,
	): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		if (draggingChatId !== sourceData.chatId) return;
		if (!inputIsInsideViewport(input)) {
			activeDrop = null;
			lastValidDrop = null;
			return;
		}
		const instruction = resolveSidebarDropInstruction(sourceData, dropTargets);
		if (!instruction) {
			const context = pointDropContext(sourceData, input.clientX, input.clientY);
			const fallbackInstruction = fallbackInstructionForPointContext(sourceData, context);
			if (fallbackInstruction) {
				if (context.kind === 'compatible-row') {
					lastValidDrop = fallbackInstruction;
					applySidebarDropInstruction(fallbackInstruction);
				}
				return;
			}

			activeDrop = null;
			lastValidDrop = null;
			return;
		}

		lastValidDrop = instruction;
		applySidebarDropInstruction(instruction);
	}

	function finishSidebarDrop(
		sourceData: unknown,
		dropTargets: DropTargetRecord[],
		input: Input,
	): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		if (draggingChatId !== sourceData.chatId) return;
		const isInsideViewport = inputIsInsideViewport(input);
		const currentInstruction = isInsideViewport
			? resolveSidebarDropInstruction(sourceData, dropTargets)
			: null;
		const context = pointDropContext(sourceData, input.clientX, input.clientY);
		const fallbackInstruction = fallbackInstructionForPointContext(sourceData, context);
		// Uses the last valid row target when virtualization removes the current target at drop time.
		const instruction = currentInstruction ?? fallbackInstruction;

		if (instruction) {
			applySidebarDropInstruction(instruction);
			persistReorderRequest(reorder.finish(sourceData.list));
		} else {
			reorder.cancel(sourceData.list);
		}

		activeDrop = null;
		draggingChatId = null;
		lastValidDrop = null;
		setTimeout(() => {
			if (splitLayout.draggedChatId === sourceData.chatId) {
				splitLayout.endDrag();
			}
		}, 0);
	}

	function rowElementFromTarget(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element)) return null;
		if (target.closest('[data-sidebar-touch-drag-ignore]')) return null;
		return target.closest<HTMLElement>('[data-sidebar-virtual-row]');
	}

	function rowListFromElement(element: HTMLElement): ChatOrderList | null {
		const list = element.dataset.sidebarVirtualListRow;
		if (list === 'pinned' || list === 'normal' || list === 'archived') return list;
		return null;
	}

	function rowScopeFromElement(element: HTMLElement): string | null {
		return element.dataset.sidebarVirtualReorderScope || null;
	}

	function chatRowForId(chatId: string): SidebarVirtualChatRow | null {
		for (const row of rows) {
			if (row.type === 'chat' && row.chat.id === chatId) return row;
		}
		return null;
	}

	function touchForEvent(event: TouchEvent): Touch | null {
		if (!touchDrag) return null;
		for (const touch of Array.from(event.changedTouches)) {
			if (touch.identifier === touchDrag.identifier) return touch;
		}
		return null;
	}

	function resolveTouchInstruction(
		clientX: number,
		clientY: number,
	): SidebarDropInstruction | null {
		const current = touchDrag;
		if (!current || !pointIsInsideViewport(clientX, clientY)) return null;
		const rowEl = mountedRowAtPoint(clientX, clientY);
		if (!rowEl) return null;
		const targetChatId = rowEl.dataset.sidebarVirtualRow;
		const targetList = rowListFromElement(rowEl);
		const targetScopeKey = rowScopeFromElement(rowEl);
		if (!targetChatId || !targetList || !targetScopeKey || targetList !== current.sourceList)
			return null;
		if (targetScopeKey !== current.sourceScopeKey) return null;
		if (targetChatId === current.sourceChatId) return null;

		const rect = rowEl.getBoundingClientRect();
		const closestEdge: Edge = clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
		return {
			sourceChatId: current.sourceChatId,
			sourceList: current.sourceList,
			sourceScopeKey: current.sourceScopeKey,
			targetChatId,
			targetList,
			closestEdge,
		};
	}

	function touchSourceDragData(current: {
		sourceChatId: string;
		sourceList: ChatOrderList;
		sourceScopeKey: string;
	}): SidebarChatDragData {
		return getSidebarChatDragData({
			chatId: current.sourceChatId,
			list: current.sourceList,
			index: -1,
			instanceId,
			reorderScopeKey: current.sourceScopeKey,
		});
	}

	function previewTouchDrop(clientX: number, clientY: number): void {
		const instruction = resolveTouchInstruction(clientX, clientY);
		if (!instruction) {
			const current = touchDrag;
			if (current) {
				const sourceData = touchSourceDragData(current);
				const context = pointDropContext(sourceData, clientX, clientY);
				const fallbackInstruction = fallbackInstructionForPointContext(sourceData, context);
				if (fallbackInstruction) {
					if (context.kind === 'compatible-row') {
						lastValidDrop = fallbackInstruction;
						applySidebarDropInstruction(fallbackInstruction);
					}
					return;
				}
			}
			activeDrop = null;
			lastValidDrop = null;
			return;
		}
		lastValidDrop = instruction;
		applySidebarDropInstruction(instruction);
	}

	function stopTouchAutoScroll(): void {
		if (touchAutoScrollFrame === null) return;
		cancelAnimationFrame(touchAutoScrollFrame);
		touchAutoScrollFrame = null;
	}

	function runTouchAutoScroll(): void {
		touchAutoScrollFrame = null;
		const current = touchDrag;
		if (!current?.activated || !viewportRef) return;
		const rect = viewportRef.getBoundingClientRect();
		let delta = 0;
		if (current.currentY < rect.top + touchAutoScrollEdgePx) {
			const distance = Math.max(0, rect.top + touchAutoScrollEdgePx - current.currentY);
			delta = -Math.ceil(Math.min(touchAutoScrollMaxPx, distance / 3));
		} else if (current.currentY > rect.bottom - touchAutoScrollEdgePx) {
			const distance = Math.max(0, current.currentY - (rect.bottom - touchAutoScrollEdgePx));
			delta = Math.ceil(Math.min(touchAutoScrollMaxPx, distance / 3));
		}
		if (delta === 0) return;
		viewportRef.scrollTop += delta;
		previewTouchDrop(current.currentX, current.currentY);
		touchAutoScrollFrame = requestAnimationFrame(runTouchAutoScroll);
	}

	function scheduleTouchAutoScroll(): void {
		if (touchAutoScrollFrame !== null) return;
		touchAutoScrollFrame = requestAnimationFrame(runTouchAutoScroll);
	}

	function setInlineStyle(element: HTMLElement, property: string, value: string): void {
		if (value) {
			element.style.setProperty(property, value);
		} else {
			element.style.removeProperty(property);
		}
	}

	function captureSelectionGuardStyle(element: HTMLElement): Record<string, string> {
		return {
			userSelect: element.style.getPropertyValue('user-select'),
			webkitUserSelect: element.style.getPropertyValue('-webkit-user-select'),
			webkitTouchCallout: element.style.getPropertyValue('-webkit-touch-callout'),
		};
	}

	function applySelectionGuardStyle(element: HTMLElement): void {
		element.style.setProperty('user-select', 'none');
		element.style.setProperty('-webkit-user-select', 'none');
		element.style.setProperty('-webkit-touch-callout', 'none');
	}

	function restoreSelectionGuardStyle(element: HTMLElement, values: Record<string, string>): void {
		setInlineStyle(element, 'user-select', values.userSelect ?? '');
		setInlineStyle(element, '-webkit-user-select', values.webkitUserSelect ?? '');
		setInlineStyle(element, '-webkit-touch-callout', values.webkitTouchCallout ?? '');
	}

	function enableTouchSelectionGuard(): void {
		if (touchSelectionGuard) return;
		touchSelectionGuard = {
			body: captureSelectionGuardStyle(document.body),
			documentElement: captureSelectionGuardStyle(document.documentElement),
		};
		applySelectionGuardStyle(document.body);
		applySelectionGuardStyle(document.documentElement);
	}

	function restoreTouchSelectionGuard(): void {
		if (!touchSelectionGuard) return;
		restoreSelectionGuardStyle(document.body, touchSelectionGuard.body);
		restoreSelectionGuardStyle(document.documentElement, touchSelectionGuard.documentElement);
		touchSelectionGuard = null;
	}

	function clearDocumentSelection(): void {
		window.getSelection()?.removeAllRanges();
	}

	function removeTouchDragListeners(): void {
		window.removeEventListener('touchmove', handleTouchMove);
		window.removeEventListener('touchend', handleTouchEnd);
		window.removeEventListener('touchcancel', handleTouchCancel);
		window.removeEventListener('contextmenu', handleTouchContextMenu, true);
	}

	function clearTouchDrag(): void {
		if (touchDrag) clearTimeout(touchDrag.timer);
		touchDrag = null;
		stopTouchAutoScroll();
		removeTouchDragListeners();
		restoreTouchSelectionGuard();
	}

	function cancelTouchDrag(): void {
		const current = touchDrag;
		if (current?.activated) {
			reorder.cancel(current.sourceList);
			if (splitLayout.draggedChatId === current.sourceChatId) {
				splitLayout.endDrag();
			}
		}
		activeDrop = null;
		draggingChatId = null;
		lastValidDrop = null;
		clearTouchDrag();
	}

	function activateTouchDrag(): void {
		const current = touchDrag;
		if (!current || current.activated || !dragEnabled) return;
		current.activated = true;
		clearDocumentSelection();
		draggingChatId = current.sourceChatId;
		activeDrop = null;
		lastValidDrop = null;
		reorder.begin(current.sourceList, current.sourceChatId, {
			ids: chatRowForId(current.sourceChatId)?.reorderScopeIds ?? [current.sourceChatId],
		});
		splitLayout.startDrag(current.sourceChatId);
		previewTouchDrop(current.currentX, current.currentY);
		scheduleTouchAutoScroll();
	}

	function handleTouchStart(event: TouchEvent): void {
		if (!dragEnabled || event.touches.length !== 1) return;
		const rowEl = rowElementFromTarget(event.target);
		if (!rowEl) return;
		const sourceChatId = rowEl.dataset.sidebarVirtualRow;
		const sourceList = rowListFromElement(rowEl);
		const sourceScopeKey = rowScopeFromElement(rowEl);
		const touch = event.changedTouches[0];
		if (!sourceChatId || !sourceList || !sourceScopeKey || !touch) return;

		clearTouchDrag();
		enableTouchSelectionGuard();
		touchDrag = {
			identifier: touch.identifier,
			sourceChatId,
			sourceList,
			sourceScopeKey,
			startX: touch.clientX,
			startY: touch.clientY,
			currentX: touch.clientX,
			currentY: touch.clientY,
			activated: false,
			timer: setTimeout(activateTouchDrag, touchLongPressMs),
		};
		window.addEventListener('touchmove', handleTouchMove, { passive: false });
		window.addEventListener('touchend', handleTouchEnd, { passive: false });
		window.addEventListener('touchcancel', handleTouchCancel, { passive: false });
		window.addEventListener('contextmenu', handleTouchContextMenu, true);
	}

	function handleTouchMove(event: TouchEvent): void {
		const current = touchDrag;
		const touch = touchForEvent(event);
		if (!current || !touch) return;
		current.currentX = touch.clientX;
		current.currentY = touch.clientY;

		if (!current.activated) {
			const dx = touch.clientX - current.startX;
			const dy = touch.clientY - current.startY;
			if (Math.hypot(dx, dy) > touchMoveCancelThresholdPx) {
				cancelTouchDrag();
			}
			return;
		}

		event.preventDefault();
		clearDocumentSelection();
		previewTouchDrop(touch.clientX, touch.clientY);
		scheduleTouchAutoScroll();
	}

	function finishActiveTouchDrag(event: TouchEvent): void {
		const current = touchDrag;
		if (!current) return;
		const touch = touchForEvent(event);
		const clientX = touch?.clientX ?? current.currentX;
		const clientY = touch?.clientY ?? current.currentY;

		if (!current.activated) {
			clearTouchDrag();
			return;
		}

		event.preventDefault();
		clearDocumentSelection();
		suppressTouchClickUntil = performance.now() + 500;
		const sourceData = touchSourceDragData(current);
		const context = pointDropContext(sourceData, clientX, clientY);
		const instruction =
			resolveTouchInstruction(clientX, clientY) ??
			fallbackInstructionForPointContext(sourceData, context);

		if (instruction) {
			applySidebarDropInstruction(instruction);
			persistReorderRequest(reorder.finish(current.sourceList));
		} else {
			reorder.cancel(current.sourceList);
		}

		if (splitLayout.draggedChatId === current.sourceChatId) {
			splitLayout.endDrag();
		}
		activeDrop = null;
		draggingChatId = null;
		lastValidDrop = null;
		clearTouchDrag();
	}

	function handleTouchEnd(event: TouchEvent): void {
		finishActiveTouchDrag(event);
	}

	function handleTouchCancel(): void {
		cancelTouchDrag();
	}

	function handleTouchContextMenu(event: Event): void {
		if (touchDrag?.activated || performance.now() < suppressTouchClickUntil) {
			event.preventDefault();
		}
	}

	function suppressSyntheticTouchClick(event: MouseEvent): void {
		if (performance.now() >= suppressTouchClickUntil) return;
		event.preventDefault();
		event.stopPropagation();
	}

	function estimatedOffsetForIndex(index: number): number {
		let offset = 0;
		for (let rowIndex = 0; rowIndex < index; rowIndex += 1) {
			offset += estimateRowSize(rows[rowIndex]);
		}
		return offset;
	}

	function scrollTargetForChat(chatId: string): { index: number; chatId?: string; projectKey?: string } | null {
		const chatIndex = rows.findIndex((row) => row.type === 'chat' && row.chat.id === chatId);
		if (chatIndex >= 0) return { index: chatIndex, chatId };

		const projectIndex = rows.findIndex(
			(row) => row.type === 'project-header' && row.chatIds.includes(chatId),
		);
		if (projectIndex < 0) return null;
		const row = rows[projectIndex];
		if (!row || row.type !== 'project-header') return null;
		return { index: projectIndex, projectKey: row.projectKey };
	}

	function mountedElementForScrollTarget(target: {
		chatId?: string;
		projectKey?: string;
	}): HTMLElement | null {
		if (!viewportRef) return null;
		if (target.chatId) {
			return (
				Array.from(viewportRef.querySelectorAll<HTMLElement>('[data-sidebar-virtual-row]')).find(
					(element) => element.dataset.sidebarVirtualRow === target.chatId,
				) ?? null
			);
		}
		if (target.projectKey) {
			return (
				Array.from(viewportRef.querySelectorAll<HTMLElement>('[data-sidebar-project-key]')).find(
					(element) => element.dataset.sidebarProjectKey === target.projectKey,
				) ?? null
			);
		}
		return null;
	}

	function scrollChatIntoView(chatId: string | null): void {
		if (!chatId) return;
		const target = scrollTargetForChat(chatId);
		if (!target) return;
		let mountedTargetIsVisible = false;
		if (viewportRef) {
			const targetEl = mountedElementForScrollTarget(target);
			if (targetEl) {
				const viewportRect = viewportRef.getBoundingClientRect();
				const targetRect = targetEl.getBoundingClientRect();
				mountedTargetIsVisible =
					targetRect.top >= viewportRect.top && targetRect.bottom <= viewportRect.bottom;
				if (mountedTargetIsVisible) return;
			}
		}
		untrack(() => {
			$virtualizer.scrollToIndex(target.index, { align: 'auto' });
		});
		if (viewportRef && !mountedTargetIsVisible) {
			const offsetInfo = $virtualizer.getOffsetForIndex(target.index, 'start');
			const measuredOffset = offsetInfo?.[0];
			const estimatedOffset = estimatedOffsetForIndex(target.index);
			const targetOffset =
				measuredOffset !== undefined && (measuredOffset > 0 || target.index === 0)
					? measuredOffset
					: estimatedOffset;
			const viewportHeight = viewportRef.clientHeight || fallbackViewportHeight;
			viewportRef.scrollTop = Math.max(0, targetOffset - viewportHeight * 0.5);
		}
	}

	function moveToBoundary(row: SidebarVirtualChatRow, boundary: 'start' | 'end'): void {
		persistReorderRequest(
			reorder.moveToBoundary({
				list: row.list,
				chatId: row.chat.id,
				boundary,
				scope: { ids: row.reorderScopeIds },
			}),
		);
	}

	function getMoveToTop(row: SidebarVirtualChatRow): (() => void) | undefined {
		if (!dragEnabled) return undefined;
		const order = row.reorderScopeIds;
		const index = order.indexOf(row.chat.id);
		if (index <= 0) return undefined;
		return () => moveToBoundary(row, 'start');
	}

	function getMoveToBottom(row: SidebarVirtualChatRow): (() => void) | undefined {
		if (!dragEnabled) return undefined;
		const order = row.reorderScopeIds;
		const index = order.indexOf(row.chat.id);
		if (index < 0 || index >= order.length - 1) return undefined;
		return () => moveToBoundary(row, 'end');
	}

	onMount(() =>
		appShell.onSidebarRecenterRequested(() => {
			scrollChatIntoView(selectedChatId);
		}),
	);

	onMount(() =>
		monitorForElements({
			canMonitor: ({ source }) =>
				isSidebarChatDragData(source.data) && source.data.instanceId === instanceId,
			onDrag: ({ source, location }) => {
				previewSidebarDrop(source.data, location.current.dropTargets, location.current.input);
			},
			onDropTargetChange: ({ source, location }) => {
				previewSidebarDrop(source.data, location.current.dropTargets, location.current.input);
			},
			onDrop: ({ source, location }) => {
				finishSidebarDrop(source.data, location.current.dropTargets, location.current.input);
			},
		}),
	);

	onMount(() => {
		syncSeparatorPixelRatio();
		window.addEventListener('resize', syncSeparatorPixelRatio);
		return () => window.removeEventListener('resize', syncSeparatorPixelRatio);
	});

	onMount(() => {
		const element = listEl;
		if (!element) return;
		element.addEventListener('touchstart', handleTouchStart, { passive: true });
		element.addEventListener('click', suppressSyntheticTouchClick, true);
		return () => {
			element.removeEventListener('touchstart', handleTouchStart);
			element.removeEventListener('click', suppressSyntheticTouchClick, true);
			cancelTouchDrag();
		};
	});
</script>

<div
	bind:this={listEl}
	class="relative min-h-full"
	style={`height:${totalHeight}px;`}
	data-sidebar-virtual-list
	data-sidebar-filtered={isFiltered ? 'true' : 'false'}
>
	{#if selectedBackgroundItem}
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-x-0 bg-sidebar-chat-item-selected-bg"
			style={`top:${selectedBackgroundItem.top}px;height:${selectedBackgroundItem.height}px;`}
			data-sidebar-virtual-list-selected-background={selectedBackgroundItem.key}
		></div>
	{/if}
	{#each separatorItems as separator (separator.key)}
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-x-0 z-10 bg-border"
			style={`top:${separator.top}px;height:${separator.height}px;`}
			data-sidebar-virtual-list-separator={separator.key}
		></div>
	{/each}
	{#each virtualItems as virtualItem (`${virtualItem.index}:${rows[virtualItem.index]?.key ?? virtualItem.key}`)}
		{@const row = rows[virtualItem.index]}
		{#if row}
			<div
				data-sidebar-virtual-item={row.type}
				class="absolute left-0 right-0 top-0"
				style={`height:${virtualItem.size}px; transform:translateY(${virtualItem.start}px);`}
			>
				{#if row.type === 'project-header'}
					<SidebarProjectHeaderRow
						{row}
						containsSelectedChat={Boolean(
							row.isCollapsed && selectedChatId && row.chatIds.includes(selectedChatId),
						)}
						onToggle={onToggleProjectCollapsed}
					/>
				{:else}
					<SidebarVirtualSortableChatRow
						{row}
						index={virtualItem.index}
						{instanceId}
						{selectedChatId}
						{currentTime}
						{isMobile}
						{isMultiSelectMode}
						isMultiSelected={isMultiSelected?.(row.chat.id) ?? false}
						{displayOptions}
						{dragEnabled}
						isDragging={draggingChatId === row.chat.id}
						dropIndicatorEdge={activeDrop?.chatId === row.chat.id ? activeDrop.edge : null}
						onDragStart={startSidebarDrag}
						onDragUpdate={previewSidebarDrop}
						onDropOnRow={finishSidebarDrop}
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
				{/if}
			</div>
		{/if}
	{/each}
</div>
