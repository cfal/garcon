<script lang="ts">
	import { type SidebarGroupingSelection } from '$lib/sidebar/display/sidebar-preferences';

	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	setExecutorsTestContext();
	import { untrack } from 'svelte';
	import Sidebar from '../Sidebar.svelte';
	import SidebarDisplayDialog from '../SidebarDisplayDialog.svelte';
	import { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import { TYPOGRAPHY_DEFAULTS } from '$lib/theme/typography.js';
	import SidebarSearchDialogs from '../search/SidebarSearchDialogs.svelte';
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
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
	import type { ReorderChatRequest } from '$shared/chat-order-contracts';
	import type { ChatSearchSort } from '$shared/chat-search';
	import type {
		LocalSettingsStore,
		SidebarInactivityDuration,
	} from '$lib/stores/local-settings.svelte';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

	interface MobileSidebarLifecycleHostProps {
		chats?: ChatSessionRecord[];
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		initialOpen?: boolean;
		autoLoadSavedSearches?: boolean;
		sidebarGroupingFields?: SidebarGroupingSelection[];
		sidebarNestDelegatedChats?: boolean;
		sidebarSeparateArchivedBranches?: boolean;
		sidebarInactivityDuration?: SidebarInactivityDuration;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: ChatItemLayout;
		sidebarShowProjectPath?: boolean;
		collapsedProjectKeys?: Set<string>;
		writeOrder?: (request: ReorderChatRequest) => Promise<unknown>;
	}

	let {
		chats = [],
		selectedChatId = null,
		sidebarSearch,
		initialOpen = true,
		autoLoadSavedSearches = true,
		sidebarGroupingFields = [{ field: 'project', enabled: true }],
		sidebarNestDelegatedChats = false,
		sidebarSeparateArchivedBranches = false,
		sidebarInactivityDuration = '3-days',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'detailed',
		sidebarShowProjectPath = false,
		collapsedProjectKeys = new Set<string>(),
		writeOrder = async () => {},
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
			getSearchResultSort: () => 'relevance',
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
	let displayOpen = $state(false);
	let displayReturnFocus = $state<(() => void) | undefined>();
	let sidebarSearchResultSort = $state<ChatSearchSort>('relevance');

	// Mirrors the AppShell drawer-close effect that resets the search
	// dialog cluster whenever the mobile drawer is closed.
	$effect(() => {
		if (!sidebarOpen) sidebarSearchContext.resetDialogs();
	});

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
		...TYPOGRAPHY_DEFAULTS,
		sidebarWidth: 320,
		setSidebarDisplay: ((value) => {
			sidebarGroupingFields = value.sidebarGroupingFields;
			sidebarNestDelegatedChats = value.sidebarNestDelegatedChats;
			sidebarSeparateArchivedBranches = value.sidebarSeparateArchivedBranches;
			sidebarInactivityDuration = value.sidebarInactivityDuration;
			sidebarGroupNestedProjectPaths = value.sidebarGroupNestedProjectPaths;
			sidebarChatItemLayout = value.sidebarChatItemLayout;
			sidebarShowProjectPath = value.sidebarShowProjectPath;
		}) satisfies LocalSettingsStore['setSidebarDisplay'],
		sidebarSortMode: 'manual',
		get sidebarNestDelegatedChats() {
			return sidebarNestDelegatedChats;
		},
		get sidebarSeparateArchivedBranches() {
			return sidebarSeparateArchivedBranches;
		},
		get sidebarGroupingFields() {
			return sidebarGroupingFields;
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
		get sidebarShowProjectPath() {
			return sidebarShowProjectPath;
		},
		get sidebarSearchResultSort() {
			return sidebarSearchResultSort;
		},
		set(key: 'sidebarSearchResultSort', value: ChatSearchSort) {
			if (key === 'sidebarSearchResultSort') sidebarSearchResultSort = value;
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
		pruneGroupChoices() {},
	} as never);
	setSidebarSearch(sidebarSearchContext);

	setModelCatalog({
		forExecutor() {
			return this;
		},
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
	const projectionInput = $derived({
		allChats: chats,
		matchingChatIds: sidebarSearchContext.isFiltered
			? new Set(sidebarSearchContext.filteredChats.map((chat) => chat.id))
			: undefined,
		groupingFields: sidebarGroupingFields,
		nestDelegatedChats: sidebarNestDelegatedChats,
		separateArchivedBranches: sidebarSeparateArchivedBranches,
		currentTime: new Date('2025-01-02T00:00:00.000Z'),
		inactivityDuration: sidebarInactivityDuration,
		sortMode: 'manual' as const,
		pinnedInsertPosition: 'top' as const,
		groupNestedProjectPaths: sidebarGroupNestedProjectPaths,
		collapsedProjectKeys,
	});
	const reorder = new SidebarOrderController({
		get input() {
			return projectionInput;
		},
		write: async (request) => {
			await writeOrder(request);
			return { success: true, chatId: request.chatId, orderGroup: 'normal', changed: true };
		},
		refresh: async () => true,
		sort: async () => ({ changed: false }),
		onError: () => {},
	});
</script>

<button type="button" onclick={() => (sidebarOpen = true)}>Open sidebar</button>
<button type="button" onclick={() => (sidebarOpen = false)}>Close sidebar</button>

<SidebarSearchDialogs {chats} onSelectResult={() => {}} />

{#if displayOpen}
	<SidebarDisplayDialog onClose={() => (displayOpen = false)} returnFocus={displayReturnFocus} />
{/if}

{#if sidebarOpen}
	<Sidebar
		{reorder}
		onShowDisplay={(returnFocus) => {
			displayReturnFocus = returnFocus;
			displayOpen = true;
		}}
		projection={reorder.projection}
		{chats}
		{selectedChatId}
		isLoading={false}
		rosterReady={true}
		isMobile={true}
		onChatSelect={() => {}}
		onNewChat={() => {}}
		onNewProjectChat={() => {}}
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
		onShowPreambles={() => {}}
		onShowSnippets={() => {}}
		onShowUsage={() => {}}
		onShowSettings={() => {}}
		newWindowEdges={workspaceSplitAdmissions()}
	/>
{/if}
