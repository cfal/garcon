<script lang="ts">
	import SidebarVirtualSortableChatList from '../SidebarVirtualSortableChatList.svelte';
	import {
		SidebarChatReorderState,
		type SidebarChatOrderMap,
	} from '../sidebar-chat-reorder-state.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { SidebarVirtualChatRow, SidebarVirtualRow } from '../sidebar-virtual-chat-list';
	import type { SidebarDisplayOptions } from '../sidebar-display-options';
	import type { SidebarChatReorderRequest } from '../sidebar-chat-reorder-state.svelte';

	interface SidebarVirtualSortableChatListHostProps {
		rows: SidebarVirtualRow[];
		selectedChatId?: string | null;
		isMobile?: boolean;
		isFiltered?: boolean;
		displayOptions?: SidebarDisplayOptions;
		rowHeight?: number;
		onRegisterRecenter?: (callback: () => void) => void;
		onPersistReorder?: (request: SidebarChatReorderRequest) => void;
		onToggleProjectCollapsed?: (projectKey: string) => void;
	}

	let {
		rows,
		selectedChatId = null,
		isMobile = false,
		isFiltered = false,
		displayOptions = { groupByProject: false, compactChatItems: false },
		rowHeight,
		onRegisterRecenter,
		onPersistReorder = () => {},
		onToggleProjectCollapsed,
	}: SidebarVirtualSortableChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	function isChatRow(row: SidebarVirtualRow): row is SidebarVirtualChatRow {
		return row.type === 'chat';
	}

	let visibleOrders = $derived.by<SidebarChatOrderMap>(() => ({
		pinned: rows
			.filter(isChatRow)
			.filter((row) => row.list === 'pinned')
			.map((row) => row.chat.id),
		normal: rows
			.filter(isChatRow)
			.filter((row) => row.list === 'normal')
			.map((row) => row.chat.id),
		archived: rows
			.filter(isChatRow)
			.filter((row) => row.list === 'archived')
			.map((row) => row.chat.id),
	}));

	const reorder = new SidebarChatReorderState({
		get visibleOrders() {
			return visibleOrders;
		},
	});

	setAppShell({
		onSidebarRecenterRequested(callback: () => void) {
			onRegisterRecenter?.(callback);
			return () => {};
		},
	} as never);

	setModelCatalog({
		supportsFork() {
			return true;
		},
		supportsForkWhileRunning() {
			return false;
		},
		supportsUpdateProjectPath() {
			return true;
		},
	} as never);

	setSplitLayout({
		isEnabled: false,
		draggedChatId: null,
		startDrag() {},
		endDrag() {},
	} as never);
</script>

<div
	bind:this={viewportRef}
	data-testid="virtual-sidebar-viewport"
	style="height:640px; overflow-y:auto;"
>
	<SidebarVirtualSortableChatList
		{rows}
		{viewportRef}
		{selectedChatId}
		currentTime={new Date('2025-01-01T03:00:00.000Z')}
		{isMobile}
		{isFiltered}
		{displayOptions}
		{rowHeight}
		{reorder}
		{onPersistReorder}
		{onToggleProjectCollapsed}
		onChatSelect={() => {}}
		onDeleteChat={() => {}}
		onStartRenameChat={() => {}}
		onTogglePinned={() => {}}
		onToggleArchive={() => {}}
		onShowDetails={() => {}}
		onForkChat={() => {}}
		onShareChat={() => {}}
	/>
</div>
