<script lang="ts">
	import SidebarChatList from '../SidebarChatList.svelte';
	import { setAppShell, setModelCatalog } from '$lib/context';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import {
		DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		type SidebarDisplayOptions,
	} from '../sidebar-display-options';
	import type {
		PersistedChatOrderGroup,
		RelativeChatOrderPlacement,
	} from '$shared/chat-order-contracts';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatOrderSortKey } from '$shared/chat-order-sort';
	import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

	interface SidebarChatListHostProps {
		chats: ChatSessionRecord[];
		filteredChats?: ChatSessionRecord[];
		searchFilter?: string;
		onNewChat?: () => void;
		selectedChatId?: string | null;
		isMobile?: boolean;
		displayOptions?: Partial<SidebarDisplayOptions>;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onQuickMove?: (
			list: PersistedChatOrderGroup,
			chatId: string,
			placement: RelativeChatOrderPlacement,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
		onSortChatOrder?: (sortKey: ChatOrderSortKey) => void;
	}

	let {
		chats,
		filteredChats = chats,
		searchFilter = '',
		onNewChat,
		selectedChatId = null,
		isMobile = false,
		displayOptions: displayOptionsInput = {},
		collapsedProjectKeys = new Set<string>(),
		onToggleProjectCollapsed,
		onQuickMove = () => {},
		onSortChatOrder = () => {},
	}: SidebarChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let displayOptions = $derived({
		...DEFAULT_SIDEBAR_DISPLAY_OPTIONS,
		grouping: 'none' as const,
		...displayOptionsInput,
	});
	let internalCollapsedKeys = $derived<ReadonlySet<string>>(new Set(collapsedProjectKeys));
	let effectiveCollapsedKeys = $derived(
		onToggleProjectCollapsed ? collapsedProjectKeys : internalCollapsedKeys,
	);

	function handleProjectCollapseToggle(projectKey: string): void {
		if (onToggleProjectCollapsed) {
			onToggleProjectCollapsed(projectKey);
			return;
		}
		const next = new Set(internalCollapsedKeys);
		if (next.has(projectKey)) next.delete(projectKey);
		else next.add(projectKey);
		internalCollapsedKeys = next;
	}

	setAppShell({
		onSidebarRecenterRequested() {
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

	setWorkspaceWindowDndTestContext();
</script>

<div
	bind:this={viewportRef}
	data-testid="sidebar-list-viewport"
	style="height:640px; overflow-y:auto;"
>
	<SidebarChatList
		{viewportRef}
		{chats}
		{filteredChats}
		{selectedChatId}
		isLoading={false}
		{isMobile}
		currentTime={new Date('2025-01-01T03:00:00.000Z')}
		{searchFilter}
		{onNewChat}
		{displayOptions}
		collapsedProjectKeys={effectiveCollapsedKeys}
		onToggleProjectCollapsed={handleProjectCollapseToggle}
		onChatSelect={() => {}}
		onDeleteChat={() => {}}
		onStartRenameChat={() => {}}
		onShowDetails={() => {}}
		onForkChat={() => {}}
		onShareChat={() => {}}
		onTogglePinned={() => {}}
		onToggleArchive={() => {}}
		{onQuickMove}
		{onSortChatOrder}
		newWindowEdges={workspaceSplitAdmissions()}
	/>
</div>
