<script lang="ts">
	import { untrack } from 'svelte';
	import Sidebar from '../Sidebar.svelte';
	import SidebarSearchDialogs from '../SidebarSearchDialogs.svelte';
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
	import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import type {
		SidebarChatGrouping,
		SidebarInactivityDuration,
		SidebarSortMode,
	} from '$lib/stores/local-settings.svelte';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import type { ChatListDock } from '$lib/layout/desktop-layout.js';
	import type { ChatSearchSort } from '$shared/chat-search';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

	interface SidebarHostProps {
		chats?: ChatSessionRecord[];
		chatSessions?: ChatSessionsStore;
		isMobile?: boolean;
		notifications?: unknown;
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		autoLoadSavedSearches?: boolean;
		sidebarGrouping?: SidebarChatGrouping;
		sidebarInactivityDuration?: SidebarInactivityDuration;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: ChatItemLayout;
		chatListAutohide?: boolean;
		chatListAutohideAvailable?: boolean;
		chatListDock?: ChatListDock;
		reduceMotion?: boolean;
		collapsedProjectKeys?: Set<string>;
		sidebarSortMode?: SidebarSortMode;
		sidebarSearchResultSort?: ChatSearchSort;
		onQuietRefresh?: () => Promise<void> | void;
		onRequestRecenter?: () => void;
		onChatSelect?: (chatId: string) => void;
		onNewChat?: () => void;
	}

	let {
		chats = [],
		chatSessions,
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
		sidebarGrouping = 'project',
		sidebarInactivityDuration = '3-days',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'detailed',
		chatListAutohide = false,
		chatListAutohideAvailable = false,
		chatListDock = 'left',
		reduceMotion = false,
		collapsedProjectKeys = new Set<string>(),
		sidebarSortMode = 'manual',
		sidebarSearchResultSort = 'relevance',
		onQuietRefresh = () => Promise.resolve(),
		onRequestRecenter = () => {},
		onChatSelect = () => {},
		onNewChat = () => {},
	}: SidebarHostProps = $props();
	let displayedChats = $derived(chatSessions?.orderedChats ?? chats);

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
		get sidebarSearchResultSort() {
			return sidebarSearchResultSort;
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
				| 'sidebarSearchResultSort'
				| 'chatListAutohide'
				| 'chatListDock',
			value: string | boolean,
		) {
			if (key === 'sidebarGrouping') {
				sidebarGrouping = value as SidebarChatGrouping;
				return;
			}
			if (key === 'sidebarChatItemLayout') {
				sidebarChatItemLayout = value as ChatItemLayout;
				return;
			}
			if (key === 'sidebarSortMode') {
				sidebarSortMode = value as SidebarSortMode;
				return;
			}
			if (key === 'sidebarSearchResultSort') {
				sidebarSearchResultSort = value as ChatSearchSort;
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
			getSearchResultSort: () => 'relevance',
			getChats: () => displayedChats,
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

	setChatSessions(
		untrack(() => chatSessions) ??
			({
				get selectedChat() {
					return null;
				},
			} as never),
	);

	$effect(() => {
		if (!autoLoadSavedSearches) return;
		void sidebarSearchContext.loadSavedSearches();
	});
</script>

<Sidebar
	chats={displayedChats}
	{selectedChatId}
	isLoading={false}
	{isMobile}
	{onChatSelect}
	{onNewChat}
	{onQuietRefresh}
	onRequestDeleteChat={() => {}}
	onRequestRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	isArchiveMutationPending={(chatId) => chatSessions?.isArchiveMutationPending(chatId) ?? false}
	isChatOptimisticallyArchived={(chatId) =>
		chatSessions?.isChatOptimisticallyArchived(chatId) ?? false}
	startArchivingChats={(chatIds) =>
		chatSessions?.startArchivingChats(chatIds) ?? {
			chatIds: [],
			completion: Promise.resolve(),
		}}
	startUnarchivingChats={(chatIds) =>
		chatSessions?.startUnarchivingChats(chatIds) ?? {
			chatIds: [],
			completion: Promise.resolve(),
		}}
	onShowDetails={() => {}}
	onForkChat={() => {}}
	onShareChat={() => {}}
	onManageTags={() => {}}
	{chatListAutohideAvailable}
	onShowScheduledPrompts={() => {}}
	onShowPreambles={() => {}}
	onShowSettings={() => {}}
	newWindowEdges={workspaceSplitAdmissions()}
/>

<SidebarSearchDialogs chats={displayedChats} onSelectChat={onChatSelect} />
