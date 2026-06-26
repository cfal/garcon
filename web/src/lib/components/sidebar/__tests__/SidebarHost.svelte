<script lang="ts">
	import Sidebar from '../Sidebar.svelte';
	import {
		setAppShell,
		setModelCatalog,
		setNotifications,
		setReadReceiptOutbox,
		setSidebarSearch,
		setSplitLayout,
	} from '$lib/context';
	import {
		createSidebarSearchStore,
		type SidebarSearchStore,
	} from '$lib/stores/sidebar-search.svelte';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface SidebarHostProps {
		chats?: ChatSessionRecord[];
		isMobile?: boolean;
		notifications?: unknown;
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		autoLoadSavedSearches?: boolean;
	}

	let {
		chats = [],
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
	}: SidebarHostProps = $props();

	setAppShell({
		onSidebarRecenterRequested() {
			return () => {};
		},
		onRenameSelectedChatRequested() {
			return () => {};
		},
		onDeleteSelectedChatRequested() {
			return () => {};
		},
		onSidebarSearchRequested() {
			return () => {};
		},
		projectBasePath: '/workspace',
		requestSidebarRecenterToSelected() {},
		requestComposerFocus() {},
	} as never);

	setReadReceiptOutbox({
		markChatsReadNow() {
			return Promise.resolve();
		},
	} as never);

	function getNotificationsContext(): unknown {
		return (
			notifications ?? {
				error() {},
				info() {},
			}
		);
	}

	setNotifications(getNotificationsContext() as never);

	function createSidebarSearchContext(): SidebarSearchStore {
		return sidebarSearch ?? createDefaultSidebarSearchContext();
	}

	function createDefaultSidebarSearchContext(): SidebarSearchStore {
		return createSidebarSearchStore({
			getChats: () => chats,
			getSelectedChatId: () => selectedChatId,
			notifyError: (message) => {
				(getNotificationsContext() as { error?: (message: string) => void }).error?.(message);
			},
		});
	}

	const sidebarSearchContext = createSidebarSearchContext();
	setSidebarSearch(sidebarSearchContext);

	setModelCatalog({
		supportsFork() {
			return true;
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

	$effect(() => {
		if (!autoLoadSavedSearches) return;
		void sidebarSearchContext.loadSavedSearches();
	});
</script>

<Sidebar
	{chats}
	{selectedChatId}
	isLoading={false}
	{isMobile}
	onChatSelect={() => {}}
	onNewChat={() => {}}
	onQuietRefresh={() => Promise.resolve()}
	onRequestDeleteChat={() => {}}
	onRequestRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	onShowDetails={() => {}}
	onForkChat={() => {}}
	onShareChat={() => {}}
	onManageTags={() => {}}
	onShowSettings={() => {}}
/>
