<script lang="ts">
	import { untrack } from 'svelte';
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
	} from '$lib/stores/local-settings.svelte';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';

	interface MobileSidebarLifecycleHostProps {
		chats?: ChatSessionRecord[];
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		initialOpen?: boolean;
		autoLoadSavedSearches?: boolean;
		sidebarGrouping?: SidebarChatGrouping;
		sidebarInactivityDuration?: SidebarInactivityDuration;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: SidebarChatItemLayout;
		collapsedProjectKeys?: Set<string>;
	}

	let {
		chats = [],
		selectedChatId = null,
		sidebarSearch,
		initialOpen = true,
		autoLoadSavedSearches = true,
		sidebarGrouping = 'project',
		sidebarInactivityDuration = '3-days',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'default',
		collapsedProjectKeys = new Set<string>(),
	}: MobileSidebarLifecycleHostProps = $props();

	const notifications = {
		error(_message: string) {},
		info(_message: string) {},
	};
	function createSidebarSearchContext(): SidebarSearchStore {
		return sidebarSearch ?? createDefaultSidebarSearchContext();
	}

	function createDefaultSidebarSearchContext(): SidebarSearchStore {
		return createSidebarSearchStore({
			getTranscriptSearchEnabled: () => true,
			getChats: () => chats,
			getSelectedChatId: () => selectedChatId,
			notifyError: (message) => notifications.error(message),
		});
	}

	function initialSidebarOpen(): boolean {
		return initialOpen;
	}

	const sidebarSearchContext = createSidebarSearchContext();

	let sidebarOpen = $state(initialSidebarOpen());

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

	setNotifications(notifications as never);
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
		toggle(_key: 'sidebarGroupNestedProjectPaths') {
			sidebarGroupNestedProjectPaths = !sidebarGroupNestedProjectPaths;
		},
		set(key: 'sidebarGrouping' | 'sidebarChatItemLayout', value: string) {
			if (key === 'sidebarGrouping') {
				sidebarGrouping = value as SidebarChatGrouping;
				return;
			}
			sidebarChatItemLayout = value as SidebarChatItemLayout;
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
		untrack(() => {
			void sidebarSearchContext.loadSavedSearches();
		});
	});
</script>

<button type="button" onclick={() => (sidebarOpen = true)}>Open sidebar</button>
<button type="button" onclick={() => (sidebarOpen = false)}>Close sidebar</button>

{#if sidebarOpen}
	<Sidebar
		{chats}
		{selectedChatId}
		isLoading={false}
		isMobile={true}
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
		onShowScheduledPrompts={() => {}}
		onShowSettings={() => {}}
		newWindowBlocked={false}
	/>
{/if}
