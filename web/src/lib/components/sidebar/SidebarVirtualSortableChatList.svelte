<script lang="ts">
	import type { NewChatProjectTarget } from '$lib/chat/new-chat/new-chat-seed';
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
	import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
	import { getAppShell, getWorkspaceWindowDnd } from '$lib/context';
	import SidebarProjectHeaderRow from './SidebarProjectHeaderRow.svelte';
	import SidebarExecutorHeaderRow from './SidebarExecutorHeaderRow.svelte';
	import SidebarSectionHeaderRow from './SidebarSectionHeaderRow.svelte';
	import SidebarVirtualSortableChatRow from './SidebarVirtualSortableChatRow.svelte';
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
		computeSidebarSeparatorItems,
		DEFAULT_CHAT_ROW_OVERSCAN,
		type SidebarVirtualChatRow,
		type SidebarVirtualRow,
	} from '../../sidebar/display/sidebar-virtual-chat-list';
	import {
		mountedElementForScrollTarget as domMountedElementForScrollTarget,
		pointIsInsideViewport as domPointIsInsideViewport,
		sidebarScrollTargetForChat,
	} from './sidebar-chat-list-dom';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../../sidebar/display/sidebar-display-options';
	import {
		SidebarOrderController,
		type SidebarChatReorderRequest,
	} from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import {
		getSidebarChatDragData,
		isSidebarChatDragData,
		resolveSidebarDropInstruction,
		type SidebarChatDragData,
		type SidebarDropInstruction,
	} from './sidebar-pragmatic-dnd';
	import {
		sidebarPointDropContext,
		sidebarFallbackDropInstruction,
		type SidebarPointDropContext,
	} from './sidebar-drop-targets';
	import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import { SidebarVirtualChatListController } from './SidebarVirtualChatListController.svelte.js';
	import { SidebarWorkspaceChatDragBridge } from './sidebar-workspace-chat-drag-bridge.js';

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
		reorder: SidebarOrderController;
		onPersistReorder: (request: SidebarChatReorderRequest) => void;
		onSortChatOrder: (sortKey: ChatOrderSortKey) => void;
		onChatSelect: (chatId: string) => void;
		onDeleteChat: (chat: ChatSessionRecord) => void;
		onStartRenameChat: (chat: ChatSessionRecord) => void;
		onTogglePinned: (chatId: string) => void;
		onToggleArchive: (chatId: string) => void;
		isArchiveMutationPending?: (chatId: string) => boolean;
		onShowDetails: (chat: ChatSessionRecord) => void;
		onForkChat: (sourceChatId: string) => void;
		onShareChat: (chat: ChatSessionRecord) => void;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onNewProjectChat?: (project: NewChatProjectTarget) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
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
		onSortChatOrder,
		onChatSelect,
		onDeleteChat,
		onStartRenameChat,
		onTogglePinned,
		onToggleArchive,
		isArchiveMutationPending = () => false,
		onShowDetails,
		onForkChat,
		onShareChat,
		onTagClick,
		onManageTags,
		onOpenInNewWindow,
		newWindowEdges,
		onToggleProjectCollapsed,
		onNewProjectChat,
		onEnterMultiSelect,
		onMultiSelectToggle,
	}: SidebarVirtualSortableChatListProps = $props();

	const appShell = getAppShell();
	const workspaceChatDrag = new SidebarWorkspaceChatDragBridge(getWorkspaceWindowDnd());
	const instanceId = Symbol('sidebar-chat-list');
	const desktopBottomPadding = 16;
	const mobileBottomPadding = 112;
	const touchLongPressMs = 360;
	const touchMoveCancelThresholdPx = 10;
	const touchAutoScrollEdgePx = 56;
	const touchAutoScrollMaxPx = 18;

	let activeDrop = $state<{ chatId: string; edge: Edge | null } | null>(null);
	let draggingChatId = $state<string | null>(null);
	let dragScopeKey: string | null = null;
	let listEl = $state<HTMLElement | null>(null);
	let lastValidDrop: SidebarDropInstruction | null = null;
	let touchDrag: {
		identifier: number;
		sourceChatId: string;
		sourceList: PersistedChatOrderGroup;
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
	let pendingRecenter = $state<string | null>(null);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	// Reorder and quick-move only apply to the manual sort order; the
	// recent-activity sort is derived, so reordering is disabled there.
	// Dragging a chat onto a workspace window stays available in every sort mode.
	let dragEnabled = $derived(!isMultiSelectMode);
	let reorderEnabled = $derived(
		dragEnabled &&
			displayOptions.sortMode === 'manual' &&
			!reorder.sorting &&
			!reorder.sortRecovery,
	);
	const moveBoundaryLabels = $derived.by(() => {
		if (isFiltered) {
			return { first: m.sidebar_move_first_filtered(), last: m.sidebar_move_last_filtered() };
		}
		if (
			displayOptions.nestDelegatedChats ||
			displayOptions.groupingFields.some((field) => field.enabled)
		) {
			return { first: m.sidebar_move_first_group(), last: m.sidebar_move_last_group() };
		}
		return undefined;
	});
	const indicatorIndex = $derived.by(() => {
		if (!activeDrop) return -1;
		let index = rows.findIndex((row) => row.type === 'chat' && row.chat.id === activeDrop!.chatId);
		if (index < 0 || activeDrop.edge !== 'bottom') return index;
		const depth = rows[index].depth;
		while (index + 1 < rows.length && rows[index + 1].depth > depth) index++;
		return index;
	});
	$effect(() => {
		if (!draggingChatId || !reorder.activeList) return;
		const source = rows.find((row) => row.type === 'chat' && row.chat.id === draggingChatId);
		if (
			!reorderEnabled ||
			reorder.dragPresentationChanged ||
			source?.type !== 'chat' ||
			source.reorderScopeKey !== dragScopeKey ||
			!source.reorderScopeIds.includes(source.chat.id)
		) {
			untrack(() => {
				reorder.cancel();
				cancelTouchDrag();
				clearDragPresentation();
			});
		}
	});
	let separatorLineHeight = $derived(1 / Math.max(separatorPixelRatio, 1));

	function syncSeparatorPixelRatio(): void {
		separatorPixelRatio = window.devicePixelRatio || 1;
	}

	const virtual = new SidebarVirtualChatListController();
	let virtualSnapshot = $derived(virtual.snapshot);
	let virtualItems = $derived(virtual.items(virtualSnapshot, rows));
	// Matches rows by identity while the geometry effect catches up with regrouping.
	const rowsByKey = $derived(new Map(rows.map((row, index) => [row.key, { row, index }])));
	const renderedItems = $derived.by(() => {
		return virtualItems.flatMap((virtualItem) => {
			const match = rowsByKey.get(virtualItem.key);
			return match ? [{ row: match.row, virtualItem: { ...virtualItem, index: match.index } }] : [];
		});
	});
	let totalHeight = $derived(virtualSnapshot.sizerSize + bottomPadding);
	// Single-line rows drop the separator line entirely; no trailing slot is
	// reserved for it.
	let separatorItems = $derived(
		displayOptions.chatItemLayout === 'single-line'
			? []
			: computeSidebarSeparatorItems(
					renderedItems.map(({ virtualItem }) => virtualItem),
					rows,
					separatorLineHeight,
					separatorPixelRatio,
				),
	);
	let selectedBackgroundItem = $derived.by(() => {
		if (isMultiSelectMode || !selectedChatId) return null;
		const separatorSlot =
			displayOptions.chatItemLayout === 'single-line' ? 0 : CHAT_ROW_SEPARATOR_SLOT_HEIGHT;

		for (const { row, virtualItem } of renderedItems) {
			if (row.type !== 'chat' || row.chat.id !== selectedChatId) continue;

			const top = virtualItem.start > 0 ? virtualItem.start - separatorSlot : virtualItem.start;
			return {
				key: row.key ?? virtualItem.key,
				top,
				height: virtualItem.start + virtualItem.size - top,
			};
		}

		return null;
	});

	$effect.pre(() => {
		const nextRows = rows;
		const chatItemLayout = displayOptions.chatItemLayout;
		const showProjectPath = displayOptions.showProjectPath;
		const chatFontScale = displayOptions.chatFontScale;
		const explicitRowHeight = rowHeight;
		const rowOverscan = overscan;
		untrack(() =>
			virtual.update({
				rows: nextRows,
				chatItemLayout,
				showProjectPath,
				chatFontScale,
				rowHeight: explicitRowHeight,
				overscan: rowOverscan,
			}),
		);
	});
	$effect(() => {
		const element = viewportRef;
		if (!element) return;
		const cleanup = virtual.viewport(element);
		return cleanup;
	});
	$effect(() => {
		if (pendingRecenter && viewportRef && scrollChatIntoView(pendingRecenter))
			pendingRecenter = null;
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
					canScroll: ({ source }) => reorderEnabled && isSidebarChatDragData(source.data),
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

	function clearDragPresentation(): void {
		activeDrop = null;
		draggingChatId = null;
		dragScopeKey = null;
		lastValidDrop = null;
	}

	function startSidebarDrag(row: SidebarVirtualChatRow): void {
		if (!dragEnabled) return;
		if (touchDrag) cancelTouchDrag();
		clearDragPresentation();
		draggingChatId = row.chat.id;
		dragScopeKey = row.reorderScopeKey;
		if (reorderEnabled) {
			reorder.begin(row.list, row.chat.id, { ids: row.reorderScopeIds });
		}
		workspaceChatDrag.begin(row.chat.id);
	}

	function cancelUnmountedDragSource(chatId: string): void {
		const ownsTouchDrag = touchDrag?.sourceChatId === chatId;
		const ownsNativeDrag = draggingChatId === chatId && !(ownsTouchDrag && touchDrag?.activated);
		if (!ownsTouchDrag && !ownsNativeDrag) return;
		if (rows.some((row) => row.type === 'chat' && row.chat.id === chatId)) {
			if (touchDrag?.sourceChatId === chatId && !touchDrag.activated) cancelTouchDrag();
			return;
		}
		if (ownsTouchDrag) cancelTouchDrag();
		if (!ownsNativeDrag) return;
		// Window-only drags (derived sort modes) survive a source row unmount: a
		// real drop still reaches the list-level monitor and ends the drag there,
		// and a cancelled drag is recovered by pragmatic's broken-drag detection.
		// Reorder drags cancel only when the source leaves the projection.
		if (!reorderEnabled) return;
		if (reorder.activeList) reorder.cancel();
		clearDragPresentation();
		workspaceChatDrag.endIfOwned(chatId);
	}

	function pointIsInsideViewport(clientX: number, clientY: number): boolean {
		return Boolean(viewportRef && domPointIsInsideViewport(viewportRef, clientX, clientY));
	}

	function inputIsInsideViewport(input: Input): boolean {
		return pointIsInsideViewport(input.clientX, input.clientY);
	}

	function pointDropContext(
		sourceData: SidebarChatDragData,
		clientX: number,
		clientY: number,
	): SidebarPointDropContext {
		return sidebarPointDropContext(viewportRef, instanceId, sourceData, clientX, clientY, rows);
	}

	function fallbackInstructionForPointContext(
		sourceData: SidebarChatDragData,
		context: SidebarPointDropContext,
	): SidebarDropInstruction | null {
		return sidebarFallbackDropInstruction(sourceData, context, lastValidDrop, rows);
	}

	function applySidebarDropInstruction(instruction: SidebarDropInstruction): void {
		const source = chatRowForId(instruction.sourceChatId);
		const target = chatRowForId(instruction.targetChatId);
		if (
			!source ||
			!target ||
			source.reorderScopeKey !== instruction.sourceScopeKey ||
			target.reorderScopeKey !== instruction.sourceScopeKey ||
			!source.reorderScopeIds.includes(target.chat.id)
		) {
			reorder.cancel();
			activeDrop = null;
			return;
		}
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
		if (!reorderEnabled) return;
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
		if (reorderEnabled) {
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
				reorder.cancel();
			}
		}

		clearDragPresentation();
		setTimeout(() => {
			workspaceChatDrag.endIfOwned(sourceData.chatId);
		}, 0);
	}

	function rowElementFromTarget(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element)) return null;
		if (target.closest('[data-sidebar-touch-drag-ignore]')) return null;
		return target.closest<HTMLElement>('[data-sidebar-virtual-row]');
	}

	function rowListFromElement(element: HTMLElement): PersistedChatOrderGroup | null {
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
		if (!current) return null;
		const context = pointDropContext(touchSourceDragData(current), clientX, clientY);
		return context.kind === 'compatible-row' ? context.instruction : null;
	}

	function touchSourceDragData(current: {
		sourceChatId: string;
		sourceList: PersistedChatOrderGroup;
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
		virtual.scrollBy(delta);
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
			reorder.cancel();
			workspaceChatDrag.endIfOwned(current.sourceChatId);
			clearDragPresentation();
		}
		clearTouchDrag();
	}

	function activateTouchDrag(): void {
		const current = touchDrag;
		if (!current || current.activated || !reorderEnabled) return;
		current.activated = true;
		clearDocumentSelection();
		clearDragPresentation();
		draggingChatId = current.sourceChatId;
		dragScopeKey = current.sourceScopeKey;
		reorder.begin(current.sourceList, current.sourceChatId, {
			ids: chatRowForId(current.sourceChatId)?.reorderScopeIds ?? [current.sourceChatId],
		});
		workspaceChatDrag.begin(current.sourceChatId);
		previewTouchDrop(current.currentX, current.currentY);
		scheduleTouchAutoScroll();
	}

	function handleTouchStart(event: TouchEvent): void {
		if (!reorderEnabled || draggingChatId !== null || event.touches.length !== 1) return;
		const rowEl = rowElementFromTarget(event.target);
		if (!rowEl) return;
		const sourceChatId = rowEl.dataset.sidebarVirtualRow;
		const sourceList = rowListFromElement(rowEl);
		const sourceScopeKey = rowScopeFromElement(rowEl);
		const touch = event.changedTouches[0];
		if (!sourceChatId || !sourceList || !sourceScopeKey || !touch) return;
		if (!chatRowForId(sourceChatId)?.reorderScopeIds.includes(sourceChatId)) return;

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
			reorder.cancel();
		}

		workspaceChatDrag.endIfOwned(current.sourceChatId);
		clearDragPresentation();
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

	function scrollChatIntoView(chatId: string): boolean {
		const target = sidebarScrollTargetForChat(rows, chatId);
		if (!target) return false;
		if (viewportRef) {
			const targetEl = domMountedElementForScrollTarget(viewportRef, target);
			if (targetEl) {
				const viewportBox = viewportRef.getBoundingClientRect();
				const targetBox = targetEl.getBoundingClientRect();
				if (targetBox.top >= viewportBox.top && targetBox.bottom <= viewportBox.bottom) return true;
			}
		}
		return untrack(() => virtual.scrollToIndex(target.index)).kind === 'scheduled';
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
		if (!reorderEnabled) return undefined;
		const order = row.reorderScopeIds;
		const index = order.indexOf(row.chat.id);
		if (index <= 0) return undefined;
		return () => moveToBoundary(row, 'start');
	}

	function getMoveAdjacent(row: SidebarVirtualChatRow, offset: -1 | 1): (() => void) | undefined {
		if (!reorderEnabled) return undefined;
		const index = row.reorderScopeIds.indexOf(row.chat.id);
		const target = index >= 0 ? row.reorderScopeIds[index + offset] : undefined;
		if (!target) return undefined;
		return () => {
			reorder.begin(row.list, row.chat.id, { ids: row.reorderScopeIds });
			reorder.preview({
				list: row.list,
				sourceChatId: row.chat.id,
				targetChatId: target,
				closestEdge: offset < 0 ? 'top' : 'bottom',
			});
			persistReorderRequest(reorder.finish(row.list));
		};
	}

	function getMoveToBottom(row: SidebarVirtualChatRow): (() => void) | undefined {
		if (!reorderEnabled) return undefined;
		const order = row.reorderScopeIds;
		const index = order.indexOf(row.chat.id);
		if (index < 0 || index >= order.length - 1) return undefined;
		return () => moveToBoundary(row, 'end');
	}

	onMount(() =>
		appShell.onSidebarRecenterRequested(() => {
			const chatId = selectedChatId;
			pendingRecenter = chatId && !scrollChatIntoView(chatId) ? chatId : null;
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

	onDestroy(() => {
		reorder.cancel();
		// The drag monitor is torn down with the list, so a drag the list still
		// owns (its source row may already be unmounted) would leak otherwise.
		workspaceChatDrag.endIfOwned(draggingChatId);
		virtual.destroy();
	});
</script>

<div
	bind:this={listEl}
	class="relative min-h-full"
	style={`height:${totalHeight}px;`}
	data-sidebar-virtual-list
	data-sidebar-filtered={isFiltered ? 'true' : 'false'}
>
	<div
		class="absolute inset-x-0 top-0"
		style={`height:${virtualSnapshot.sizerSize}px;`}
		data-sidebar-virtual-sizer
		{@attach virtual.sizer}
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
				class="pointer-events-none absolute right-0 z-10 bg-border"
				style={`top:${separator.top}px;left:${separator.left}px;height:${separator.height}px;`}
				data-sidebar-virtual-list-separator={separator.key}
			></div>
		{/each}
		{#each renderedItems as { row, virtualItem } (row.key)}
			{@const containsSelectedChat = Boolean(
				row.type !== 'chat' &&
				row.isCollapsed &&
				selectedChatId &&
				row.containsChat(selectedChatId),
			)}
			<div
				data-sidebar-virtual-item={row.type}
				class="absolute left-0 right-0 top-0"
				style={`height:${virtualItem.size}px; transform:translateY(${virtualItem.start}px);`}
			>
				{#if row.type === 'executor-header'}
					<SidebarExecutorHeaderRow
						{row}
						separated={virtualItem.index > 0}
						{containsSelectedChat}
						onToggle={onToggleProjectCollapsed}
					/>
				{:else if row.type === 'project-header'}
					<SidebarProjectHeaderRow
						{row}
						{onNewProjectChat}
						{containsSelectedChat}
						onToggle={onToggleProjectCollapsed}
					/>
				{:else if row.type === 'section-header'}
					<SidebarSectionHeaderRow
						{row}
						{containsSelectedChat}
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
						isMultiSelectMode={isMultiSelectMode && !row.contextOnly}
						isMultiSelected={isMultiSelected?.(row.chat.id) ?? false}
						{displayOptions}
						dragEnabled={dragEnabled && !row.contextOnly}
						reorderEnabled={reorderEnabled && row.reorderScopeIds.length > 1}
						onToggleBranch={onToggleProjectCollapsed}
						isDragging={draggingChatId === row.chat.id}
						onDragStart={startSidebarDrag}
						onDragSourceUnmount={cancelUnmountedDragSource}
						onDragUpdate={previewSidebarDrop}
						onDropOnRow={finishSidebarDrop}
						{onChatSelect}
						{onDeleteChat}
						{onStartRenameChat}
						{onTogglePinned}
						{onToggleArchive}
						isArchiveMutationPending={isArchiveMutationPending(row.chat.id)}
						{onShowDetails}
						{onForkChat}
						{onShareChat}
						{onTagClick}
						{onManageTags}
						{onOpenInNewWindow}
						{newWindowEdges}
						onEnterMultiSelect={row.contextOnly ? undefined : onEnterMultiSelect}
						onMultiSelectToggle={row.contextOnly ? undefined : onMultiSelectToggle}
						onMoveToTop={getMoveToTop(row)}
						onMoveUp={getMoveAdjacent(row, -1)}
						onMoveDown={getMoveAdjacent(row, 1)}
						{moveBoundaryLabels}
						onMoveToBottom={getMoveToBottom(row)}
						onSortChatOrder={displayOptions.sortMode === 'manual' && !reorder.busy
							? onSortChatOrder
							: undefined}
					/>
				{/if}
				{#if virtualItem.index === indicatorIndex}
					<div
						class="pointer-events-none absolute inset-x-2 z-20 h-0.5 bg-primary"
						class:top-0={activeDrop?.edge === 'top'}
						class:bottom-0={activeDrop?.edge !== 'top'}
						data-sidebar-branch-drop-indicator
					></div>
				{/if}
			</div>
		{/each}
	</div>
</div>
