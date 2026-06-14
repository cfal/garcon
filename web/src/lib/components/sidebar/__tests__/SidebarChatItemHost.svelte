<script lang="ts">
	import SidebarChatItem from '../SidebarChatItem.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatItemHostProps {
		session: ChatSessionRecord;
		selectedChatId?: string | null;
		currentTime?: Date;
		isPinned?: boolean;
		isArchived?: boolean;
		isMobile?: boolean;
		enableNativeDrag?: boolean;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onReloadChat?: (chatId: string) => void;
	}

	let {
		session,
		selectedChatId = null,
		currentTime = new Date('2025-01-01T03:00:00.000Z'),
		isPinned = false,
		isArchived = false,
		isMobile = false,
		enableNativeDrag = true,
		onTagClick,
		onManageTags,
		onReloadChat,
	}: SidebarChatItemHostProps = $props();

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
	{currentTime}
	{isPinned}
	{isArchived}
	{isMobile}
	{enableNativeDrag}
	onChatSelect={() => {}}
	onDeleteChat={() => {}}
	onStartRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	onShowDetails={() => {}}
	onForkChat={() => {}}
	{onReloadChat}
	onShareChat={() => {}}
	{onTagClick}
	{onManageTags}
/>
