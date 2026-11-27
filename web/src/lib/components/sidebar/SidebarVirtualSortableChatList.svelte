<script lang="ts">
	import type { SidebarRowActions } from './sidebar-row-actions.js';
	import type { NewChatProjectTarget } from '$lib/chat/new-chat/new-chat-seed';
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { DropTargetRecord, Input } from '@atlaskit/pragmatic-drag-and-drop/types';
	import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
	import { getAppShell, getWorkspaceWindowDnd } from '$lib/context';
	import SidebarProjectHeaderRow from './SidebarProjectHeaderRow.svelte';
	import SidebarExecutorHeaderRow from './SidebarExecutorHeaderRow.svelte';
	import SidebarSectionHeaderRow from './SidebarSectionHeaderRow.svelte';
	import SidebarWorkflowRunRow from './SidebarWorkflowRunRow.svelte';
	import SidebarVirtualSortableChatRow from './SidebarVirtualSortableChatRow.svelte';
	import SidebarTreeGuides from './SidebarTreeGuides.svelte';
	import {
		CHAT_ROW_SEPARATOR_SLOT_HEIGHT,
		computeSidebarSeparatorItems,
		sidebarDisplayRows,
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
	import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy.js';
	import { SidebarVirtualChatListController } from './SidebarVirtualChatListController.js';
	import { SidebarWorkspaceChatDragBridge } from './sidebar-workspace-chat-drag-bridge.js';
	import { SidebarTouchReorderController } from './sidebar-touch-reorder-controller.js';
	import {
		bindSidebarAutoScroll,
		bindSidebarDesktopReorder,
	} from './sidebar-desktop-reorder-controller.js';
	import type { SidebarWorkflowControls } from './sidebar-workflow-controls';

	interface SidebarVirtualSortableChatListProps {
		actions: SidebarRowActions;
		rows: SidebarVirtualRow[];
		viewportRef: HTMLElement | null;
		viewportHeight: number;
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
		workflowControls?: SidebarWorkflowControls;
		onPersistReorder: (request: SidebarChatReorderRequest) => void;
		onSortChatOrder: (sortKey: ChatOrderSortKey) => void;
		newWindowEdges: WorkspaceSplitAdmissions;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onNewProjectChat?: (project: NewChatProjectTarget) => void;
	}

	let {
		actions,
		rows,
		viewportRef,
		viewportHeight,
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
		workflowControls,
		onPersistReorder,
		onSortChatOrder,
		newWindowEdges,
		onToggleProjectCollapsed,
		onNewProjectChat,
	}: SidebarVirtualSortableChatListProps = $props();

	const appShell = getAppShell();
	const workspaceChatDrag = new SidebarWorkspaceChatDragBridge(getWorkspaceWindowDnd());
	const instanceId = Symbol('sidebar-chat-list');
	const desktopBottomPadding = 16;
	const mobileBottomPadding = 112;

	let activeDrop = $state<{ chatId: string; edge: Edge | null } | null>(null);
	let draggingChatId = $state<string | null>(null);
	let dragScopeKey: string | null = null;
	let listWidth = $state(0);
	let lastValidDrop: SidebarDropInstruction | null = null;
	let separatorPixelRatio = $state(1);
	let pendingRecenter = $state<string | null>(null);
	let bottomPadding = $derived(isMobile ? mobileBottomPadding : desktopBottomPadding);
	// Reorder and quick-move only apply to the manual sort order; the
	// recent-activity sort is derived, so reordering is disabled there.
	// Dragging a chat onto a workspace window stays available in every sort mode.
	let dragEnabled = $derived(!isMultiSelectMode);
	let reorderEnabled = $derived(
		dragEnabled && displayOptions.sortMode === 'manual' && !reorder.busy,
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
		if (!draggingChatId) return;
		const source = rows.find((row) => row.type === 'chat' && row.chat.id === draggingChatId);
		if (source?.type !== 'chat') {
			untrack(() => {
				workspaceChatDrag.endIfOwned(draggingChatId!);
				reorder.cancel();
				touchReorder.cancel();
				clearDragPresentation();
			});
			return;
		}
		if (!reorder.activeList) return;
		if (
			!reorderEnabled ||
			reorder.dragPresentationChanged ||
			source.reorderScopeKey !== dragScopeKey ||
			!source.reorderScopeIds.includes(source.chat.id)
		) {
			untrack(() => {
				reorder.cancel();
				touchReorder.cancel();
				activeDrop = null;
				lastValidDrop = null;
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
	const displayRows = $derived(sidebarDisplayRows(rows, displayOptions.chatItemLayout));
	const renderedItems = $derived.by(() => {
		let indexesByKey: Map<string, number> | undefined;
		return virtualItems.flatMap((virtualItem) => {
			const row = displayRows[virtualItem.index];
			if (row?.key === virtualItem.key) return [{ row, virtualItem }];
			// Regrouping can precede the geometry update; stale items still resolve by key.
			indexesByKey ??= new Map(displayRows.map((item, index) => [item.key, index]));
			const index = indexesByKey.get(virtualItem.key);
			if (index === undefined) return [];
			return [{ row: displayRows[index], virtualItem: { ...virtualItem, index } }];
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
					displayRows,
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
	const desktopViewport = $derived(isMobile ? null : viewportRef);
	// The list, including bottom padding, is the viewport's only in-flow content.
	const autoScrollViewport = $derived(
		viewportHeight > 0 && totalHeight > viewportHeight && rows.length > 0 ? desktopViewport : null,
	);
	$effect(() => {
		const element = autoScrollViewport;
		if (!element) return;
		return bindSidebarAutoScroll(element, instanceId, () => reorderEnabled);
	});
	$effect(() => {
		const viewport = desktopViewport;
		if (!viewport) return;
		return bindSidebarDesktopReorder(viewport, {
			instanceId,
			canReorder: () => reorderEnabled,
			preview: previewSidebarDrop,
			finish: finishSidebarDrop,
		});
	});

	function clearDragPresentation(): void {
		activeDrop = null;
		draggingChatId = null;
		dragScopeKey = null;
		lastValidDrop = null;
	}

	function startSidebarDrag(row: SidebarVirtualChatRow): void {
		if (!dragEnabled) return;
		touchReorder.cancel();
		clearDragPresentation();
		draggingChatId = row.chat.id;
		dragScopeKey = row.reorderScopeKey;
		if (reorderEnabled) {
			reorder.begin(row.list, row.chat.id, { ids: row.reorderScopeIds });
		}
		workspaceChatDrag.begin(row.chat.id);
	}

	function cancelUnmountedDragSource(chatId: string): void {
		touchReorder.sourceUnmounted(chatId);
		if (draggingChatId !== chatId || chatRowForId(chatId)) return;
		// Window-only drags (derived sort modes) survive a source row unmount: a
		// real drop still reaches the list-level monitor and ends the drag there,
		// and a cancelled drag is recovered by pragmatic's broken-drag detection.
		// Reorder drags cancel only when the source leaves the projection.
		if (!reorderEnabled) return;
		if (reorder.activeList) reorder.cancel();
		clearDragPresentation();
		workspaceChatDrag.endIfOwned(chatId);
	}

	function inputIsInsideViewport(input: Input): boolean {
		return Boolean(
			viewportRef && domPointIsInsideViewport(viewportRef, input.clientX, input.clientY),
		);
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
			clearDropPreview();
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

	function clearDropPreview(): void {
		reorder.clearPreview();
		activeDrop = null;
		lastValidDrop = null;
	}

	function persistReorderRequest(request: SidebarChatReorderRequest | null): void {
		if (!request) return;
		onPersistReorder(request);
	}

	function previewPointDrop(
		sourceData: SidebarChatDragData,
		clientX: number,
		clientY: number,
	): void {
		const context = pointDropContext(sourceData, clientX, clientY);
		const instruction = fallbackInstructionForPointContext(sourceData, context);
		if (!instruction) {
			clearDropPreview();
			return;
		}
		if (context.kind === 'compatible-row') {
			lastValidDrop = instruction;
			applySidebarDropInstruction(instruction);
		}
	}

	function previewSidebarDrop(
		sourceData: unknown,
		dropTargets: DropTargetRecord[],
		input: Input,
	): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		if (draggingChatId !== sourceData.chatId) return;
		if (!reorderEnabled || reorder.activeChatId !== sourceData.chatId) return;
		if (!inputIsInsideViewport(input)) {
			clearDropPreview();
			return;
		}
		const instruction = resolveSidebarDropInstruction(sourceData, dropTargets);
		if (!instruction) {
			previewPointDrop(sourceData, input.clientX, input.clientY);
			return;
		}

		lastValidDrop = instruction;
		applySidebarDropInstruction(instruction);
	}

	function acceptedDropInstruction(
		source: SidebarChatDragData,
		dropTargets: DropTargetRecord[],
		input: Input,
	): SidebarDropInstruction | null {
		// Cancellation clears the accepted targets, even when the pointer is still over a row.
		const accepted = dropTargets.some(
			({ element, isActiveDueToStickiness }) => element === viewportRef && !isActiveDueToStickiness,
		);
		if (!accepted || !inputIsInsideViewport(input)) return null;

		const instruction = resolveSidebarDropInstruction(source, dropTargets);
		if (instruction) return instruction;
		const context = pointDropContext(source, input.clientX, input.clientY);
		return fallbackInstructionForPointContext(source, context);
	}

	function finishSidebarDrop(
		sourceData: unknown,
		dropTargets: DropTargetRecord[],
		input: Input,
	): void {
		if (!isSidebarChatDragData(sourceData) || sourceData.instanceId !== instanceId) return;
		if (draggingChatId !== sourceData.chatId) return;
		if (reorderEnabled && reorder.activeChatId === sourceData.chatId) {
			const instruction = acceptedDropInstruction(sourceData, dropTargets, input);
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

	const touchReorder = new SidebarTouchReorderController({
		canActivate: () => reorderEnabled && draggingChatId === null,
		viewport: () => viewportRef,
		scrollBy: (delta) => virtual.scrollBy(delta),
		resolveSource(target) {
			const element = rowElementFromTarget(target);
			if (!element) return null;
			const chatId = element.dataset.sidebarVirtualRow;
			const list = rowListFromElement(element);
			const reorderScopeKey = rowScopeFromElement(element);
			if (
				!chatId ||
				!list ||
				!reorderScopeKey ||
				!chatRowForId(chatId)?.reorderScopeIds.includes(chatId)
			)
				return null;
			return getSidebarChatDragData({ chatId, list, reorderScopeKey, index: -1, instanceId });
		},
		onActivate(source) {
			clearDragPresentation();
			draggingChatId = source.chatId;
			dragScopeKey = source.reorderScopeKey;
			reorder.begin(source.list, source.chatId, {
				ids: chatRowForId(source.chatId)?.reorderScopeIds ?? [source.chatId],
			});
			workspaceChatDrag.begin(source.chatId);
		},
		onMove: previewPointDrop,
		onFinish(source, x, y) {
			const context = pointDropContext(source, x, y);
			const instruction = fallbackInstructionForPointContext(source, context);
			if (instruction) {
				applySidebarDropInstruction(instruction);
				persistReorderRequest(reorder.finish(source.list));
			} else {
				reorder.cancel();
			}
			workspaceChatDrag.endIfOwned(source.chatId);
			clearDragPresentation();
		},
		onCancel(source) {
			reorder.cancel();
			workspaceChatDrag.endIfOwned(source.chatId);
			clearDragPresentation();
		},
	});

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
		if (!reorderEnabled) return;
		persistReorderRequest(
			reorder.moveToBoundary({ list: row.list, chatId: row.chat.id, boundary }),
		);
	}

	function moveAdjacent(row: SidebarVirtualChatRow, offset: -1 | 1): void {
		if (!reorderEnabled) return;
		persistReorderRequest(reorder.moveAdjacent({ list: row.list, chatId: row.chat.id, offset }));
	}

	onMount(() =>
		appShell.onSidebarRecenterRequested(() => {
			const chatId = selectedChatId;
			pendingRecenter = chatId && !scrollChatIntoView(chatId) ? chatId : null;
		}),
	);

	onMount(() => {
		syncSeparatorPixelRatio();
		window.addEventListener('resize', syncSeparatorPixelRatio);
		return () => window.removeEventListener('resize', syncSeparatorPixelRatio);
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
	{@attach touchReorder.attach}
	bind:clientWidth={listWidth}
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
				'containsChat' in row &&
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
						onToggle={isFiltered ? undefined : onToggleProjectCollapsed}
					/>
				{:else if row.type === 'project-header'}
					<SidebarProjectHeaderRow
						{row}
						{onNewProjectChat}
						{containsSelectedChat}
						onToggle={isFiltered ? undefined : onToggleProjectCollapsed}
					/>
				{:else if row.type === 'section-header'}
					<SidebarSectionHeaderRow
						{row}
						{containsSelectedChat}
						onToggle={isFiltered ? undefined : onToggleProjectCollapsed}
					/>
				{:else if row.type === 'workflow-run' && workflowControls}
					<SidebarWorkflowRunRow
						{row}
						selected={row.run.id === workflowControls.selectedRunId}
						{containsSelectedChat}
						onOpen={() => workflowControls?.openRun(row.run.id)}
						onToggle={isFiltered ? undefined : () => workflowControls?.toggleRun(row.run.id)}
					/>
				{:else if row.type === 'workflow-more' && workflowControls}
					<button
						type="button"
						class="h-full w-full pl-6 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
						disabled={workflowControls.fetching}
						onclick={() => workflowControls?.loadMore(row.page)}
					>
						{row.page === 'runs' ? m.workflow_nav_more_runs() : m.workflow_nav_more_active_chats()}
					</button>
				{:else if row.type === 'chat'}
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
						{dragEnabled}
						reorderEnabled={reorderEnabled && row.reorderScopeIds.length > 1}
						onToggleBranch={isFiltered ? undefined : onToggleProjectCollapsed}
						isDragging={draggingChatId === row.chat.id}
						onDragStart={startSidebarDrag}
						onDragSourceUnmount={cancelUnmountedDragSource}
						{actions}
						{newWindowEdges}
						onMoveToBoundary={moveToBoundary}
						onMoveAdjacent={moveAdjacent}
						{moveBoundaryLabels}
						onSortChatOrder={displayOptions.sortMode === 'manual' && !reorder.busy
							? onSortChatOrder
							: undefined}
					/>
				{/if}
				{#if row.tree && displayOptions.chatItemLayout === 'single-line'}
					<SidebarTreeGuides
						{row}
						guide={row.tree}
						contentHeight={virtualItem.size}
						width={listWidth}
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
