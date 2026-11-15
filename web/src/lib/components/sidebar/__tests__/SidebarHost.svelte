<script lang="ts">
	import {
		normalizeSidebarGroupingFields,
		type SidebarGroupingSelection,
	} from '$lib/sidebar/display/sidebar-preferences';

	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { localExecutor } from '$lib/executors/__tests__/fixtures';
	import type { ExecutorSnapshot } from '$shared/executors';
	import type { NewChatProjectTarget } from '$lib/chat/new-chat/new-chat-seed';
	import { untrack } from 'svelte';
	import Sidebar from '../Sidebar.svelte';
	import SidebarDisplayDialog from '../SidebarDisplayDialog.svelte';
	import { SidebarOrderController } from '$lib/sidebar/display/sidebar-order-controller.svelte';
	import * as api from '$lib/api/chats';
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
	import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import type {
		SidebarInactivityDuration,
		SidebarSortMode,
	} from '$lib/stores/local-settings.svelte';
	import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
	import type { ChatListDock } from '$lib/layout/desktop-layout.js';
	import type { ChatSearchSort } from '$shared/chat-search';
	import { setWorkspaceWindowDndTestContext } from './workspace-window-dnd-test-context.js';
	import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

	interface SidebarHostProps {
		executors?: readonly ExecutorSnapshot[];
		chats?: ChatSessionRecord[];
		chatSessions?: ChatSessionsStore;
		isMobile?: boolean;
		notifications?: unknown;
		selectedChatId?: string | null;
		sidebarSearch?: SidebarSearchStore;
		autoLoadSavedSearches?: boolean;
		sidebarGroupingFields?: SidebarGroupingSelection[];
		sidebarNestDelegatedChats?: boolean;
		sidebarInactivityDuration?: SidebarInactivityDuration;
		sidebarGroupNestedProjectPaths?: boolean;
		sidebarChatItemLayout?: ChatItemLayout;
		sidebarShowProjectPath?: boolean;
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
		onNewProjectChat?: (project: NewChatProjectTarget) => void;
	}

	let {
		executors,
		chats = [],
		chatSessions,
		isMobile = false,
		notifications,
		selectedChatId = null,
		sidebarSearch,
		autoLoadSavedSearches = true,
		sidebarGroupingFields = [{ field: 'project', enabled: true }],
		sidebarNestDelegatedChats = false,
		sidebarInactivityDuration = '3-days',
		sidebarGroupNestedProjectPaths = false,
		sidebarChatItemLayout = 'detailed',
		sidebarShowProjectPath = false,
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
		onNewProjectChat = () => {},
	}: SidebarHostProps = $props();
	let displayOpen = $state(false);
	let displayedChats = $derived(chatSessions?.orderedChats ?? chats);
	untrack(() => setExecutorsTestContext(executors ?? [localExecutor]));

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
		...TYPOGRAPHY_DEFAULTS,
		sidebarWidth: 320,
		get sidebarNestDelegatedChats() {
			return sidebarNestDelegatedChats;
		},
		setSidebarDisplay(
			value: Pick<
				import('$lib/stores/local-settings.svelte').LocalSettingsSnapshot,
				| 'sidebarGroupingFields'
				| 'sidebarInactivityDuration'
				| 'sidebarGroupNestedProjectPaths'
				| 'sidebarChatItemLayout'
				| 'sidebarShowProjectPath'
			>,
		) {
			sidebarGroupingFields = value.sidebarGroupingFields;
			sidebarInactivityDuration = value.sidebarInactivityDuration;
			sidebarGroupNestedProjectPaths = value.sidebarGroupNestedProjectPaths;
			sidebarChatItemLayout = value.sidebarChatItemLayout;
			sidebarShowProjectPath = value.sidebarShowProjectPath;
		},
		get sidebarGroupingFields() {
			return normalizeSidebarGroupingFields(sidebarGroupingFields);
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
		toggle(key: 'sidebarGroupNestedProjectPaths' | 'sidebarShowProjectPath') {
			if (key === 'sidebarShowProjectPath') sidebarShowProjectPath = !sidebarShowProjectPath;
			else sidebarGroupNestedProjectPaths = !sidebarGroupNestedProjectPaths;
		},
		set(
			key:
				| 'sidebarGroupingFields'
				| 'sidebarChatItemLayout'
				| 'sidebarSortMode'
				| 'sidebarSearchResultSort'
				| 'chatListAutohide'
				| 'chatListDock',
			value: string | boolean | SidebarGroupingSelection[],
		) {
			if (key === 'sidebarGroupingFields') {
				sidebarGroupingFields = value as SidebarGroupingSelection[];
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
		pruneToRoster() {},
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
	const projectionInput = $derived({
		allChats: displayedChats,
		matchingChatIds: sidebarSearchContext.isFiltered
			? new Set(sidebarSearchContext.filteredChats.map((chat) => chat.id))
			: undefined,
		groupingFields: sidebarGroupingFields,
		nestDelegatedChats: sidebarNestDelegatedChats,
		currentTime: new Date('2025-01-02T00:00:00.000Z'),
		inactivityDuration: sidebarInactivityDuration,
		sortMode: sidebarSortMode,
		pinnedInsertPosition: 'top' as const,
		groupNestedProjectPaths: sidebarGroupNestedProjectPaths,
		collapsedProjectKeys,
		isChatOptimisticallyArchived: (chatId: string) =>
			chatSessions?.isChatOptimisticallyArchived(chatId) ?? false,
	});
	const reorder = new SidebarOrderController({
		get input() {
			return projectionInput;
		},
		write: (request) => api.reorderChat(request),
		refresh: async () => {
			await onQuietRefresh();
			return true;
		},
		sort: (sortKey) => api.sortChatOrder({ sortKey }),
		onError: () =>
			(getNotificationsContext() as { error: (message: string) => void }).error(
				'Failed to reorder chats.',
			),
	});
</script>

<Sidebar
	{reorder}
	onShowDisplay={() => (displayOpen = true)}
	projection={reorder.projection}
	chats={displayedChats}
	{selectedChatId}
	isLoading={false}
	{isMobile}
	{onChatSelect}
	{onNewChat}
	{onNewProjectChat}
	{onQuietRefresh}
	onRequestDeleteChat={() => {}}
	onRequestRenameChat={() => {}}
	onTogglePinned={() => {}}
	onToggleArchive={() => {}}
	isArchiveMutationPending={(chatId) => chatSessions?.isArchiveMutationPending(chatId) ?? false}
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
	onShowSnippets={() => {}}
	onShowUsage={() => {}}
	onShowSettings={() => {}}
	newWindowEdges={workspaceSplitAdmissions()}
/>

<SidebarSearchDialogs
	chats={displayedChats}
	onSelectResult={({ chatId }) => onChatSelect(chatId)}
/>

{#if displayOpen}<SidebarDisplayDialog onClose={() => (displayOpen = false)} />{/if}
