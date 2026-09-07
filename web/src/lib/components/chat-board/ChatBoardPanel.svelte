<script lang="ts">
	import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { Button } from '$lib/components/ui/button';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import {
		projectChatBoard,
		type ChatBoardOccurrence,
	} from '$lib/chat-board/projection/chat-board-projection.js';
	import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
	import { getLocalSettings } from '$lib/context';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import type { ChatBoard } from '$shared/chat-boards';
	import * as m from '$lib/paraglide/messages.js';
	import ChatBoardEmptyState from './ChatBoardEmptyState.svelte';
	import ChatBoardLane from './ChatBoardLane.svelte';
	import ChatBoardToolbar from './ChatBoardToolbar.svelte';
	import ChatBoardTransitionDialog from './ChatBoardTransitionDialog.svelte';
	import EditColumnsDialog from './EditColumnsDialog.svelte';
	import ManageBoardsDialog from './ManageBoardsDialog.svelte';
	import {
		ChatBoardFocusController,
		type ChatBoardPresentationBand,
	} from './chat-board-focus-controller.js';
	import { isChatBoardCardDragData, resolveChatBoardColumnDropData } from './chat-board-dnd.js';

	let {
		controller,
		sessions,
		presentation,
		onOpenChat,
	}: {
		controller: ChatBoardController;
		sessions: ChatSessionsPort;
		presentation: PresentationHostId;
		onOpenChat: (chatId: string) => void;
	} = $props();

	const localSettings = getLocalSettings();
	const instanceId = crypto.randomUUID();
	const focusController = new ChatBoardFocusController();
	const laneScrollers = new Map<string, (key: string) => void>();
	const laneScrollOffsets = new SvelteMap<string, number>();
	let rootRef = $state<HTMLElement | null>(null);
	let boardViewportRef = $state<HTMLDivElement | null>(null);
	let presentationBand = $state<ChatBoardPresentationBand>('medium');
	let manageOpen = $state(false);
	let editBoard = $state<ChatBoard | null>(null);
	let transitionOccurrence = $state<ChatBoardOccurrence | null>(null);
	let transitionTargetColumnId = $state<string | null>(null);
	let transitionInvoker: HTMLElement | null = null;
	let dropTargetColumnId = $state<string | null>(null);
	let announcement = $state('');
	let focusedTabId = $state<string | null>(null);
	let selectedBoard = $derived(controller.selectedBoard);
	let lanes = $derived(selectedBoard ? projectChatBoard(selectedBoard, sessions.orderedChats) : []);
	let activeColumnId = $derived(
		selectedBoard?.columns.some((column) => column.id === controller.activeColumnId)
			? controller.activeColumnId
			: (selectedBoard?.columns[0]?.id ?? null),
	);
	let narrowLane = $derived(
		lanes.find((lane) => lane.column.id === activeColumnId) ?? lanes[0] ?? null,
	);
	let initialCatalogFailure = $derived(controller.status === 'error');
	let initialChatFailure = $derived(sessions.chatListStatus === 'error');
	let loading = $derived(controller.status === 'idle' || controller.status === 'loading');
	let canDrag = $derived(presentationBand !== 'narrow');
	let chatLoading = $derived(sessions.chatListStatus === 'loading');
	let effectiveFocusedTabId = $derived(
		selectedBoard?.columns.some((column) => column.id === focusedTabId)
			? focusedTabId
			: activeColumnId,
	);

	$effect(() => {
		focusController.setRoot(rootRef);
	});

	$effect(() => {
		const validKeys = new Set(
			controller.catalog.boards.flatMap((board) =>
				board.columns.map((column) => laneScrollKey(board.id, column.id)),
			),
		);
		untrack(() => {
			for (const key of laneScrollOffsets.keys()) {
				if (!validKeys.has(key)) laneScrollOffsets.delete(key);
			}
		});
	});

	$effect(() => {
		if (!rootRef || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? rootRef?.clientWidth ?? 0;
			const nextBand: ChatBoardPresentationBand =
				width < 560 ? 'narrow' : width < 900 ? 'medium' : 'wide';
			if (nextBand === presentationBand) return;
			rememberMountedLaneScrollPositions();
			focusController.preparePresentationChange(nextBand, activeColumnId);
			presentationBand = nextBand;
			void restoreAfterLaneRemount(() => focusController.completePresentationChange());
		});
		observer.observe(rootRef);
		return () => observer.disconnect();
	});

	$effect(() => {
		const board = selectedBoard;
		if (!board || presentationBand === 'narrow') return;
		return monitorForElements({
			canMonitor: ({ source }) =>
				isChatBoardCardDragData(source.data) &&
				source.data.instanceId === instanceId &&
				source.data.boardId === board.id,
			onDrag: updateDropTarget,
			onDropTargetChange: updateDropTarget,
			onDrop: ({ source, location }) => {
				dropTargetColumnId = null;
				if (!isChatBoardCardDragData(source.data)) return;
				const target = resolveChatBoardColumnDropData(
					location.current.dropTargets.map((item) => item.data),
					source.data,
				);
				if (!target) return;
				const lane = lanes.find((candidate) => candidate.column.id === source.data.sourceColumnId);
				const occurrence = lane?.occurrences.find(
					(candidate) => candidate.chat.id === source.data.chatId,
				);
				if (occurrence) openTransition(occurrence, target.columnId);
			},
		});
	});

	$effect(() => {
		if (!boardViewportRef || presentationBand === 'narrow') return;
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void import('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element').then((module) => {
			if (disposed || !boardViewportRef) return;
			cleanup = module.autoScrollForElements({
				element: boardViewportRef,
				canScroll: ({ source }) =>
					isChatBoardCardDragData(source.data) && source.data.instanceId === instanceId,
				getAllowedAxis: () => 'horizontal',
			});
		});
		return () => {
			disposed = true;
			cleanup?.();
		};
	});

	$effect.pre(() => {
		const nextLanes = lanes;
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		if (!(active instanceof HTMLElement) || !rootRef?.contains(active)) return;
		const occurrenceElement = active.closest<HTMLElement>('[data-chat-board-occurrence]');
		if (!occurrenceElement) return;
		const key = occurrenceElement.dataset.chatBoardOccurrence;
		const laneElement = occurrenceElement.closest<HTMLElement>('[data-chat-board-column-id]');
		const columnId = laneElement?.dataset.chatBoardColumnId;
		if (!key || !columnId) return;
		const nextLane = nextLanes.find((lane) => lane.column.id === columnId);
		if (nextLane?.occurrences.some((occurrence) => occurrence.key === key)) return;
		const oldIndex = Number(occurrenceElement.dataset.chatBoardOccurrenceIndex ?? 0);
		untrack(() => {
			void tick().then(() => {
				const candidates = nextLane?.occurrences ?? [];
				const fallback = candidates[Math.min(oldIndex, Math.max(0, candidates.length - 1))];
				if (fallback && focusController.focusOccurrence(columnId, fallback.chat.id)) return;
				if (nextLane && focusController.focusLane(columnId)) return;
				if (activeColumnId && focusController.focusLane(activeColumnId)) return;
				focusController.focusToolbar();
			});
		});
	});

	function updateDropTarget({
		location,
		source,
	}: {
		location: { current: { dropTargets: readonly { data: Record<string, unknown> }[] } };
		source: { data: Record<string, unknown> };
	}): void {
		dropTargetColumnId = isChatBoardCardDragData(source.data)
			? (resolveChatBoardColumnDropData(
					location.current.dropTargets.map((item) => item.data),
					source.data,
				)?.columnId ?? null)
			: null;
	}

	function registerScroller(columnId: string, scroll: ((key: string) => void) | null): void {
		if (scroll) laneScrollers.set(columnId, scroll);
		else laneScrollers.delete(columnId);
	}

	function laneScrollKey(boardId: string, columnId: string): string {
		return `${boardId}:${columnId}`;
	}

	function laneScrollTop(boardId: string, columnId: string): number {
		return laneScrollOffsets.get(laneScrollKey(boardId, columnId)) ?? 0;
	}

	function rememberLaneScroll(boardId: string, columnId: string, scrollTop: number): void {
		laneScrollOffsets.set(laneScrollKey(boardId, columnId), scrollTop);
	}

	function rememberMountedLaneScrollPositions(): void {
		const boardId = selectedBoard?.id;
		if (!boardId || !rootRef) return;
		for (const viewport of rootRef.querySelectorAll<HTMLElement>('[data-chat-board-lane-list]')) {
			const columnId = viewport.dataset.chatBoardLaneList;
			if (columnId) rememberLaneScroll(boardId, columnId, viewport.scrollTop);
		}
	}

	async function restoreAfterLaneRemount(afterRestore?: () => void): Promise<void> {
		await tick();
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const boardId = selectedBoard?.id;
				if (boardId && rootRef) {
					for (const viewport of rootRef.querySelectorAll<HTMLElement>(
						'[data-chat-board-lane-list]',
					)) {
						const columnId = viewport.dataset.chatBoardLaneList;
						const scrollTop = columnId
							? laneScrollOffsets.get(laneScrollKey(boardId, columnId))
							: undefined;
						if (scrollTop !== undefined) viewport.scrollTop = scrollTop;
					}
				}
				afterRestore?.();
			});
		});
	}

	function openTransition(
		occurrence: ChatBoardOccurrence,
		targetColumnId: string | null = null,
		invoker: HTMLElement | null = null,
	): void {
		transitionOccurrence = occurrence;
		transitionTargetColumnId = targetColumnId;
		transitionInvoker = invoker;
	}

	async function handleTransitionApplied(chatId: string, targetColumnId: string): Promise<void> {
		transitionOccurrence = null;
		transitionTargetColumnId = null;
		transitionInvoker = null;
		if (presentationBand === 'narrow') controller.selectColumn(targetColumnId);
		await tick();
		laneScrollers.get(targetColumnId)?.(`${targetColumnId}:${chatId}`);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		if (!focusController.focusOccurrence(targetColumnId, chatId))
			focusController.focusLane(targetColumnId);
		announcement = m.chat_board_transition_applied();
	}

	async function closeTransition(): Promise<void> {
		const occurrence = transitionOccurrence;
		const invoker = transitionInvoker;
		transitionOccurrence = null;
		transitionTargetColumnId = null;
		transitionInvoker = null;
		await tick();
		if (invoker?.isConnected && !invoker.matches(':disabled')) {
			invoker.focus({ preventScroll: true });
			return;
		}
		if (occurrence && focusController.focusOccurrence(occurrence.columnId, occurrence.chat.id))
			return;
		if (occurrence && focusController.focusLane(occurrence.columnId)) return;
		if (activeColumnId && focusController.focusLane(activeColumnId)) return;
		focusController.focusToolbar();
	}

	async function retryTagRecovery(chatId: string): Promise<void> {
		announcement = m.chat_board_confirming_tags();
		try {
			await sessions.recoverChatTags(chatId);
			announcement = m.chat_tags_confirmation_complete();
		} catch {
			announcement = m.chat_tags_confirmation_failed();
		}
	}

	function openEditor(board: ChatBoard): void {
		manageOpen = false;
		editBoard = board;
	}

	function selectTab(columnId: string): void {
		rememberMountedLaneScrollPositions();
		controller.selectColumn(columnId);
		focusedTabId = columnId;
		void restoreAfterLaneRemount();
	}

	function handleTabKeydown(event: KeyboardEvent, columnId: string): void {
		if (!selectedBoard) return;
		const columns = selectedBoard.columns;
		const index = columns.findIndex((column) => column.id === columnId);
		let targetIndex: number;
		if (event.key === 'ArrowRight') targetIndex = (index + 1) % columns.length;
		else if (event.key === 'ArrowLeft') targetIndex = (index - 1 + columns.length) % columns.length;
		else if (event.key === 'Home') targetIndex = 0;
		else if (event.key === 'End') targetIndex = columns.length - 1;
		else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			selectTab(columnId);
			return;
		} else return;
		event.preventDefault();
		const targetId = columns[targetIndex]?.id;
		if (!targetId) return;
		focusedTabId = targetId;
		rootRef?.querySelector<HTMLElement>(`[data-chat-board-tab="${CSS.escape(targetId)}"]`)?.focus();
	}
</script>

<section
	bind:this={rootRef}
	class="flex h-full min-h-0 min-w-0 flex-col bg-chat-board-canvas text-foreground"
	class:chat-board-reduce-motion={localSettings.reduceMotion}
	aria-label={m.workspace_surface_chat_board()}
	data-chat-board-panel
	data-presentation={presentation}
	data-presentation-band={presentationBand}
>
	<ChatBoardToolbar
		boards={controller.catalog.boards}
		{selectedBoard}
		itemLayout={controller.itemLayout}
		onSelectBoard={(boardId) => controller.selectBoard(boardId)}
		onEditColumns={() => {
			if (selectedBoard) editBoard = selectedBoard;
		}}
		onCreateBoard={() => (manageOpen = true)}
		onManageBoards={() => (manageOpen = true)}
		onSetLayout={(layout) => controller.setItemLayout(layout)}
	/>

	{#if (controller.error && controller.status === 'ready') || (sessions.chatListError && sessions.chatListStatus === 'ready')}
		<div
			class="flex shrink-0 items-center gap-2 border-b border-status-warning-border/70 bg-status-warning/10 px-3 py-2 text-xs text-status-warning-muted-foreground"
			role="status"
		>
			<CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="min-w-0 flex-1">{m.chat_board_stale()}</span>
			<button
				type="button"
				class="font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => {
					void controller.refresh(false);
					void sessions.quietRefreshChats();
				}}>{m.chat_board_try_again()}</button
			>
		</div>
	{/if}

	{#if loading}
		<div class="flex min-h-0 flex-1 gap-3 overflow-hidden p-3" aria-label={m.chat_board_loading()}>
			{#each [0, 1, 2] as item (item)}
				<div
					class="h-full w-[min(21rem,82%)] shrink-0 animate-pulse rounded-[10px] border border-chat-board-lane-border bg-chat-board-lane p-3"
				>
					<div class="h-4 w-28 rounded bg-muted-foreground/15"></div>
					<div class="mt-5 space-y-2">
						{#each [0, 1, 2, 3] as row (row)}<div
								class="h-20 rounded-[10px] border border-border/60 bg-card/70"
							></div>{/each}
					</div>
				</div>
			{/each}
		</div>
	{:else if initialCatalogFailure}
		<div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
			<div class="max-w-sm">
				<CircleAlert class="mx-auto size-8 text-status-error-foreground" />
				<h2 class="mt-3 text-base font-semibold">{m.chat_board_load_failed()}</h2>
				<p class="mt-1 text-sm text-muted-foreground">{controller.error}</p>
				<Button class="mt-4 gap-2" variant="outline" onclick={() => void controller.refresh(true)}
					><RefreshCw class="size-4" />{m.chat_board_try_again()}</Button
				>
			</div>
		</div>
	{:else if !selectedBoard}
		<ChatBoardEmptyState
			kind="boards"
			title={m.chat_board_no_boards_title()}
			description={m.chat_board_no_boards_description()}
			actionLabel={m.chat_board_create_board()}
			onAction={() => (manageOpen = true)}
		/>
	{:else if selectedBoard.columns.length === 0}
		<ChatBoardEmptyState
			kind="columns"
			title={m.chat_board_no_columns_title()}
			description={m.chat_board_no_columns_description()}
			actionLabel={m.chat_board_edit_columns()}
			onAction={() => (editBoard = selectedBoard)}
		/>
	{:else if chatLoading}
		<div class="flex min-h-0 flex-1 gap-3 overflow-hidden p-3" aria-label={m.chat_board_loading()}>
			{#each selectedBoard.columns.slice(0, 3) as column (column.id)}
				<div
					class="h-full w-[min(21rem,82%)] shrink-0 animate-pulse rounded-[10px] border border-chat-board-lane-border bg-chat-board-lane p-3"
				>
					<div class="h-4 w-28 rounded bg-muted-foreground/15"></div>
					<div class="mt-5 space-y-2">
						{#each [0, 1, 2, 3] as row (row)}<div
								class="h-20 rounded-[10px] border border-border/60 bg-card/70"
							></div>{/each}
					</div>
				</div>
			{/each}
		</div>
	{:else if initialChatFailure}
		<div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
			<div class="max-w-sm">
				<CircleAlert class="mx-auto size-8 text-status-error-foreground" />
				<h2 class="mt-3 text-base font-semibold">{m.chat_board_chats_load_failed()}</h2>
				<p class="mt-1 text-sm text-muted-foreground">{sessions.chatListError}</p>
				<Button
					class="mt-4 gap-2"
					variant="outline"
					onclick={() => void sessions.quietRefreshChats()}
					><RefreshCw class="size-4" />{m.chat_board_try_again()}</Button
				>
			</div>
		</div>
	{:else if presentationBand === 'narrow'}
		<div class="flex min-h-0 flex-1 flex-col">
			<div
				class="shrink-0 overflow-x-auto border-b border-border bg-card px-2"
				role="tablist"
				aria-label={m.chat_board_select_board()}
			>
				<div class="flex min-w-max gap-1 py-1.5">
					{#each lanes as lane (lane.column.id)}
						<button
							type="button"
							role="tab"
							aria-selected={lane.column.id === activeColumnId}
							aria-controls={`chat-board-panel-${lane.column.id}`}
							tabindex={effectiveFocusedTabId === lane.column.id ? 0 : -1}
							class="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-foreground aria-selected:text-background"
							onclick={() => selectTab(lane.column.id)}
							onkeydown={(event) => handleTabKeydown(event, lane.column.id)}
							data-chat-board-tab={lane.column.id}
						>
							<span>{lane.column.name}</span><span class="tabular-nums"
								>{lane.occurrences.length}</span
							>
						</button>
					{/each}
				</div>
			</div>
			{#if narrowLane}
				{#key `${selectedBoard.id}:${narrowLane.column.id}`}
					<div
						id={`chat-board-panel-${narrowLane.column.id}`}
						role="tabpanel"
						class="min-h-0 flex-1 p-2"
					>
						<ChatBoardLane
							lane={narrowLane}
							boardId={selectedBoard.id}
							{instanceId}
							layout={controller.itemLayout}
							canDrag={false}
							narrow
							isDropTarget={false}
							pendingChatIds={sessions.pendingTagMutationChatIds}
							recoveryChatIds={sessions.tagRecoveryRequiredChatIds}
							canTransition={selectedBoard.columns.length > 1}
							onOpen={onOpenChat}
							onTransition={(occurrence, invoker) => openTransition(occurrence, null, invoker)}
							onRecover={(chatId) => void retryTagRecovery(chatId)}
							onRegisterScroller={registerScroller}
							initialScrollTop={laneScrollTop(selectedBoard.id, narrowLane.column.id)}
							onScrollTopChange={rememberLaneScroll}
						/>
					</div>
				{/key}
			{/if}
		</div>
	{:else}
		<div
			bind:this={boardViewportRef}
			class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-3"
			data-chat-board-viewport
		>
			<div class="flex h-full min-w-max gap-3">
				{#each lanes as lane (lane.column.id)}
					<ChatBoardLane
						{lane}
						boardId={selectedBoard.id}
						{instanceId}
						layout={controller.itemLayout}
						{canDrag}
						narrow={false}
						isDropTarget={dropTargetColumnId === lane.column.id}
						pendingChatIds={sessions.pendingTagMutationChatIds}
						recoveryChatIds={sessions.tagRecoveryRequiredChatIds}
						canTransition={selectedBoard.columns.length > 1}
						onOpen={onOpenChat}
						onTransition={(occurrence, invoker) => openTransition(occurrence, null, invoker)}
						onRecover={(chatId) => void retryTagRecovery(chatId)}
						onRegisterScroller={registerScroller}
						initialScrollTop={laneScrollTop(selectedBoard.id, lane.column.id)}
						onScrollTopChange={rememberLaneScroll}
					/>
				{/each}
			</div>
		</div>
	{/if}

	<p class="sr-only" aria-live="polite">{announcement}</p>

	{#if manageOpen}
		<ManageBoardsDialog
			open
			{controller}
			onClose={() => (manageOpen = false)}
			onEditBoard={openEditor}
		/>
	{/if}
	{#if editBoard}
		<EditColumnsDialog open {controller} board={editBoard} onClose={() => (editBoard = null)} />
	{/if}
	{#if transitionOccurrence && selectedBoard}
		<ChatBoardTransitionDialog
			open
			{controller}
			{sessions}
			board={selectedBoard}
			occurrence={transitionOccurrence}
			initialTargetColumnId={transitionTargetColumnId}
			onClose={() => void closeTransition()}
			onApplied={(chatId: string, targetColumnId: string) =>
				void handleTransitionApplied(chatId, targetColumnId)}
		/>
	{/if}
</section>
