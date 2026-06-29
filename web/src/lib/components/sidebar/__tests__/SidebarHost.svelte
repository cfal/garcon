<script lang="ts">
	import Sidebar from '../Sidebar.svelte';
	import {
		setAppShell,
		setLocalSettings,
		setModelCatalog,
		setNotifications,
		setReadReceiptOutbox,
		setSidebarProjectCollapse,
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
		sidebarGroupByProject?: boolean;
		sidebarCompactChatItems?: boolean;
		collapsedProjectKeys?: Set<string>;
	}

	let {
		chats = [],
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
		sidebarGroupByProject = false,
		sidebarCompactChatItems = false,
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
	setLocalSettings({
		get sidebarGroupByProject() {
			return sidebarGroupByProject;
		},
		get sidebarCompactChatItems() {
			return sidebarCompactChatItems;
		},
		toggle(key: 'sidebarGroupByProject' | 'sidebarCompactChatItems') {
			if (key === 'sidebarGroupByProject') {
				sidebarGroupByProject = !sidebarGroupByProject;
				return;
			}
			sidebarCompactChatItems = !sidebarCompactChatItems;
		},
	} as never);

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
