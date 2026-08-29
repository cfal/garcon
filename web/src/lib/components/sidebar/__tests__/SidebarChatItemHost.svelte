<script lang="ts">
	import SidebarChatItem from '../SidebarChatItem.svelte';
	import { setAppShell, setModelCatalog } from '$lib/context';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import type { SidebarDisplayOptions } from '../sidebar-display-options';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { WorkspaceWindowEdge } from '$lib/workspace/surface-types.js';

	interface SidebarChatItemHostProps {
		session: ChatSessionRecord;
		selectedChatId?: string | null;
		currentTime?: Date;
		isPinned?: boolean;
		isArchived?: boolean;
		isMobile?: boolean;
		isMultiSelectMode?: boolean;
		enableNativeDrag?: boolean;
		displayOptions?: SidebarDisplayOptions;
		onTagClick?: (tag: string) => void;
		onManageTags?: (chat: ChatSessionRecord) => void;
		onEnterMultiSelect?: (chatId: string) => void;
		onMoveToTop?: () => void;
		onMoveToBottom?: () => void;
		onForkChat?: (sourceChatId: string) => void;
		onOpenInNewWindow?: (chatId: string, edge?: WorkspaceWindowEdge) => void;
		newWindowBlocked?: boolean;
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
		isMultiSelectMode = false,
		enableNativeDrag = true,
		displayOptions = {
			groupByProject: false,
			groupNestedProjectPaths: false,
			chatItemLayout: 'default',
			sortMode: 'manual',
		},
		onTagClick,
		onManageTags,
		onEnterMultiSelect,
		onMoveToTop,
		onMoveToBottom,
		onForkChat = () => {},
		onOpenInNewWindow,
		newWindowBlocked = false,
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

	setWorkspaceWindowDndTestContext();
</script>

<SidebarChatItem
	{session}
	{selectedChatId}
	{currentTime}
	{isPinned}
	{isArchived}
	{isMobile}
	{isMultiSelectMode}
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
	{onOpenInNewWindow}
	{newWindowBlocked}
/>
