<script lang="ts">
	import SidebarChatItem from '../SidebarChatItem.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatItemHarnessProps {
		session: ChatSessionRecord;
		selectedChatId?: string | null;
		isPinned?: boolean;
		isArchived?: boolean;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
	}

	let {
		session,
		selectedChatId = null,
		isPinned = false,
		isArchived = false,
		onTagClick,
		onManageTags,
	}: SidebarChatItemHarnessProps = $props();

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

<SidebarChatItem
	{session}
	{selectedChatId}
	currentTime={new Date('2025-01-01T00:00:00.000Z')}
	{isPinned}
	{isArchived}
	onChatSelect={() => {}}
	onDeleteChat={() => {}}
	onStartRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	onShowDetails={() => {}}
	onForkChat={() => {}}
	onShareChat={() => {}}
	{onTagClick}
	{onManageTags}
/>
