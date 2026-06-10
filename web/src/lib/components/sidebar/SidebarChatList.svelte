<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import SidebarChatItem from './SidebarChatItem.svelte';
	import SidebarVirtualChatList from './SidebarVirtualChatList.svelte';
	import Search from '@lucide/svelte/icons/search';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import { DragDropProvider, PointerSensor } from '@dnd-kit/svelte';
	import { createSortable } from '@dnd-kit/svelte/sortable';
	import { resolveReorderIndices, hasSortableShape, type DragEndLike } from './drag-reorder';
	import type { SidebarVirtualChatRow } from './sidebar-virtual-chat-list';

	const implicitDragSensors = [PointerSensor.configure({ preventActivation: () => false })];
	import type { Action } from 'svelte/action';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderList } from '$lib/api/chats.js';

	const VIRTUALIZATION_THRESHOLD = 80;
	interface SidebarChatListProps {
		viewportRef?: HTMLElement | null;
		chats: ChatSessionRecord[];
		filteredChats: ChatSessionRecord[];
		selectedChatId: string | null;
		isLoading: boolean;
		isMobile?: boolean;
		currentTime: Date;
		searchFilter: string;
		isReorderMode: boolean;
		isMultiSelectMode?: boolean;
		isMultiSelected?: (chatId: string) => boolean;
		onEnterReorderMode: () => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMultiSelectToggle?: (chatId: string, shiftKey: boolean) => void;
		onReorderGroup: (list: ChatOrderList, oldOrder: string[], newOrder: string[]) => void;
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
		onImmediateReorder: (list: ChatOrderList, oldOrder: string[], newOrder: string[]) => void;
		onQuickMove: (chatId: string, chatIdAbove?: string, chatIdBelow?: string) => void;
	}

	let {
		viewportRef = null,
		chats,
		filteredChats,
		selectedChatId,
		isLoading,
		isMobile = false,
		currentTime,
		searchFilter,
		isReorderMode,
		isMultiSelectMode = false,
		isMultiSelected,
		onEnterReorderMode,
		onEnterMultiSelect,
		onMultiSelectToggle,
		onReorderGroup,
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
		onImmediateReorder,
		onQuickMove,
	}: SidebarChatListProps = $props();

	let showChats = $derived(!isLoading && chats.length > 0 && filteredChats.length > 0);
	// Chats are sorted by recent activity; flat list is always used.
	// Normal-mode drag is disabled while a search filter is active.
	let isFiltered = $derived(searchFilter.trim().length > 0);

	// Partition all chats in a single pass.
	let allPartitioned = $derived.by(() => {
		const pinned: typeof chats = [];
		const normal: typeof chats = [];
		const archived: typeof chats = [];
		for (const s of chats) {
			if (s.isPinned) pinned.push(s);
			else if (s.isArchived) archived.push(s);
			else normal.push(s);
		}
		return { pinned, normal, archived, hasPinned: pinned.length > 0 };
	});

	// Partition filtered chats in a single pass.
	let filteredPartitioned = $derived.by(() => {
		const pinned: typeof filteredChats = [];
		const normal: typeof filteredChats = [];
		const archived: typeof filteredChats = [];
		for (const s of filteredChats) {
			if (s.isPinned) pinned.push(s);
			else if (s.isArchived) archived.push(s);
			else normal.push(s);
		}
		return { pinned, normal, archived };
	});

	let hasPinnedChats = $derived(allPartitioned.hasPinned);
	let pinnedAll = $derived(allPartitioned.pinned);
	let pinnedFiltered = $derived(filteredPartitioned.pinned);
	let normalAll = $derived(allPartitioned.normal);
	let normal = $derived(filteredPartitioned.normal);
	let archivedAll = $derived(allPartitioned.archived);
	let archived = $derived(filteredPartitioned.archived);
	let displayedPinned = $derived(isFiltered ? pinnedFiltered : pinnedAll);
	let displayedNormal = $derived(isFiltered ? normal : normalAll);
	let displayedArchived = $derived(isFiltered ? archived : archivedAll);
	let virtualRows = $derived.by(() => toVirtualRows(displayedPinned, displayedNormal, displayedArchived));
	let useVirtualList = $derived(virtualRows.length > VIRTUALIZATION_THRESHOLD);

	function toVirtualRows(
		pinnedRows: ChatSessionRecord[],
		normalRows: ChatSessionRecord[],
		archivedRows: ChatSessionRecord[],
	): SidebarVirtualChatRow[] {
		const rows: SidebarVirtualChatRow[] = [];
		for (const chat of pinnedRows) {
			rows.push({
				type: 'chat',
				key: `pinned:${chat.id}`,
				chat,
				list: 'pinned',
				isPinned: true,
				isArchived: false,
			});
		}
		for (const chat of normalRows) {
			rows.push({
				type: 'chat',
				key: `normal:${chat.id}`,
				chat,
				list: 'normal',
				isPinned: false,
				isArchived: false,
			});
		}
		for (const chat of archivedRows) {
			rows.push({
				type: 'chat',
				key: `archived:${chat.id}`,
				chat,
				list: 'archived',
				isPinned: false,
				isArchived: true,
			});
		}
		return rows;
	}

	// Reorder mode: draft ordering for each group.
	let pinnedDraftOrder = $state<string[]>([]);
	let normalDraftOrder = $state<string[]>([]);
	let archivedDraftOrder = $state<string[]>([]);

	$effect(() => {
		if (isReorderMode) {
			pinnedDraftOrder = untrack(() => pinnedAll.map((s) => s.id));
			normalDraftOrder = untrack(() => normalAll.map((s) => s.id));
			archivedDraftOrder = untrack(() => archivedAll.map((s) => s.id));
		}
	});

	let pinnedById = $derived(new Map(pinnedAll.map((s) => [s.id, s])));
	let normalById = $derived(new Map(normalAll.map((s) => [s.id, s])));
	let archivedById = $derived(new Map(archivedAll.map((s) => [s.id, s])));

	function reorderArray(ids: string[], from: number, to: number): string[] {
		if (from === to) return ids;
		const next = [...ids];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		return next;
	}

	function moveToTop(list: ChatOrderList, chatId: string) {
		const getDraft = () => list === 'pinned' ? pinnedDraftOrder : list === 'normal' ? normalDraftOrder : archivedDraftOrder;
		const draft = getDraft();
		const idx = draft.indexOf(chatId);
		if (idx <= 0) return;
		const next = [chatId, ...draft.filter((id) => id !== chatId)];
		if (list === 'pinned') pinnedDraftOrder = next;
		else if (list === 'normal') normalDraftOrder = next;
		else archivedDraftOrder = next;
		onReorderGroup(list, draft, next);
	}

	function moveToBottom(list: ChatOrderList, chatId: string) {
		const getDraft = () => list === 'pinned' ? pinnedDraftOrder : list === 'normal' ? normalDraftOrder : archivedDraftOrder;
		const draft = getDraft();
		const idx = draft.indexOf(chatId);
		if (idx < 0 || idx === draft.length - 1) return;
		const next = [...draft.filter((id) => id !== chatId), chatId];
		if (list === 'pinned') pinnedDraftOrder = next;
		else if (list === 'normal') normalDraftOrder = next;
		else archivedDraftOrder = next;
		onReorderGroup(list, draft, next);
	}

	function handleReorderDragEnd(list: ChatOrderList, event: DragEndLike) {
		const getDraft = () => list === 'pinned' ? pinnedDraftOrder : list === 'normal' ? normalDraftOrder : archivedDraftOrder;
		const draft = getDraft();
		const source = event?.operation?.source;
		const target = event?.operation?.target;
		if (!source || !target || !hasSortableShape(source) || !hasSortableShape(target)) return;
		// Uses dnd-kit-consistent index resolution to avoid stale projected
		// indices causing "no movement" drags and wrong drop destinations.
		const indices = resolveReorderIndices(event, draft);
		if (!indices) return;
		const next = reorderArray(draft, indices.from, indices.to);
		if (list === 'pinned') pinnedDraftOrder = next;
		else if (list === 'normal') normalDraftOrder = next;
		else archivedDraftOrder = next;
		onReorderGroup(list, draft, next);
	}

	// Normal-mode drag state. During a drag the local override takes
	// precedence so the UI doesn't jump. Outside of a drag, rendering
	// uses server-derived order directly to avoid stale-effect bugs.
	let pinnedDragOverride = $state<string[] | null>(null);
	let normalDragOverride = $state<string[] | null>(null);

	let pinnedLocalOrder = $derived(pinnedDragOverride ?? pinnedAll.map((s) => s.id));
	let normalLocalOrder = $derived(normalDragOverride ?? normalAll.map((s) => s.id));

	function handleNormalDragStart() {
		pinnedDragOverride = pinnedAll.map((s) => s.id);
		normalDragOverride = normalAll.map((s) => s.id);
	}

	function handleNormalPinnedDragEnd(event: DragEndLike) {
		const current = pinnedDragOverride ?? pinnedAll.map((s) => s.id);
		pinnedDragOverride = null;
		normalDragOverride = null;
		const source = event?.operation?.source;
		const target = event?.operation?.target;
		if (!source || !target || !hasSortableShape(source) || !hasSortableShape(target)) return;
		const indices = resolveReorderIndices(event, current);
		if (!indices) return;
		const oldOrder = [...current];
		const next = reorderArray(current, indices.from, indices.to);
		onImmediateReorder('pinned', oldOrder, next);
	}

	function handleNormalNormalDragEnd(event: DragEndLike) {
		const current = normalDragOverride ?? normalAll.map((s) => s.id);
		pinnedDragOverride = null;
		normalDragOverride = null;
		const source = event?.operation?.source;
		const target = event?.operation?.target;
		if (!source || !target || !hasSortableShape(source) || !hasSortableShape(target)) return;
		const indices = resolveReorderIndices(event, current);
		if (!indices) return;
		const oldOrder = [...current];
		const next = reorderArray(current, indices.from, indices.to);
		onImmediateReorder('normal', oldOrder, next);
	}
</script>

{#if isLoading}
	<div class="h-full flex items-center justify-center px-4">
		<div class="text-center w-full max-w-xs">
			<div class="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-4 md:mb-3">
				<div class="w-6 h-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"></div>
			</div>
			<h3 class="text-base font-medium text-foreground mb-2 md:mb-1">{m.sidebar_chats_loading_chats()}</h3>
			<p class="text-sm text-muted-foreground">{m.sidebar_chats_fetching_chats()}</p>
		</div>
	</div>
{:else if !showChats}
	<div class="text-center py-12 md:py-8 px-4">
		<div class="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-4 md:mb-3">
			<Search class="w-6 h-6 text-muted-foreground" />
		</div>
		<h3 class="text-base font-medium text-foreground mb-2 md:mb-1">{m.sidebar_chats_no_matching_chats()}</h3>
		<p class="text-sm text-muted-foreground">{m.sidebar_chats_try_different_search()}</p>
	</div>
{:else if isReorderMode}
	<div class="h-full pb-28 md:pb-4">
		{#if pinnedDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
				{m.sidebar_chats_reordering_pinned()}
			</div>
			<DragDropProvider onDragEnd={(e) => handleReorderDragEnd('pinned', e)}>
				{#each pinnedDraftOrder as chatId, idx (chatId)}
					{@const chat = pinnedById.get(chatId)}
					{#if chat}
						{@const sortable = createSortable({ id: chat.id, index: idx, group: 'chat-group-pinned' })}
						{@const attach = sortable.attach as unknown as Action}
						{@const attachHandle = sortable.attachHandle as unknown as Action}
						<div class="relative flex items-stretch" use:attach>
							<button
								type="button"
								class="flex items-center justify-center w-8 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
								use:attachHandle
								aria-label="Drag to reorder"
							>
								<GripVertical class="w-4 h-4" />
							</button>
							<div class="flex-1 min-w-0">
								<SidebarChatItem
									session={chat}
									{selectedChatId}
									{currentTime}
									{isMobile}
									isPinned={true}
									isArchived={false}
									isReorderMode={true}
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
										{onEnterReorderMode}
									onMoveToTop={idx > 0 ? () => moveToTop('pinned', chatId) : undefined}
									onMoveToBottom={idx < pinnedDraftOrder.length - 1 ? () => moveToBottom('pinned', chatId) : undefined}
								/>
							</div>
						</div>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if normalDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
				{m.sidebar_chats_reordering_normal()}
			</div>
			<DragDropProvider onDragEnd={(e) => handleReorderDragEnd('normal', e)}>
				{#each normalDraftOrder as chatId, idx (chatId)}
					{@const chat = normalById.get(chatId)}
					{#if chat}
						{@const sortable = createSortable({ id: chat.id, index: idx, group: 'chat-group-normal' })}
						{@const attach = sortable.attach as unknown as Action}
						{@const attachHandle = sortable.attachHandle as unknown as Action}
						<div class="relative flex items-stretch" use:attach>
							<button
								type="button"
								class="flex items-center justify-center w-8 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
								use:attachHandle
								aria-label="Drag to reorder"
							>
								<GripVertical class="w-4 h-4" />
							</button>
							<div class="flex-1 min-w-0">
								<SidebarChatItem
									session={chat}
									{selectedChatId}
									{currentTime}
									{isMobile}
									isPinned={false}
									isArchived={false}
									isReorderMode={true}
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
										{onEnterReorderMode}
									onMoveToTop={idx > 0 ? () => moveToTop('normal', chatId) : undefined}
									onMoveToBottom={idx < normalDraftOrder.length - 1 ? () => moveToBottom('normal', chatId) : undefined}
								/>
							</div>
						</div>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if archivedDraftOrder.length > 0}
			<div class="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
				{m.sidebar_chats_reordering_archived()}
			</div>
			<DragDropProvider onDragEnd={(e) => handleReorderDragEnd('archived', e)}>
				{#each archivedDraftOrder as chatId, idx (chatId)}
					{@const chat = archivedById.get(chatId)}
					{#if chat}
						{@const sortable = createSortable({ id: chat.id, index: idx, group: 'chat-group-archived' })}
						{@const attach = sortable.attach as unknown as Action}
						{@const attachHandle = sortable.attachHandle as unknown as Action}
						<div class="relative flex items-stretch" use:attach>
							<button
								type="button"
								class="flex items-center justify-center w-8 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors"
								use:attachHandle
								aria-label="Drag to reorder"
							>
								<GripVertical class="w-4 h-4" />
							</button>
							<div class="flex-1 min-w-0">
								<SidebarChatItem
									session={chat}
									{selectedChatId}
									{currentTime}
									{isMobile}
									isPinned={false}
									isArchived={true}
									isReorderMode={true}
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
										{onEnterReorderMode}
									onMoveToTop={idx > 0 ? () => moveToTop('archived', chatId) : undefined}
									onMoveToBottom={idx < archivedDraftOrder.length - 1 ? () => moveToBottom('archived', chatId) : undefined}
								/>
							</div>
						</div>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}

		{#if pinnedDraftOrder.length === 0 && normalDraftOrder.length === 0 && archivedDraftOrder.length === 0}
			<div class="px-3 py-4 text-sm text-muted-foreground">
				{m.sidebar_chats_no_chats_to_reorder()}
			</div>
		{/if}
	</div>
{:else if useVirtualList}
	<SidebarVirtualChatList
		rows={virtualRows}
		{viewportRef}
		{selectedChatId}
		{currentTime}
		{isMobile}
		{isMultiSelectMode}
		{isMultiSelected}
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
		{onEnterReorderMode}
		{onEnterMultiSelect}
		{onMultiSelectToggle}
		{hasPinnedChats}
	/>
{:else}
	<div class="h-full pb-28 md:pb-4">
			{#if isFiltered}
				{#each pinnedFiltered as gs (gs.id)}
					<SidebarChatItem
						session={gs}
						{selectedChatId}
						{currentTime}
						{isMobile}
						isPinned={true}
						isArchived={false}
						{isMultiSelectMode}
						isMultiSelected={isMultiSelected?.(gs.id) ?? false}
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
							{onEnterReorderMode}
						{onEnterMultiSelect}
						{onMultiSelectToggle}
						{hasPinnedChats}
					/>
				{/each}
			{:else if pinnedLocalOrder.length > 0}
				<DragDropProvider
					sensors={implicitDragSensors}
					onDragStart={handleNormalDragStart}
					onDragEnd={handleNormalPinnedDragEnd}
				>
					{#each pinnedLocalOrder as chatId, idx (chatId)}
						{@const chat = pinnedById.get(chatId)}
					{#if chat}
						{@const sortable = createSortable({ id: chat.id, index: idx, group: 'pinned-normal' })}
						{@const attach = sortable.attach as unknown as Action}
						<div use:attach>
							<SidebarChatItem
								session={chat}
								{selectedChatId}
								{currentTime}
								{isMobile}
								isPinned={true}
								isArchived={false}
								{isMultiSelectMode}
								isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
								{onEnterReorderMode}
								{onEnterMultiSelect}
								{onMultiSelectToggle}
								{hasPinnedChats}
							/>
						</div>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}
		{#if isFiltered}
			{#each normal as gs (gs.id)}
				<SidebarChatItem
					session={gs}
					{selectedChatId}
					{currentTime}
					{isMobile}
					isPinned={false}
					isArchived={false}
					{isMultiSelectMode}
					isMultiSelected={isMultiSelected?.(gs.id) ?? false}
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
						{onEnterReorderMode}
					{onEnterMultiSelect}
					{onMultiSelectToggle}
					{hasPinnedChats}
				/>
			{/each}
		{:else if normalLocalOrder.length > 0}
			<DragDropProvider
				sensors={implicitDragSensors}
				onDragStart={handleNormalDragStart}
				onDragEnd={handleNormalNormalDragEnd}
			>
				{#each normalLocalOrder as chatId, idx (chatId)}
					{@const chat = normalById.get(chatId)}
					{#if chat}
						{@const sortable = createSortable({ id: chat.id, index: idx, group: 'normal-normal' })}
						{@const attach = sortable.attach as unknown as Action}
						<div use:attach>
							<SidebarChatItem
								session={chat}
								{selectedChatId}
								{currentTime}
								{isMobile}
								isPinned={false}
								isArchived={false}
								{isMultiSelectMode}
								isMultiSelected={isMultiSelected?.(chat.id) ?? false}
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
									{onEnterReorderMode}
								{onEnterMultiSelect}
								{onMultiSelectToggle}
								{hasPinnedChats}
							/>
						</div>
					{/if}
				{/each}
			</DragDropProvider>
		{/if}
		{#each archived as gs (gs.id)}
			<SidebarChatItem
				session={gs}
				{selectedChatId}
				{currentTime}
				{isMobile}
				isPinned={false}
				isArchived={true}
				{isMultiSelectMode}
				isMultiSelected={isMultiSelected?.(gs.id) ?? false}
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
					{onEnterReorderMode}
				{onEnterMultiSelect}
				{onMultiSelectToggle}
				{hasPinnedChats}
			/>
		{/each}
	</div>
{/if}
