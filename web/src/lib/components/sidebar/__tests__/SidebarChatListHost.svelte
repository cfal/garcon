<script lang="ts">
	import SidebarChatList from '../SidebarChatList.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { SidebarDisplayOptions } from '../sidebar-display-options';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatListHostProps {
		chats: ChatSessionRecord[];
		filteredChats?: ChatSessionRecord[];
		searchFilter?: string;
		selectedChatId?: string | null;
		isMobile?: boolean;
		displayOptions?: SidebarDisplayOptions;
		collapsedProjectKeys?: ReadonlySet<string>;
		onToggleProjectCollapsed?: (projectKey: string) => void;
		onQuickMove?: (
			list: ChatOrderList,
			chatId: string,
			target: ReorderQuickTarget,
			onSuccess?: () => void,
			onFailure?: () => void,
		) => void;
	}

	let {
		chats,
		filteredChats = chats,
		searchFilter = '',
		selectedChatId = null,
		isMobile = false,
		displayOptions = {
			groupByProject: false,
			groupNestedProjectPaths: false,
			compactChatItems: false,
		},
		collapsedProjectKeys = new Set<string>(),
		onToggleProjectCollapsed,
		onQuickMove = () => {},
	}: SidebarChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let internalCollapsedKeys = $state<ReadonlySet<string>>(new Set<string>());
	let effectiveCollapsedKeys = $derived(
		onToggleProjectCollapsed ? collapsedProjectKeys : internalCollapsedKeys,
	);

	$effect(() => {
		internalCollapsedKeys = new Set(collapsedProjectKeys);
	});

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

	setSplitLayout({
		isEnabled: false,
		startDrag() {},
		endDrag() {},
	} as never);
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
	/>
</div>
