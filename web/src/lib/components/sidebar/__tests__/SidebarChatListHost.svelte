<script lang="ts">
	import SidebarChatList from '../SidebarChatList.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { ChatOrderList, ReorderQuickTarget } from '$lib/api/chats';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatListHostProps {
		chats: ChatSessionRecord[];
		filteredChats?: ChatSessionRecord[];
		searchFilter?: string;
		selectedChatId?: string | null;
		isMobile?: boolean;
		isReorderMode?: boolean;
		onImmediateReorder?: (
			list: ChatOrderList,
			oldOrder: string[],
			newOrder: string[],
			onFailure?: () => void,
		) => void;
		onQuickMove?: (chatId: string, target: ReorderQuickTarget) => Promise<void> | void;
	}

	let {
		chats,
		filteredChats = chats,
		searchFilter = '',
		selectedChatId = null,
		isMobile = false,
		isReorderMode = false,
		onImmediateReorder = () => {},
		onQuickMove = () => {},
	}: SidebarChatListHostProps = $props();

	let viewportRef = $state<HTMLElement | null>(null);

	setAppShell({
		onSidebarRecenterRequested() {
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
		{isReorderMode}
		onEnterReorderMode={() => {}}
		onReorderGroup={() => {}}
		onChatSelect={() => {}}
		onDeleteChat={() => {}}
		onStartRenameChat={() => {}}
		onShowDetails={() => {}}
		onForkChat={() => {}}
		onShareChat={() => {}}
		onTogglePinned={() => {}}
		onToggleArchive={() => {}}
			{onImmediateReorder}
			{onQuickMove}
		/>
	</div>
