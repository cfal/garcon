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
		SidebarInactivityDuration,
		SidebarSortMode,
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
		sidebarInactivityDuration?: SidebarInactivityDuration;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: SidebarChatItemLayout;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		chatListDock?: ChatListDock;
		reduceMotion?: boolean;
		collapsedProjectKeys?: Set<string>;
		sidebarSortMode?: SidebarSortMode;
		onQuietRefresh?: () => Promise<void> | void;
		onRequestRecenter?: () => void;
	}

	let {
		chats = [],
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
		sidebarGrouping = 'project',
		sidebarInactivityDuration = '3-days',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'default',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		chatListDock = 'left',
		reduceMotion = false,
		collapsedProjectKeys = new Set<string>(),
		sidebarSortMode = 'manual',
		onQuietRefresh = () => Promise.resolve(),
		onRequestRecenter = () => {},
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
		requestSidebarRecenterToSelected() {
			onRequestRecenter();
		},
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
		get sidebarInactivityDuration() {
			return sidebarInactivityDuration;
		},
		get sidebarGroupNestedProjectPaths() {
			return sidebarGroupNestedProjectPaths;
		},
		get sidebarChatItemLayout() {
			return sidebarChatItemLayout;
		},
		get sidebarSortMode() {
			return sidebarSortMode;
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
			if (key === 'sidebarSortMode') {
				sidebarSortMode = value as SidebarSortMode;
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
	{onQuietRefresh}
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
