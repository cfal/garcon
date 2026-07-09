<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { gotoChat } from '$lib/chat/chat-navigation';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from './BottomTabBar.svelte';
	import WorkspaceView from './WorkspaceView.svelte';
	import NotificationHost from '$lib/components/shared/NotificationHost.svelte';
	import type { AppTab } from '$lib/types/app';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	const lazySettings = () => import('../settings/Settings.svelte');
	import {
		getNavigation,
		getChatSessions,
		getAppShell,
		getWs,
		getLocalSettings,
			getNotifications,
			getSidebarSearch,
			getSidebarProjectCollapse,
			getGhCapability,
		} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { WsConnectionNotificationPresenter } from '$lib/ws/connection-notifications';
	import { restoreChatIdForBareRoute, selectedChatIdFromRoute } from './app-shell-route';
	import { resolveAdjacentChatId } from './app-shell-chat-navigation';
	import NewChatDialog from '../chat/NewChatDialog.svelte';
	import FileViewerHost from '../files/FileViewerHost.svelte';
	import { computeMobileViewportMetrics } from './mobile-viewport';
	import { ChatActionController } from '$lib/components/chat/chat-action-controller.svelte';
	import { ChatActionDialogsState } from '$lib/components/chat/chat-action-dialogs-state.svelte';
	import ChatActionDialogs from '$lib/components/chat/ChatActionDialogs.svelte';
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import SidebarTagDialog from '$lib/components/sidebar/SidebarTagDialog.svelte';
	import { buildSidebarDisplayChatIds } from '$lib/components/sidebar/sidebar-row-model';

	const navigation = getNavigation();
	const sessions = getChatSessions();
	const appShell = getAppShell();
	const ws = getWs();
	const localSettings = getLocalSettings();
		const notifications = getNotifications();
		const sidebarSearch = getSidebarSearch();
		const projectCollapse = getSidebarProjectCollapse();
		const ghCapability = getGhCapability();
	const wsConnectionNotifications = new WsConnectionNotificationPresenter({
		notifications,
	});
	const chatActionDialogs = new ChatActionDialogsState();
	const chatActionController = new ChatActionController({
		get chats() {
			return sessions.orderedChats;
		},
		get selectedChatId() {
			return sessions.selectedChatId;
		},
		onQuietRefresh: quietRefresh,
		onSelectChat: handleChatSelect,
		onNewChat: handleNewChat,
		onDeleteChat: handleChatDelete,
		onRenameChat: handleChatRenamed,
		onProjectPathUpdated: handleChatProjectPathUpdated,
		onReloadChat: handleReloadChat,
		notifyError(message) {
			notifications.error(message);
		},
		requestComposerFocus() {
			appShell.requestComposerFocus();
		},
		requestSidebarRecenter() {
			appShell.requestSidebarRecenterToSelected();
		},
	});

	let isMobile = $state(false);
	let isWorkspaceFullscreen = $state(false);
	let mobileAppHeight = $state<number | null>(null);
	let mobileViewportBaselineHeight = $state<number | null>(null);
	let mobileKeyboardVisible = $state(false);
	let reloadSelectedChatFn = $state<((chatId: string) => Promise<void>) | null>(null);
	const isAutoFullscreenOnGitTab = $derived(
		!isMobile && navigation.activeTab === 'git' && localSettings.alwaysFullscreenOnGitPanel,
	);
	const effectiveWorkspaceFullscreen = $derived(isWorkspaceFullscreen || isAutoFullscreenOnGitTab);
	const notificationDesktopLeftPx = $derived(
		effectiveWorkspaceFullscreen ? 16 : localSettings.sidebarWidth + 16,
	);
	const sidebarMounted = $derived(!isMobile || appShell.sidebarOpen);
	const displayedSidebarChatIds = $derived.by(() =>
		buildSidebarDisplayChatIds({
			displayedChats: sidebarSearch.filteredChats,
			groupByProject: localSettings.sidebarGroupByProject,
			groupNestedProjectPaths: localSettings.sidebarGroupNestedProjectPaths,
			collapsedProjectKeys: projectCollapse.collapsedProjectKeys,
		}),
	);

	// Syncs URL params to selected chat ID. The session store is the
	// single source of truth; this effect keeps it in sync with the URL.
	$effect(() => {
		const chatId = page.params.id as string | undefined;
		const selectedChatId = selectedChatIdFromRoute(page.url.pathname, chatId);
		if (selectedChatId === undefined) return;
		const changed = untrack(() => selectedChatId !== sessions.selectedChatId);
		sessions.setSelectedChatId(selectedChatId);
		if (changed && selectedChatId) appShell.requestComposerFocus();
	});

	$effect(() => {
		const target = restoreChatIdForBareRoute({
			pathname: page.url.pathname,
			routeChatId: page.params.id as string | undefined,
			isLoadingChats: sessions.isLoadingChats,
			lastSelectedChatId: sessions.lastSelectedChatId,
			selectedChatId: sessions.selectedChatId,
		});
		if (!target) return;
		untrack(() => {
			sessions.setSelectedChatId(target);
			void gotoChat(target);
		});
	});

	$effect(() => {
		const selected = sessions.selectedChat;
		if (!selected || selected.status === 'draft') return;
		const chatId = selected.id;
		untrack(() => sessions.rememberSelectedChat(chatId));
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mql = window.matchMedia('(max-width: 768px)');
		isMobile = mql.matches;
		appShell.isMobile = mql.matches;

		function onChange(e: MediaQueryListEvent) {
			isMobile = e.matches;
			appShell.isMobile = e.matches;
			if (!e.matches) appShell.setSidebarOpen(false);
		}

		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	});

	// Tracks virtual keyboard height via visualViewport for mobile layout.
	$effect(() => {
		if (typeof window === 'undefined' || !window.visualViewport) return;
		const vv = window.visualViewport;
		let frameId: number | null = null;

		function applyViewportMetrics() {
			frameId = null;
			const metrics = computeMobileViewportMetrics({
				visualViewportHeight: vv.height,
				visualViewportOffsetTop: vv.offsetTop,
				windowInnerHeight: window.innerHeight,
				baselineAppHeight: mobileViewportBaselineHeight,
				previousAppHeight: mobileAppHeight,
			});
			mobileAppHeight = metrics.appHeight;
			mobileKeyboardVisible = metrics.keyboardVisible;
			if (!metrics.keyboardVisible) {
				mobileViewportBaselineHeight = metrics.appHeight;
			}
			appShell.keyboardHeight = metrics.keyboardHeight;
			document.documentElement.style.setProperty('--app-height', `${metrics.appHeight}px`);
			document.documentElement.style.setProperty(
				'--app-viewport-offset-top',
				`${metrics.viewportOffsetTop}px`,
			);
			document.documentElement.style.setProperty(
				'--app-viewport-center-y',
				`${metrics.viewportCenterY}px`,
			);
		}

		function scheduleViewportMetrics() {
			if (frameId !== null) return;
			frameId = requestAnimationFrame(applyViewportMetrics);
		}

		scheduleViewportMetrics();
		vv.addEventListener('resize', scheduleViewportMetrics);
		vv.addEventListener('scroll', scheduleViewportMetrics);
		return () => {
			if (frameId !== null) cancelAnimationFrame(frameId);
			vv.removeEventListener('resize', scheduleViewportMetrics);
			vv.removeEventListener('scroll', scheduleViewportMetrics);
		};
	});

	function quietRefresh() {
		return sessions.quietRefreshChats();
	}

	// Fetches chat list + processing state whenever the WS connects
	// (initial page load and reconnect).
	$effect(() => {
		if (!ws.isConnected) return;
		sessions.refreshChatsAndReconcileProcessing().catch((error) => {
			console.warn(
				'app-shell: failed to reconcile running chats:',
				error instanceof Error ? error.message : String(error),
			);
		});
	});

		$effect(() => {
			const status = ws.connectionStatus;
			return untrack(() => wsConnectionNotifications.observe(status));
		});

		// Recovers stale or programmatic navigation into a gated PR workspace.
		$effect(() => {
			if (ghCapability.available || navigation.activeTab !== 'pull-requests') return;
			untrack(() => {
				navigation.setActiveTab('chat');
			});
		});

	onMount(() => {
		// Starts the first chat-list refresh early so the sidebar populates even
		// before the WS connection opens.
		void sessions.refreshChats();
	});

	function requestComposerFocusAfterNavigation(navigation: Promise<void>): void {
		void navigation.finally(() => appShell.requestComposerFocus());
	}

	function navigateToChat(chatId: string): void {
		sessions.setSelectedChatId(chatId);
		requestComposerFocusAfterNavigation(gotoChat(chatId));
	}

	function handleChatSelect(chatId: string) {
		navigateToChat(chatId);
	}

	function handleNewChat() {
		if (isMobile) {
			appShell.setSidebarOpen(false);
		}
		appShell.openNewChatDialog();
	}

	// Navigates to the chat above or below the currently selected one.
	// No-op when no chat is selected or at the list boundary.
	function navigateChatAdjacent(offset: -1 | 1) {
		const targetId = resolveAdjacentChatId({
			selectedChatId: sessions.selectedChatId,
			displayedChatIds: sidebarMounted ? displayedSidebarChatIds : null,
			fallbackOrder: sessions.order,
			offset,
		});
		if (!targetId) return;
		navigateToChat(targetId);
	}

	// Applies the same store mutations the ChatSessionDeletedWsMessage handler
	// would apply once the server broadcast arrives. Running it eagerly lets
	// the sidebar and URL update without waiting for the HTTP round-trip.
	function locallyDeleteChat(chatId: string) {
		if (!sessions.hasChat(chatId)) return;
		if (sessions.selectedChatId === chatId) {
			const idx = sessions.order.indexOf(chatId);
			const neighborId = sessions.order[idx - 1] ?? sessions.order[idx + 1] ?? null;
			if (neighborId) {
				navigateToChat(neighborId);
			} else {
				sessions.setSelectedChatId(null);
				goto('/');
			}
		}
		sessions.removeChat(chatId);
	}

	function handleChatDelete(chatId: string) {
		locallyDeleteChat(chatId);
		return sessions.deleteRemoteChat(chatId);
	}

	function handleChatRenamed(chatId: string, newTitle: string) {
		return sessions.renameChat(chatId, newTitle);
	}

	function handleRegisterReload(fn: (chatId: string) => Promise<void>): void {
		reloadSelectedChatFn = fn;
	}

	async function handleReloadChat(chatId: string): Promise<void> {
		if (!reloadSelectedChatFn) {
			throw new Error(m.sidebar_chats_reload_failed());
		}
		await reloadSelectedChatFn(chatId);
		await quietRefresh();
	}

	function handleTabChange(tab: AppTab) {
		navigation.setActiveTab(tab);
	}

	function toggleMobileSidebar() {
		appShell.setSidebarOpen(!appShell.sidebarOpen);
	}

	function closeMobileSidebar() {
		appShell.setSidebarOpen(false);
	}

	function handleChatProjectPathUpdated(chatId: string, projectPath: string): void {
		sessions.patchChat(chatId, { projectPath });
	}

	function fallbackChatTitle(chat: ChatSessionRecord): string {
		return chat.title || m.sidebar_chats_new_chat();
	}

	function requestDeleteChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDelete(chat, m.sidebar_chats_new_chat());
	}

	function requestDeleteChatById(
		chatId: string,
		chatTitle: string,
		agentId: ChatSessionRecord['agentId'],
	): void {
		chatActionDialogs.showDeleteConfirmation(chatId, chatTitle, agentId);
	}

	function requestRenameChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestRename(chat, m.sidebar_chats_new_chat());
	}

	function requestRenameChatById(chatId: string, currentName: string): void {
		chatActionDialogs.startRename(chatId, currentName);
	}

	function requestDetailsChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDetails(chat, m.sidebar_chats_new_chat());
		void chatActionController.loadDetails(chat.id, chatActionDialogs);
	}

	function requestDetailsChatById(chatId: string, chatTitle: string): void {
		chatActionDialogs.showDetails(chatId, chatTitle);
		void chatActionController.loadDetails(chatId, chatActionDialogs);
	}

	function requestShareChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestShare(chat, m.sidebar_chats_new_chat());
	}

	function requestShareChatById(chatId: string, chatTitle: string): void {
		chatActionDialogs.showShareDialog(chatId, chatTitle);
	}

	function requestProjectPathChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestProjectPath(chat, m.sidebar_chats_new_chat());
	}

	function requestTagsById(chatId: string, currentTags: string[]): void {
		const chat = sessions.byId[chatId];
		chatActionDialogs.showTagDialog(
			chatId,
			chat ? fallbackChatTitle(chat) : m.sidebar_chats_unnamed(),
			currentTags,
		);
	}

	async function confirmChatTags(chatId: string, tags: string[]): Promise<void> {
		await chatActionController.updateTags(chatId, tags);
		chatActionDialogs.closeTagDialog();
	}

	const workspaceChatActions = {
		requestDelete: requestDeleteChat,
		requestRename: requestRenameChat,
		requestDetails: requestDetailsChat,
		requestShare: requestShareChat,
		requestProjectPath: requestProjectPathChat,
		fork(chat: ChatSessionRecord): void {
			void chatActionController.forkChat(chat.id);
		},
		reload(chat: ChatSessionRecord): void {
			void chatActionController.reloadChat(chat.id);
		},
	};

	onMount(() => {
		const unsubscribers = [
			appShell.onNewChatRequested(() => handleNewChat()),
			appShell.onRenameSelectedChatRequested(() => {
				const selected = sessions.selectedChat;
				if (selected) requestRenameChat(selected);
			}),
			appShell.onDeleteSelectedChatRequested(() => {
				const selected = sessions.selectedChat;
				if (selected) requestDeleteChat(selected);
			}),
			navigation.onNavigateChatAboveRequested(() => navigateChatAdjacent(-1)),
			navigation.onNavigateChatBelowRequested(() => navigateChatAdjacent(1)),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	});
</script>

{#if !isMobile}
	<div class="flex h-dvh w-screen overflow-hidden bg-background text-foreground">
		<div
			class={`relative h-full overflow-hidden ${effectiveWorkspaceFullscreen ? 'w-0 border-r-0 pointer-events-none' : 'flex-shrink-0 border-r border-border'}`}
			style:width={effectiveWorkspaceFullscreen ? '0px' : `${localSettings.sidebarWidth}px`}
			aria-hidden={effectiveWorkspaceFullscreen}
			inert={effectiveWorkspaceFullscreen}
		>
			<Sidebar
				chats={sessions.orderedChats}
				selectedChatId={sessions.selectedChatId}
				isLoading={sessions.isLoadingChats}
				isMobile={false}
				onChatSelect={handleChatSelect}
				onNewChat={handleNewChat}
				onLocallyDeleteChat={locallyDeleteChat}
				onQuietRefresh={quietRefresh}
				onRequestDeleteChat={requestDeleteChatById}
				onRequestRenameChat={requestRenameChatById}
				onTogglePinned={(id) => chatActionController.togglePinned(id)}
				onToggleArchive={(id) => chatActionController.toggleArchive(id)}
				onShowDetails={requestDetailsChatById}
				onForkChat={(id) => chatActionController.forkChat(id)}
				onShareChat={requestShareChatById}
				onManageTags={requestTagsById}
				onShowSettings={() => appShell.openSettings()}
			/>
			{#if !effectiveWorkspaceFullscreen}
				<ResizeHandle
					width={localSettings.sidebarWidth}
					onResize={(w) => localSettings.set('sidebarWidth', w)}
				/>
			{/if}
		</div>

		<div class="flex-1 min-w-0 h-full overflow-hidden">
			<WorkspaceView
				activeTab={navigation.activeTab}
				onTabChange={handleTabChange}
				isDesktopFullscreen={effectiveWorkspaceFullscreen}
				onToggleDesktopFullscreen={() => (isWorkspaceFullscreen = !isWorkspaceFullscreen)}
				onRegisterReload={handleRegisterReload}
				chatActions={workspaceChatActions}
			/>
		</div>
	</div>
{:else}
	<div class="mobile-shell flex flex-col w-screen overflow-hidden bg-background text-foreground">
		{#if appShell.sidebarOpen}
			<div class="fixed inset-0 z-40">
				<button
					class="absolute inset-0 bg-black/50 backdrop-blur-sm"
					onclick={closeMobileSidebar}
					aria-label={m.layout_close_sidebar()}
				></button>
				<div class="absolute inset-y-0 left-0 w-[85%] max-w-sm bg-card shadow-2xl z-50">
					<Sidebar
						chats={sessions.orderedChats}
						selectedChatId={sessions.selectedChatId}
						isLoading={sessions.isLoadingChats}
						isMobile={true}
						onChatSelect={(chatId) => {
							handleChatSelect(chatId);
							closeMobileSidebar();
						}}
						onNewChat={handleNewChat}
						onLocallyDeleteChat={locallyDeleteChat}
						onQuietRefresh={quietRefresh}
						onRequestDeleteChat={requestDeleteChatById}
						onRequestRenameChat={requestRenameChatById}
						onTogglePinned={(id) => chatActionController.togglePinned(id)}
						onToggleArchive={(id) => chatActionController.toggleArchive(id)}
						onShowDetails={requestDetailsChatById}
						onForkChat={(id) => chatActionController.forkChat(id)}
						onShareChat={requestShareChatById}
						onManageTags={requestTagsById}
						onShowSettings={() => appShell.openSettings()}
					/>
				</div>
			</div>
		{/if}

		<div class="flex-1 min-h-0 overflow-hidden">
			<WorkspaceView
				activeTab={navigation.activeTab}
				onTabChange={handleTabChange}
				onMenuClick={toggleMobileSidebar}
				onRegisterReload={handleRegisterReload}
				chatActions={workspaceChatActions}
			/>
		</div>

		{#if !mobileKeyboardVisible}
				<BottomTabBar
					activeTab={navigation.activeTab}
					pullRequestsAvailable={ghCapability.available}
					onTabChange={handleTabChange}
					onMenuClick={toggleMobileSidebar}
				/>
		{/if}
	</div>
{/if}

<ChatActionDialogs
	chatDeleteConfirmation={chatActionDialogs.chatDeleteConfirmation}
	onCancelDelete={() => chatActionDialogs.clearDeleteConfirmation()}
	onConfirmDelete={() => {
		void chatActionController.confirmDelete(chatActionDialogs);
	}}
	chatRenameConfirmation={chatActionDialogs.chatRenameConfirmation}
	onCancelRename={() => chatActionDialogs.clearRename()}
	onConfirmRename={(newName) => {
		void chatActionController.confirmRename(chatActionDialogs, newName);
	}}
	chatDetailsDialog={chatActionDialogs.chatDetailsDialog}
	onCloseDetails={() => chatActionDialogs.closeDetails()}
/>

<ChatProjectPathDialog
	projectPathDialog={chatActionDialogs.chatProjectPathDialog}
	projectBasePath={appShell.projectBasePath}
	{isMobile}
	onClose={() => chatActionDialogs.closeProjectPathDialog()}
	onConfirm={(chatId, projectPath) => chatActionController.updateProjectPath(chatId, projectPath)}
/>

<SidebarTagDialog
	tagDialog={chatActionDialogs.tagDialog}
	allKnownTags={sidebarSearch.allKnownTags}
	onClose={() => chatActionDialogs.closeTagDialog()}
	onSave={confirmChatTags}
/>

<ShareChatDialog
	chatId={chatActionDialogs.shareChatDialog?.chatId ?? null}
	chatTitle={chatActionDialogs.shareChatDialog?.chatTitle ?? ''}
	onClose={() => chatActionDialogs.closeShareDialog()}
/>

<NewChatDialog />
<FileViewerHost />
<NotificationHost {notifications} desktopLeftPx={notificationDesktopLeftPx} />

{#if appShell.showSettings}
	{#await lazySettings() then { default: Settings }}
		<Settings />
	{/await}
{/if}
