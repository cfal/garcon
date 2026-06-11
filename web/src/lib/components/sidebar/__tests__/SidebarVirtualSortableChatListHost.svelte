<script lang="ts">
	import SidebarVirtualSortableChatList from '../SidebarVirtualSortableChatList.svelte';
	import { SidebarChatReorderState, type SidebarChatOrderMap } from '../sidebar-chat-reorder-state.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { SidebarVirtualChatRow } from '../sidebar-virtual-chat-list';
	import type { SidebarChatReorderRequest } from '../sidebar-chat-reorder-state.svelte';

	interface SidebarVirtualSortableChatListHostProps {
		rows: SidebarVirtualChatRow[];
		selectedChatId?: string | null;
		isMobile?: boolean;
		isFiltered?: boolean;
		rowHeight?: number;
		onRegisterRecenter?: (callback: () => void) => void;
		onPersistReorder?: (request: SidebarChatReorderRequest) => void;
	}

	let {
		rows,
		selectedChatId = null,
		isMobile = false,
		isFiltered = false,
		rowHeight,
		onRegisterRecenter,
		onPersistReorder = () => {},
	}: SidebarVirtualSortableChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let visibleOrders = $derived.by<SidebarChatOrderMap>(() => ({
		pinned: rows.filter((row) => row.list === 'pinned').map((row) => row.chat.id),
		normal: rows.filter((row) => row.list === 'normal').map((row) => row.chat.id),
		archived: rows.filter((row) => row.list === 'archived').map((row) => row.chat.id),
	}));

	const reorder = new SidebarChatReorderState({
		get visibleOrders() { return visibleOrders; },
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
		{rowHeight}
		{reorder}
		onPersistReorder={onPersistReorder}
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
