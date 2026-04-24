<script lang="ts">
	import WorkspaceGroup from '../WorkspaceGroup.svelte';
	import { setAppShell, setModelCatalog, setSplitLayout } from '$lib/context';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { SessionProvider } from '$lib/types/app';

	const noopChat = (_chatId: string) => {};
	const noopDelete = (_chatId: string, _title: string, _provider: SessionProvider) => {};
	const noopRename = (_chatId: string, _name: string) => {};
	const noopPinned = (_chatId: string) => {};
	const noopArchive = (_chatId: string) => {};
	const noopDetails = (_chatId: string, _title: string) => {};
	const noopFork = (_sourceChatId: string) => {};
	const noopShare = (_chatId: string, _title: string) => {};

	interface WorkspaceGroupHarnessProps {
		workspaceName?: string;
		chats?: ChatSessionRecord[];
		selectedChatId?: string | null;
		currentTime?: Date;
		onChatSelect?: (chatId: string) => void;
		onDeleteChat?: (chatId: string, title: string, provider: SessionProvider) => void;
		onStartRenameChat?: (chatId: string, name: string) => void;
		onTogglePinned?: (chatId: string) => void;
		onToggleArchive?: (chatId: string) => void;
		onShowDetails?: (chatId: string, title: string) => void;
		onForkChat?: (sourceChatId: string) => void;
		onShareChat?: (chatId: string, title: string) => void;
	}

	let {
		workspaceName = 'test-workspace',
		chats = [],
		selectedChatId = null,
		currentTime = new Date('2025-01-01T00:00:00.000Z'),
		onChatSelect = noopChat,
		onDeleteChat = noopDelete,
		onStartRenameChat = noopRename,
		onTogglePinned = noopPinned,
		onToggleArchive = noopArchive,
		onShowDetails = noopDetails,
		onForkChat = noopFork,
		onShareChat = noopShare,
	}: WorkspaceGroupHarnessProps = $props();

	// Set up minimal context providers for the component.
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

<WorkspaceGroup
	{workspaceName}
	{chats}
	{selectedChatId}
	{currentTime}
	{onChatSelect}
	{onDeleteChat}
	{onStartRenameChat}
	{onTogglePinned}
	{onToggleArchive}
	{onShowDetails}
	{onForkChat}
	{onShareChat}
/>
