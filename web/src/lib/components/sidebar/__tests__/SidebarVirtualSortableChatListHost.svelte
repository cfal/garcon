<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { onMount, untrack } from 'svelte';
	import SidebarVirtualSortableChatList from '../SidebarVirtualSortableChatList.svelte';
	import { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import { setAppShell, setModelCatalog, setWorkspaceWindowDnd } from '$lib/context';
	import type {
		SidebarVirtualChatRow,
		SidebarVirtualRow,
	} from '../../../sidebar/display/sidebar-virtual-chat-list';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../../../sidebar/display/sidebar-display-options';
	import type { SidebarChatReorderRequest } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
	import {
		resolveUnmeasuredWorkspaceSplit,
		workspaceSplitAdmissions,
	} from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';
	import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';
	import type { ExecutorSnapshot } from '$shared/executors';

	interface SidebarVirtualSortableChatListHostProps {
		rows: SidebarVirtualRow[];
		executors?: readonly ExecutorSnapshot[];
		pendingChatIds?: string[];
		selectedChatId?: string | null;
		isMobile?: boolean;
		isFiltered?: boolean;
		displayOptions?: Partial<SidebarDisplayOptions>;
		rowHeight?: number;
		viewportAttached?: boolean;
		viewportOverride?: HTMLElement;
		viewportHeight?: number;
		onRegisterRecenter?: (callback: () => void) => void;
		onRegisterReorder?: (reorder: SidebarOrderController) => void;
		onPersistReorder?: (request: SidebarChatReorderRequest) => void;
		onWorkspaceDragEnd?: (chatId: string) => void;
		onRegisterWindowDnd?: (windowDnd: WorkspaceWindowDndController) => void;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		rows,
		executors,
		pendingChatIds = [],
		selectedChatId = null,
		isMobile = false,
		isFiltered = false,
		displayOptions: displayOptionsInput = {},
		rowHeight,
		viewportAttached = true,
		viewportOverride,
		viewportHeight = 640,
		onRegisterRecenter,
		onRegisterReorder,
		onPersistReorder = () => {},
		onWorkspaceDragEnd,
		onRegisterWindowDnd,
		onToggleProjectCollapsed,
		onSortChatOrder = () => {},
	}: SidebarVirtualSortableChatListHostProps = $props();
	untrack(() => setExecutorsTestContext(executors));

	let viewportRef = $state<HTMLElement | null>(null);
	let displayOptions = $derived({
		...DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		groupingFields: [],
		nestDelegatedChats: false,
		sortMode: 'manual' as const,
		...displayOptionsInput,
	});
	function isChatRow(row: SidebarVirtualRow): row is SidebarVirtualChatRow {
		return row.type === 'chat';
	}

	const reorder = new SidebarOrderController({
		get input() {
			return {
				allChats: rows.filter(isChatRow).map((row) => row.chat),
				...displayOptions,
				currentTime: new Date('2025-01-01T03:00:00.000Z'),
			};
		},
		write: async ({ chatId }) => ({ success: true, chatId, orderGroup: 'normal', changed: true }),
		refresh: async () => true,
		sort: async () => ({ changed: false }),
		onError: () => {},
	});
	onMount(() => onRegisterReorder?.(reorder));

	setAppShell({
		onSidebarRecenterRequested(callback: () => void) {
			onRegisterRecenter?.(callback);
			return () => {};
		},
	} as never);

	setModelCatalog({
		forExecutor() {
			return this;
		},
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
	style="height:{viewportHeight}px; overflow-y:auto;"
>
	<SidebarVirtualSortableChatList
		{rows}
		viewportRef={viewportAttached ? viewportOverride ?? viewportRef : null}
		{viewportHeight}
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
		actions={{
			onChatSelect: () => {},
			onDeleteChat: () => {},
			onStartRenameChat: () => {},
			onTogglePinned: () => {},
			onToggleArchive: () => {},
			isArchiveMutationPending: (id) => pendingChatIds.includes(id),
			onShowDetails: () => {},
			onForkChat: () => {},
			onShareChat: () => {},
		}}
	/>
</div>
