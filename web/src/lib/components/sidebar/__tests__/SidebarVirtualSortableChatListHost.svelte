<script lang="ts">
	import { onMount } from 'svelte';
	import SidebarVirtualSortableChatList from '../SidebarVirtualSortableChatList.svelte';
	import {
		SidebarChatReorderState,
		type SidebarChatOrderMap,
	} from '../sidebar-chat-reorder-state.svelte';
	import { setAppShell, setModelCatalog, setWorkspaceWindowDnd } from '$lib/context';
	import type { SidebarVirtualChatRow, SidebarVirtualRow } from '../sidebar-virtual-chat-list';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../sidebar-display-options';
	import type { SidebarChatReorderRequest } from '../sidebar-chat-reorder-state.svelte';
	import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
	import {
		resolveUnmeasuredWorkspaceSplit,
		workspaceSplitAdmissions,
	} from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';
	import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';

	interface SidebarVirtualSortableChatListHostProps {
		rows: SidebarVirtualRow[];
		selectedChatId?: string | null;
		isMobile?: boolean;
		isFiltered?: boolean;
		displayOptions?: Partial<SidebarDisplayOptions>;
		rowHeight?: number;
		viewportAttached?: boolean;
		onRegisterRecenter?: (callback: () => void) => void;
		onRegisterReorder?: (reorder: SidebarChatReorderState) => void;
		onPersistReorder?: (request: SidebarChatReorderRequest) => void;
		onWorkspaceDragEnd?: (chatId: string) => void;
		onRegisterWindowDnd?: (windowDnd: WorkspaceWindowDndController) => void;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		rows,
		selectedChatId = null,
		isMobile = false,
		isFiltered = false,
		displayOptions: displayOptionsInput = {},
		rowHeight,
		viewportAttached = true,
		onRegisterRecenter,
		onRegisterReorder,
		onPersistReorder = () => {},
		onWorkspaceDragEnd,
		onRegisterWindowDnd,
		onToggleProjectCollapsed,
		onSortChatOrder = () => {},
	}: SidebarVirtualSortableChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let displayOptions = $derived({
		...DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		grouping: 'none' as const,
		...displayOptionsInput,
	});
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
	onMount(() => onRegisterReorder?.(reorder));

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

	class TestWorkspaceWindowDndController extends WorkspaceWindowDndController {
		override endDrag(): void {
			const chatId = this.payload?.kind === 'chat' ? this.payload.chatId : null;
			super.endDrag();
			if (chatId) onWorkspaceDragEnd?.(chatId);
		}
	}
	const windowDnd = new TestWorkspaceWindowDndController(
		createWorkspaceLayoutStore(),
		resolveUnmeasuredWorkspaceSplit,
	);
	setWorkspaceWindowDnd(windowDnd);
	onMount(() => onRegisterWindowDnd?.(windowDnd));
</script>

<div
	bind:this={viewportRef}
	data-testid="virtual-sidebar-viewport"
	style="height:640px; overflow-y:auto;"
>
	<SidebarVirtualSortableChatList
		{rows}
		viewportRef={viewportAttached ? viewportRef : null}
		{selectedChatId}
		currentTime={new Date('2025-01-01T03:00:00.000Z')}
		{isMobile}
		{isFiltered}
		{displayOptions}
		{rowHeight}
		{reorder}
		{onPersistReorder}
		{onSortChatOrder}
		{onToggleProjectCollapsed}
		newWindowEdges={workspaceSplitAdmissions()}
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
