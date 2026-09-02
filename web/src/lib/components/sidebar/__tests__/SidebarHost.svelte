<script lang="ts">
	import Sidebar from '../Sidebar.svelte';
	import {
		setAppShell,
		setLocalSettings,
		setMinuteClock,
		setModelCatalog,
		setNotifications,
		setReadReceiptOutbox,
		setRemoteSettings,
		setSidebarProjectCollapse,
		setChatSessions,
		setSidebarSearch,
	} from '$lib/context';
	import {
		createSidebarSearchStore,
		type SidebarSearchStore,
	} from '$lib/sidebar/search/sidebar-search-store.svelte.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type {
		SidebarChatGrouping,
		SidebarChatItemLayout,
	} from '$lib/stores/local-settings.svelte';
	import type { ChatListDock } from '$lib/layout/desktop-layout.js';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';

	interface SidebarHostProps {
		chats?: ChatSessionRecord[];
		isMobile?: boolean;
		notifications?: unknown;
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		autoLoadSavedSearches?: boolean;
		sidebarGrouping?: SidebarChatGrouping;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: SidebarChatItemLayout;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		chatListDock?: ChatListDock;
		reduceMotion?: boolean;
		collapsedProjectKeys?: Set<string>;
	}

	let {
		chats = [],
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
		sidebarGrouping = 'project',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'default',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		chatListDock = 'left',
		reduceMotion = false,
		collapsedProjectKeys = new Set<string>(),
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
	setRemoteSettings({
		snapshot: {
			features: {
				transcriptSearch: { enabled: true },
				agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true },
			},
		},
	} as never);
	setLocalSettings({
		get sidebarGrouping() {
			return sidebarGrouping;
		},
		get sidebarGroupNestedProjectPaths() {
			return sidebarGroupNestedProjectPaths;
		},
		get sidebarChatItemLayout() {
			return sidebarChatItemLayout;
		},
		get chatListAutohide() {
			return chatListAutohide;
		},
		get chatListDock() {
			return chatListDock;
		},
		get reduceMotion() {
			return reduceMotion;
		},
		toggle(_key: 'sidebarGroupNestedProjectPaths') {
			sidebarGroupNestedProjectPaths = !sidebarGroupNestedProjectPaths;
		},
		set(
			key:
				| 'sidebarGrouping'
				| 'sidebarChatItemLayout'
				| 'sidebarSortMode'
				| 'chatListAutohide'
				| 'chatListDock',
			value: string | boolean,
		) {
			if (key === 'sidebarGrouping') {
				sidebarGrouping = value as SidebarChatGrouping;
				return;
			}
			if (key === 'sidebarChatItemLayout') {
				sidebarChatItemLayout = value as SidebarChatItemLayout;
				return;
			}
			if (key === 'chatListAutohide') chatListAutohide = value as boolean;
			if (key === 'chatListDock') chatListDock = value as ChatListDock;
		},
	} as never);

	setMinuteClock({ currentTime: new Date('2025-01-02T00:00:00.000Z') } as never);

	setSidebarProjectCollapse({
		get collapsedProjectKeys() {
			return collapsedProjectKeys;
		},
		toggle(projectKey: string) {
			const next = new Set(collapsedProjectKeys);
			if (next.has(projectKey)) next.delete(projectKey);
			else next.add(projectKey);
			collapsedProjectKeys = next;
		},
		pruneToProjectKeys(projectKeys: Iterable<string>) {
			const allowed = new Set(projectKeys);
			collapsedProjectKeys = new Set(
				Array.from(collapsedProjectKeys).filter((projectKey) => allowed.has(projectKey)),
			);
		},
	} as never);

	function createSidebarSearchContext(): SidebarSearchStore {
		return sidebarSearch ?? createDefaultSidebarSearchContext();
	}

	function createDefaultSidebarSearchContext(): SidebarSearchStore {
		return createSidebarSearchStore({
			getTranscriptSearchEnabled: () => true,
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
		supportsForkWhileRunning() {
			return false;
		},
		supportsUpdateProjectPath() {
			return true;
		},
	} as never);

	setWorkspaceWindowDndTestContext();

	setChatSessions({
		get selectedChat() {
			return null;
		},
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
	{chatListAutohideAvailable}
	onShowScheduledPrompts={() => {}}
	onShowSettings={() => {}}
	newWindowBlocked={false}
/>
