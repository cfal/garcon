<script lang="ts">
	import SidebarChatItem from '../SidebarChatItem.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { SidebarDisplayOptions } from '../sidebar-display-options';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarChatItemHostProps {
		session: ChatSessionRecord;
		selectedChatId?: string | null;
		currentTime?: Date;
		isPinned?: boolean;
		isArchived?: boolean;
		isMobile?: boolean;
		enableNativeDrag?: boolean;
		displayOptions?: SidebarDisplayOptions;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chatId: string, currentTags: string[]) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onForkChat?: (sourceChatId: string) => void;
		supportsFork?: boolean;
		supportsForkWhileRunning?: boolean;
	}

	let {
		session,
		selectedChatId = null,
		currentTime = new Date('2025-01-01T03:00:00.000Z'),
		isPinned = false,
		isArchived = false,
		isMobile = false,
		enableNativeDrag = true,
		displayOptions = {
			groupByProject: false,
			groupNestedProjectPaths: false,
			compactChatItems: false,
		},
		onTagClick,
		onManageTags,
		onEnterMultiSelect,
		onMoveToTop,
		onMoveToBottom,
		onForkChat = () => {},
		supportsFork = true,
		supportsForkWhileRunning = false,
	}: SidebarChatItemHostProps = $props();

	setAppShell({
		onSidebarRecenterRequested() {
			return () => {};
		},
	} as never);

	setModelCatalog({
		supportsFork() {
			return supportsFork;
		},
		supportsForkWhileRunning() {
			return supportsForkWhileRunning;
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

<SidebarChatItem
	{session}
	{selectedChatId}
	{currentTime}
	{isPinned}
	{isArchived}
	{isMobile}
	{enableNativeDrag}
	{displayOptions}
	onChatSelect={() => {}}
	onDeleteChat={() => {}}
	onStartRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	onShowDetails={() => {}}
	{onForkChat}
	onShareChat={() => {}}
	{onTagClick}
	{onManageTags}
	{onEnterMultiSelect}
	{onMoveToTop}
	{onMoveToBottom}
/>
