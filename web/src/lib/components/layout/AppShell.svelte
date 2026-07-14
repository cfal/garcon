<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { gotoChat } from '$lib/chat/chat-navigation';
	import Sidebar from '../sidebar/Sidebar.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import BottomTabBar from './BottomTabBar.svelte';
	import WorkspaceRoot from '$lib/components/workspace/WorkspaceRoot.svelte';
	import NotificationHost from '$lib/components/shared/NotificationHost.svelte';
	import type { MobileWorkspaceTabId } from './mobile-workspace-tabs';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	const lazySettings = () => import('../settings/Settings.svelte');
	const lazyScheduledPrompts = () => import('../settings/ScheduledPromptsDialog.svelte');
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
		getWorkspaceCoordinator,
	} from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { WsConnectionNotificationPresenter } from '$lib/ws/connection-notifications';
	import { restoreChatIdForBareRoute, selectedChatIdFromRoute } from './app-shell-route';
	import { resolveAdjacentChatId } from './app-shell-chat-navigation';
	import NewChatDialog from '../chat/NewChatDialog.svelte';
	import FileDialogHost from '../files/FileDialogHost.svelte';
	import FileDirtyUnloadGuard from '../files/FileDirtyUnloadGuard.svelte';
	import WorkspaceCloseGuard from '$lib/components/workspace/WorkspaceCloseGuard.svelte';
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
	const workspace = getWorkspaceCoordinator();
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
		onUpsertServerChat: (entry) => sessions.upsertServerChat(entry),
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

	let isMobile = $derived(workspace.isMobile);
	let workspaceOverlayOpen = $state(false);
	let mobileAppHeight = $state<number | null>(null);
	let mobileViewportBaselineHeight = $state<number | null>(null);
	let mobileKeyboardVisible = $state(false);
	let reloadSelectedChatFn = $state<((chatId: string) => Promise<void>) | null>(null);
	const effectiveWorkspaceFullscreen = $derived(
		!isMobile && workspace.layout.snapshot.manualFullscreen,
	);
	const hideLeftForGit = $derived(
		!isMobile &&
			localSettings.hideChatListWhenGitInMain &&
			workspace.layout.activeMainKind === 'git',
	);
	const hideLeftSidebar = $derived(effectiveWorkspaceFullscreen || hideLeftForGit);
	const mobileActiveDescriptor = $derived(
		workspace.layout.surface(workspace.layout.snapshot.mobileActiveSurfaceId),
	);
	const mobileActiveTab = $derived.by<MobileWorkspaceTabId>(() => {
		const surface = mobileActiveDescriptor;
		if (surface?.type === 'terminal' || surface?.type === 'terminal-launcher') return 'terminal';
		if (surface?.type === 'singleton') {
			if (surface.kind === 'pull-requests') return 'pull-requests';
			if (surface.kind === 'git' || surface.kind === 'files' || surface.kind === 'chat') {
				return surface.kind;
			}
		}
		return 'chat';
	});
	const mobileTransientSurface = $derived(
		mobileActiveDescriptor?.type === 'file' ||
			(mobileActiveDescriptor?.type === 'singleton' && mobileActiveDescriptor.kind === 'commit'),
	);
	const notificationDesktopLeftPx = $derived(
		hideLeftSidebar ? 16 : localSettings.sidebarWidth + 16,
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
		if (mql.matches) void workspace.enterMobilePresentation();
		else void workspace.exitMobilePresentation();

		function onChange(e: MediaQueryListEvent) {
			if (e.matches) void workspace.enterMobilePresentation();
			else void workspace.exitMobilePresentation();
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

	onMount(() => {
		// Starts the first chat-list refresh early so the sidebar populates even
		// before the WS connection opens.
		void sessions.refreshChats();
	});

	function requestComposerFocusAfterNavigation(navigation: Promise<void>): void {
		void navigation.finally(() => appShell.requestComposerFocus());
	}

	function selectAndNavigateChat(chatId: string): void {
		sessions.setSelectedChatId(chatId);
		requestComposerFocusAfterNavigation(gotoChat(chatId));
	}

	function handleChatSelect(chatId: string) {
		selectAndNavigateChat(chatId);
		void workspace.focusChat();
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
		selectAndNavigateChat(targetId);
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
				selectAndNavigateChat(neighborId);
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

	async function handleChatRenamed(chatId: string, newTitle: string): Promise<void> {
		await sessions.renameChat(chatId, newTitle);
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

	function handleMobileTabChange(tab: MobileWorkspaceTabId) {
		if (tab === 'chat') {
			void workspace.focusChat();
			return;
		}
		if (tab === 'git') {
			void workspace.focusMobileSingleton('git');
			return;
		}
		if (tab === 'pull-requests') {
			void workspace.focusMobileSingleton('pull-requests');
			return;
		}
		if (tab === 'files') {
			void workspace.focusMobileSingleton('files');
			return;
		}
		void workspace.focusMostRecentTerminalOrCreate('main').catch((error) => {
			notifications.error(error instanceof Error ? error.message : m.terminal_create_failed());
		});
	}

	function toggleMobileSidebar() {
		appShell.setSidebarOpen(!appShell.sidebarOpen);
	}

	function closeMobileSidebar() {
		appShell.setSidebarOpen(false);
	}

	function handleMobileChatSelect(chatId: string): void {
		handleChatSelect(chatId);
		closeMobileSidebar();
	}

	function handleChatProjectPathUpdated(
		chatId: string,
		patch: { projectPath: string; effectiveProjectKey: string },
	): void {
		sessions.patchChat(chatId, patch);
	}

	function requestDeleteChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDelete(chat, m.sidebar_chats_new_chat());
	}

	function requestRenameChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestRename(chat, m.sidebar_chats_new_chat());
	}

	function requestDetailsChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestDetails(chat, m.sidebar_chats_new_chat());
		void chatActionController.loadDetails(chat.id, chatActionDialogs);
	}

	function requestShareChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestShare(chat, m.sidebar_chats_new_chat());
	}

	function requestProjectPathChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestProjectPath(chat, m.sidebar_chats_new_chat());
	}

	function requestTagsChat(chat: ChatSessionRecord): void {
		chatActionDialogs.requestTags(chat, m.sidebar_chats_new_chat());
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

{#snippet sidebarContent(isMobile: boolean, onChatSelect: (chatId: string) => void)}
	<Sidebar
		chats={sessions.orderedChats}
		selectedChatId={sessions.selectedChatId}
		isLoading={sessions.isLoadingChats}
		{isMobile}
		{onChatSelect}
		onNewChat={handleNewChat}
		onLocallyDeleteChat={locallyDeleteChat}
		onQuietRefresh={quietRefresh}
		onRequestDeleteChat={requestDeleteChat}
		onRequestRenameChat={requestRenameChat}
		onTogglePinned={(id) => chatActionController.togglePinned(id)}
		onToggleArchive={(id) => chatActionController.toggleArchive(id)}
		onShowDetails={requestDetailsChat}
		onForkChat={(id) => chatActionController.forkChat(id)}
		onShareChat={requestShareChat}
		onManageTags={requestTagsChat}
		onShowScheduledPrompts={() => appShell.openScheduledPrompts()}
		onShowSettings={() => appShell.openSettings()}
	/>
{/snippet}

<div
	class="flex w-screen overflow-hidden bg-background text-foreground"
	class:mobile-shell={isMobile}
	class:h-dvh={!isMobile}
	class:flex-col={isMobile}
>
	{#if !isMobile}
		<div
			data-workspace-chat-list
			onfocusin={() => workspace.noteChatListFocus()}
			onpointerdown={() => workspace.noteChatListFocus()}
			class={`relative h-full overflow-hidden ${hideLeftSidebar ? 'w-0 border-r-0 pointer-events-none' : 'flex-shrink-0 border-r border-border'} ${workspaceOverlayOpen ? 'pointer-events-none' : ''}`}
			style:width={hideLeftSidebar ? '0px' : `${localSettings.sidebarWidth}px`}
			aria-hidden={hideLeftSidebar || workspaceOverlayOpen}
			inert={hideLeftSidebar || workspaceOverlayOpen}
		>
			{@render sidebarContent(false, handleChatSelect)}
			{#if !hideLeftSidebar}
				<ResizeHandle
					width={localSettings.sidebarWidth}
					onResize={(width) => localSettings.set('sidebarWidth', width)}
				/>
			{/if}
		</div>
	{/if}

	{#if isMobile && appShell.sidebarOpen}
		<div class="fixed inset-0 z-40">
			<button
				class="absolute inset-0 bg-foreground/40"
				onclick={closeMobileSidebar}
				aria-label={m.layout_close_sidebar()}
			></button>
			<div
				data-workspace-chat-list
				role="navigation"
				aria-label={m.layout_chat_list()}
				class="absolute inset-y-0 left-0 z-50 w-[85%] max-w-sm bg-card shadow-2xl"
				onfocusin={() => workspace.noteChatListFocus()}
				onpointerdown={() => workspace.noteChatListFocus()}
			>
				{@render sidebarContent(true, handleMobileChatSelect)}
			</div>
		</div>
	{/if}

	<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
		<div class="min-h-0 flex-1 overflow-hidden">
			<WorkspaceRoot
				{isMobile}
				onMenuClick={isMobile ? toggleMobileSidebar : undefined}
				isDesktopFullscreen={effectiveWorkspaceFullscreen}
				onToggleDesktopFullscreen={() =>
					void workspace.setManualFullscreen(!effectiveWorkspaceFullscreen)}
				onRegisterReload={handleRegisterReload}
				onOverlayModalChange={(open) => (workspaceOverlayOpen = open)}
				chatActions={workspaceChatActions}
			/>
		</div>
		{#if isMobile && !mobileKeyboardVisible && !mobileTransientSurface}
			<BottomTabBar
				activeItem={mobileActiveTab}
				pullRequestsAvailable={ghCapability.available}
				onTabChange={handleMobileTabChange}
				onMenuClick={toggleMobileSidebar}
			/>
		{/if}
	</div>
</div>

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
<FileDialogHost />
<FileDirtyUnloadGuard />
<WorkspaceCloseGuard />
<NotificationHost {notifications} desktopLeftPx={notificationDesktopLeftPx} />

{#if appShell.showSettings}
	{#await lazySettings() then { default: Settings }}
		<Settings />
	{/await}
{/if}

{#if appShell.showScheduledPrompts}
	{#await lazyScheduledPrompts() then { default: ScheduledPromptsDialog }}
		<ScheduledPromptsDialog />
	{/await}
{/if}
