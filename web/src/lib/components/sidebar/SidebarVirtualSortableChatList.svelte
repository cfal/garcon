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
	import SidebarVirtualSortableChatRow from './SidebarVirtualSortableChatRow.svelte';
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
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
		resolveSidebarDropInstruction,
		type SidebarDropInstruction,
	} from './sidebar-pragmatic-dnd';
	import type { ChatOrderList } from '$lib/api/chats.js';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
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
		onPersistReorder: (request: SidebarChatReorderRequest) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chatId: string, chatTitle: string, agentId: SessionAgentId) => void;
		onStartRenameChat: (chatId: string, currentName: string) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		onShowDetails: (chatId: string, chatTitle: string) => void;
		onForkChat: (sourceChatId: string) => void;
		onReloadChat?: (chatId: string) => void;
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
		onReloadChat,
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
	let effectiveRowHeight = $derived(
		rowHeight ?? (isMobile ? MOBILE_CHAT_ROW_HEIGHT : DESKTOP_CHAT_ROW_HEIGHT),
	);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	let dragEnabled = $derived(!isMultiSelectMode);
	let separatorLineHeight = $derived(1 / Math.max(separatorPixelRatio, 1));

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
	let separatorItems = $derived.by(() =>
		virtualItems
			.filter((virtualItem) => virtualItem.index < rows.length)
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

	function startSidebarDrag(list: ChatOrderList, chatId: string): void {
		if (!dragEnabled) return;
		draggingChatId = chatId;
		activeDrop = null;
		lastValidDrop = null;
		reorder.begin(list, chatId);
		splitLayout.startDrag(chatId);
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

	function canUseLastValidDrop(input: {
		sourceChatId: string;
		sourceList: ChatOrderList;
		clientX: number;
		clientY: number;
	}): boolean {
		return (
			pointIsInsideViewport(input.clientX, input.clientY) &&
			mountedRowAtPoint(input.clientX, input.clientY) === null &&
			lastValidDrop?.sourceChatId === input.sourceChatId &&
			lastValidDrop.sourceList === input.sourceList
		);
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
			activeDrop = null;
			if (mountedRowAtPoint(input.clientX, input.clientY)) lastValidDrop = null;
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
		const fallbackInstruction = canUseLastValidDrop({
			sourceChatId: sourceData.chatId,
			sourceList: sourceData.list,
			clientX: input.clientX,
			clientY: input.clientY,
		})
			? lastValidDrop
			: null;
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
		if (!targetChatId || !targetList || targetList !== current.sourceList) return null;
		if (targetChatId === current.sourceChatId) return null;

		const rect = rowEl.getBoundingClientRect();
		const closestEdge: Edge = clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
		return {
			sourceChatId: current.sourceChatId,
			sourceList: current.sourceList,
			targetChatId,
			targetList,
			closestEdge,
		};
	}

	function previewTouchDrop(clientX: number, clientY: number): void {
		const instruction = resolveTouchInstruction(clientX, clientY);
		if (!instruction) {
			activeDrop = null;
			if (!pointIsInsideViewport(clientX, clientY) || mountedRowAtPoint(clientX, clientY)) {
				lastValidDrop = null;
			}
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
		reorder.begin(current.sourceList, current.sourceChatId);
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
		const touch = event.changedTouches[0];
		if (!sourceChatId || !sourceList || !touch) return;

		clearTouchDrag();
		enableTouchSelectionGuard();
		touchDrag = {
			identifier: touch.identifier,
			sourceChatId,
			sourceList,
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
		const instruction =
			resolveTouchInstruction(clientX, clientY) ??
			(canUseLastValidDrop({
				sourceChatId: current.sourceChatId,
				sourceList: current.sourceList,
				clientX,
				clientY,
			})
				? lastValidDrop
				: null);

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

	function scrollChatIntoView(chatId: string | null): void {
		if (!chatId) return;
		const index = rows.findIndex((row) => row.chat.id === chatId);
		if (index < 0) return;
		let mountedRowIsVisible = false;
		if (viewportRef) {
			const rowEl = Array.from(
				viewportRef.querySelectorAll<HTMLElement>('[data-sidebar-virtual-row]'),
			).find((element) => element.dataset.sidebarVirtualRow === chatId);
			if (rowEl) {
				const viewportRect = viewportRef.getBoundingClientRect();
				const rowRect = rowEl.getBoundingClientRect();
				mountedRowIsVisible =
					rowRect.top >= viewportRect.top && rowRect.bottom <= viewportRect.bottom;
				if (mountedRowIsVisible) return;
			}
		}
		untrack(() => {
			$virtualizer.scrollToIndex(index, { align: 'auto' });
		});
		if (viewportRef && !mountedRowIsVisible) {
			const viewportHeight = viewportRef.clientHeight || fallbackViewportHeight;
			viewportRef.scrollTop = Math.max(0, index * effectiveRowHeight - viewportHeight * 0.5);
		}
	}

	function moveToBoundary(row: SidebarVirtualChatRow, boundary: 'start' | 'end'): void {
		persistReorderRequest(
			reorder.moveToBoundary({
				list: row.list,
				chatId: row.chat.id,
				boundary,
			}),
		);
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
	{#each separatorItems as separator (separator.key)}
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-x-0 bg-border"
			style={`top:${separator.top}px;height:${separator.height}px;`}
			data-sidebar-virtual-list-separator={separator.key}
		></div>
	{/each}
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
					{onReloadChat}
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
