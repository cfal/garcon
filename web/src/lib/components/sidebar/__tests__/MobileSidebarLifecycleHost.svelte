<script lang="ts">
	import { untrack } from 'svelte';
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

	interface MobileSidebarLifecycleHostProps {
		chats?: ChatSessionRecord[];
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		initialOpen?: boolean;
		autoLoadSavedSearches?: boolean;
		sidebarGroupByProject?: boolean;
		sidebarCompactChatItems?: boolean;
		collapsedProjectKeys?: Set<string>;
	}

	let {
		chats = [],
		selectedChatId = null,
		sidebarSearch,
		initialOpen = true,
		autoLoadSavedSearches = true,
		sidebarGroupByProject = false,
		sidebarCompactChatItems = false,
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
	setLocalSettings({
		get sidebarGroupByProject() {
			return sidebarGroupByProject;
		},
		get sidebarCompactChatItems() {
			return sidebarCompactChatItems;
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
		onShowSettings={() => {}}
	/>
{/if}
